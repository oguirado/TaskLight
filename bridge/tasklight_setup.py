"""U82 TaskLight setup CLI for AI assistants."""
import base64
import binascii
import datetime
import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

if __name__ == "__main__" and not __package__:
    _here = os.path.dirname(os.path.abspath(__file__))
    _repo_root = os.path.dirname(_here)
    sys.path[:] = [path for path in sys.path if path != _repo_root]
    sys.path.insert(0, _repo_root)

VERBS = ("extension-id", "build-extension", "mcp-config", "doctor", "wall")
CLIENTS = ("claude-desktop", "claude-code", "codex", "gemini", "vscode", "cursor")
BROWSERS = ("chrome", "chromium", "edge", "brave")
HOST_NAME = "com.contextwall.bridge"
_LINUX_SUBDIRS = {
    "chrome": "google-chrome",
    "chromium": "chromium",
    "edge": "microsoft-edge",
    "brave": "BraveSoftware/Brave-Browser",
}
_DARWIN_SUBDIRS = {
    "chrome": "Google/Chrome",
    "chromium": "Chromium",
    "edge": "Microsoft Edge",
    "brave": "BraveSoftware/Brave-Browser",
}
_BROWSER_BINS = {
    "chrome": ("google-chrome", "google-chrome-stable", "chrome"),
    "chromium": ("chromium", "chromium-browser"),
    "edge": ("microsoft-edge", "microsoft-edge-stable", "edge"),
    "brave": ("brave-browser", "brave", "brave-stable"),
}


def _repo_root():
    return Path(__file__).resolve().parent.parent


def _cw_home():
    cw = os.environ.get("CW_HOME")
    if cw:
        return Path(cw)
    return Path.home() / ".context-wall"


def _mcp_path_str():
    return str(_repo_root() / "bridge" / "room" / "mcp.py")


def _emit(payload, code):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()
    return code


def _usage(detail="usage"):
    return _emit({"ok": False, "error": "usage", "detail": detail}, 2)


def _derive_id(key):
    if not isinstance(key, str):
        return None
    compact = "".join(key.split())
    if not compact:
        return None
    try:
        der = base64.b64decode(compact, validate=True)
    except (binascii.Error, ValueError):
        return None
    def tlv(offset, limit, tag=None):
        if offset + 2 > limit:
            raise ValueError("truncated DER")
        actual = der[offset]
        if tag is not None and actual != tag:
            raise ValueError("unexpected DER tag")
        length = der[offset + 1]
        start = offset + 2
        if length & 128:
            count = length & 127
            if not count or start + count > limit or der[start] == 0:
                raise ValueError("invalid DER length")
            length = int.from_bytes(der[start:start + count], "big")
            start += count
            if length < 128:
                raise ValueError("nonminimal DER length")
        end = start + length
        if end > limit:
            raise ValueError("truncated DER value")
        return start, end

    try:
        outer, end = tlv(0, len(der), 0x30)
        if end != len(der):
            return None
        algorithm, algorithm_end = tlv(outer, end, 0x30)
        oid, oid_end = tlv(algorithm, algorithm_end, 0x06)
        if oid == oid_end or der[oid_end - 1] & 128:
            return None
        # DER base-128 OID subidentifiers must use minimal encodings.
        boundary = True
        for octet in der[oid:oid_end]:
            if boundary and octet == 128:
                return None
            boundary = not (octet & 128)
        if oid_end < algorithm_end:
            _, parameters_end = tlv(oid_end, algorithm_end)
            if parameters_end != algorithm_end:
                return None
        bits, bits_end = tlv(algorithm_end, end, 0x03)
        if bits_end != end or bits + 1 >= bits_end or der[bits] > 7:
            return None
        unused = der[bits]
        if unused and der[bits_end - 1] & ((1 << unused) - 1):
            return None
    except (ValueError, IndexError):
        return None
    digest = hashlib.sha256(der).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def _read_manifest_id(filename):
    path = _repo_root() / "extension" / filename
    try:
        text = path.read_text(encoding="utf-8")
        data = json.loads(text)
        if not isinstance(data, dict):
            return None
        return _derive_id(data.get("key"))
    except Exception:
        return None


def _dev_id():
    return _read_manifest_id("manifest.dev.json")


def _expected_entry(client):
    entry = {
        "command": sys.executable,
        "args": [_mcp_path_str()],
        "env": {"CW_HOME": str(_cw_home())},
    }
    if client == "vscode":
        entry["type"] = "stdio"
    return entry


def _target_path(client):
    home = Path.home()
    plat = sys.platform
    if client == "claude-desktop":
        if plat == "darwin":
            return home / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"
        if plat.startswith("win"):
            appdata = os.environ.get("APPDATA")
            base = Path(appdata) if appdata else home / "AppData" / "Roaming"
            return base / "Claude" / "claude_desktop_config.json"
        return home / ".config" / "Claude" / "claude_desktop_config.json"
    if client == "cursor":
        return home / ".cursor" / "mcp.json"
    if client == "gemini":
        return home / ".gemini" / "settings.json"
    if client == "vscode":
        return Path.cwd() / ".vscode" / "mcp.json"
    if client == "codex":
        return home / ".codex" / "config.toml"
    return None


def _restart_hint(client):
    return "restart " + client + " so it loads the new MCP server"


def _codex_snippet():
    cmd = sys.executable
    args = [_mcp_path_str()]
    cw = str(_cw_home())
    lines = [
        "[mcp_servers.tasklight]",
        "command = " + json.dumps(cmd),
        "args = " + json.dumps(args),
        "",
        "[mcp_servers.tasklight.env]",
        "CW_HOME = " + json.dumps(cw),
        "",
    ]
    return "\n".join(lines)


def _codex_data(text):
    try:
        import tomllib
    except ImportError:
        # On Python 3.10 accept only a proven, deliberately small subset.
        data = {}
        current = data
        declared = set()
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if re.fullmatch(r"\[[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\]", line):
                section = line[1:-1]
                if section in declared:
                    raise ValueError("codex_config_unparsed")
                declared.add(section)
                current = data
                for key in section.split("."):
                    if key in current and not isinstance(current[key], dict):
                        raise ValueError("codex_config_unparsed")
                    current = current.setdefault(key, {})
            else:
                match = re.fullmatch(r"([A-Za-z0-9_-]+)\s*=\s*(.*)", line)
                if not match or match[1] in current:
                    raise ValueError("codex_config_unparsed")
                try:
                    value = json.loads(match[2])
                except ValueError:
                    raise ValueError("codex_config_unparsed") from None
                if not (isinstance(value, (str, bool, int)) or
                        isinstance(value, list) and all(isinstance(v, str) for v in value)):
                    raise ValueError("codex_config_unparsed")
                current[match[1]] = value
        return data
    try:
        return tomllib.loads(text)
    except ValueError:
        raise ValueError("codex_config_unparsed") from None


def _parse_codex(text):
    data = _codex_data(text)
    servers = data.get("mcp_servers", {})
    if not isinstance(servers, dict):
        raise ValueError("codex_config_unparsed")
    if "tasklight" not in servers:
        return {}
    entry = servers["tasklight"]
    if not isinstance(entry, dict):
        return {"mcp_servers.tasklight": entry}
    return {"mcp_servers.tasklight": {k: v for k, v in entry.items() if k != "env"},
            "mcp_servers.tasklight.env": entry.get("env")}


def _strip_codex_tasklight(text):
    out = []
    skipping = False
    for raw in text.splitlines():
        stripped = raw.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            sect = stripped[1:-1].strip()
            skipping = sect in ("mcp_servers.tasklight", "mcp_servers.tasklight.env")
            if skipping:
                continue
            out.append(raw)
        else:
            if not skipping:
                out.append(raw)
    result = "\n".join(out)
    if result and not result.endswith("\n"):
        result += "\n"
    return result


def _stamp():
    return datetime.datetime.utcnow().strftime("%Y%m%d%H%M%S")


def _backup_if_exists(target):
    if target.exists() and target.is_file():
        backup = target.parent / (target.name + ".bak-" + _stamp())
        backup.write_bytes(target.read_bytes())


def _atomic_write(target, data_bytes):
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.parent / (target.name + ".tmp")
    tmp.write_bytes(data_bytes)
    os.replace(tmp, target)


def _do_extension_id(rest):
    manifest = "dev"
    i = 0
    while i < len(rest):
        a = rest[i]
        if a == "--json":
            i += 1
        elif a == "--manifest":
            if i + 1 >= len(rest):
                return _usage("missing --manifest value")
            manifest = rest[i + 1]
            i += 2
        elif a.startswith("--manifest="):
            manifest = a[len("--manifest="):]
            i += 1
        else:
            return _usage("unknown flag")
    if manifest not in ("dev", "prod"):
        return _usage("bad manifest")
    filename = "manifest.dev.json" if manifest == "dev" else "manifest.json"
    ext_id = _read_manifest_id(filename)
    if ext_id is None:
        return _emit({"ok": False, "error": "invalid_key"}, 1)
    return _emit({"ok": True, "extension_id": ext_id}, 0)


def _do_build_extension(rest):
    out_arg = None
    i = 0
    while i < len(rest):
        a = rest[i]
        if a == "--json":
            i += 1
        elif a == "--out":
            if i + 1 >= len(rest):
                return _usage("missing --out value")
            out_arg = rest[i + 1]
            i += 2
        elif a.startswith("--out="):
            out_arg = a[len("--out="):]
            if out_arg == "":
                return _usage("bad --out value")
            i += 1
        else:
            return _usage("unknown flag")
    if out_arg is not None:
        out_path = Path(out_arg)
        if not out_path.is_absolute():
            out_path = Path.cwd() / out_path
    else:
        out_path = _cw_home() / "extension"
    dev_id = _dev_id()
    if dev_id is None:
        return _emit({"ok": False, "error": "invalid_key"}, 1)
    command = ["node", "extension/build.mjs", "--manifest", "dev", "--out", str(out_path)]
    try:
        proc = subprocess.run(command, cwd=str(_repo_root()), capture_output=True, text=True)
    except OSError:
        return _emit({"ok": False, "error": "build_failed"}, 1)
    if proc.returncode != 0:
        return _emit({"ok": False, "error": "build_failed"}, 1)
    step = ("Open chrome://extensions, enable Developer mode, click Load unpacked "
            "and select " + str(out_path) + ".")
    return _emit({"ok": True, "out": str(out_path), "extension_id": dev_id,
                  "next_human_step": step}, 0)


def _do_mcp_json_apply(client, entry, target, force):
    container = "servers" if client == "vscode" else "mcpServers"
    if target.exists():
        if not target.is_file():
            return _emit({"ok": False, "error": "invalid_json", "client": client,
                          "file": str(target), "restart_hint": _restart_hint(client)}, 1)
        try:
            raw_text = target.read_text(encoding="utf-8")
        except OSError:
            return _emit({"ok": False, "error": "invalid_json", "client": client,
                          "file": str(target), "restart_hint": _restart_hint(client)}, 1)
        try:
            data = json.loads(raw_text)
        except ValueError:
            return _emit({"ok": False, "error": "invalid_json", "client": client,
                          "file": str(target), "restart_hint": _restart_hint(client)}, 1)
        if not isinstance(data, dict):
            return _emit({"ok": False, "error": "invalid_json", "client": client,
                          "file": str(target), "restart_hint": _restart_hint(client)}, 1)
        existing_container = data.get(container)
        if existing_container is not None and not isinstance(existing_container, dict):
            return _emit({"ok": False, "error": "invalid_json", "client": client,
                          "file": str(target), "restart_hint": _restart_hint(client)}, 1)
        existing_entry = existing_container.get("tasklight") if isinstance(existing_container, dict) else None
        if isinstance(existing_container, dict) and "tasklight" in existing_container:
            if existing_entry == entry:
                snippet = {container: {"tasklight": entry}}
                return _emit({"ok": True, "client": client, "file": str(target),
                              "snippet": snippet, "restart_hint": _restart_hint(client)}, 0)
            if not force:
                return _emit({"ok": False, "error": "exists_different", "client": client,
                              "file": str(target), "restart_hint": _restart_hint(client)}, 1)
        if not isinstance(data.get(container), dict):
            data[container] = {}
        data[container]["tasklight"] = entry
        snippet = {container: {"tasklight": entry}}
        try:
            _backup_if_exists(target)
            _atomic_write(target, (json.dumps(data, indent=2) + "\n").encode("utf-8"))
        except OSError:
            return _emit({"ok": False, "error": "write_failed", "client": client,
                          "file": str(target), "restart_hint": _restart_hint(client)}, 1)
        return _emit({"ok": True, "client": client, "file": str(target),
                      "snippet": snippet, "restart_hint": _restart_hint(client)}, 0)
    snippet = {container: {"tasklight": entry}}
    try:
        _atomic_write(target, (json.dumps({container: {"tasklight": entry}}, indent=2) + "\n").encode("utf-8"))
    except OSError:
        return _emit({"ok": False, "error": "write_failed", "client": client,
                      "file": str(target), "restart_hint": _restart_hint(client)}, 1)
    return _emit({"ok": True, "client": client, "file": str(target),
                  "snippet": snippet, "restart_hint": _restart_hint(client)}, 0)


def _do_mcp_codex_apply(entry, target, force):
    snippet = _codex_snippet()
    expected_main = {"command": entry["command"], "args": entry["args"]}
    expected_env = {"CW_HOME": entry["env"]["CW_HOME"]}
    if target.exists():
        if not target.is_file():
            return _emit({"ok": False, "error": "invalid_toml", "client": "codex",
                          "file": str(target), "restart_hint": _restart_hint("codex")}, 1)
        try:
            text = target.read_text(encoding="utf-8")
        except OSError:
            return _emit({"ok": False, "error": "invalid_toml", "client": "codex",
                          "file": str(target), "restart_hint": _restart_hint("codex")}, 1)
        try:
            sections = _parse_codex(text)
        except ValueError:
            return _emit({"ok": False, "error": "codex_config_unparsed",
                          "restart_hint": _restart_hint("codex")}, 1)
        has_main = "mcp_servers.tasklight" in sections
        has_env = "mcp_servers.tasklight.env" in sections
        if has_main or has_env:
            if sections.get("mcp_servers.tasklight") == expected_main and sections.get("mcp_servers.tasklight.env") == expected_env:
                return _emit({"ok": True, "client": "codex", "file": str(target),
                              "snippet": snippet, "restart_hint": _restart_hint("codex")}, 0)
            if not force:
                return _emit({"ok": False, "error": "exists_different", "client": "codex",
                              "file": str(target), "restart_hint": _restart_hint("codex")}, 1)
            base = _strip_codex_tasklight(text)
            new_text = base + snippet
            # Rewriting is allowed only if all unrelated parsed data survives.
            try:
                original = _codex_data(text)
                original["mcp_servers"]["tasklight"] = entry
                if _codex_data(new_text) != original:
                    raise ValueError("unsafe rewrite")
            except (ValueError, TypeError, KeyError):
                return _emit({"ok": False, "error": "codex_config_unrewritable",
                              "restart_hint": _restart_hint("codex")}, 1)
            try:
                backup_raw = target.read_bytes()
                backup = target.parent / (target.name + ".bak-" + _stamp())
                backup.write_bytes(backup_raw)
                _atomic_write(target, new_text.encode("utf-8"))
            except OSError:
                return _emit({"ok": False, "error": "write_failed", "client": "codex",
                              "file": str(target), "restart_hint": _restart_hint("codex")}, 1)
            return _emit({"ok": True, "client": "codex", "file": str(target),
                          "snippet": snippet, "restart_hint": _restart_hint("codex")}, 0)
        new_text = text
        if new_text and not new_text.endswith("\n"):
            new_text += "\n"
        new_text += snippet
        try:
            _codex_data(new_text)
        except ValueError:
            return _emit({"ok": False, "error": "codex_config_unparsed",
                          "restart_hint": _restart_hint("codex")}, 1)
        try:
            _backup_if_exists(target)
            _atomic_write(target, new_text.encode("utf-8"))
        except OSError:
            return _emit({"ok": False, "error": "write_failed", "client": "codex",
                          "file": str(target), "restart_hint": _restart_hint("codex")}, 1)
        return _emit({"ok": True, "client": "codex", "file": str(target),
                      "snippet": snippet, "restart_hint": _restart_hint("codex")}, 0)
    try:
        _atomic_write(target, snippet.encode("utf-8"))
    except OSError:
        return _emit({"ok": False, "error": "write_failed", "client": "codex",
                      "file": str(target), "restart_hint": _restart_hint("codex")}, 1)
    payload = {"ok": True, "client": "codex", "file": str(target),
               "snippet": snippet, "restart_hint": _restart_hint("codex")}
    # Include snippet dict form too for uniform parsing via mappings? Keep snippet string.
    return _emit(payload, 0)


def _do_mcp_config(rest):
    client = None
    apply_ = False
    force = False
    i = 0
    while i < len(rest):
        a = rest[i]
        if a == "--json":
            i += 1
        elif a == "--apply":
            apply_ = True
            i += 1
        elif a == "--force":
            force = True
            i += 1
        elif a == "--client":
            if i + 1 >= len(rest):
                return _usage("missing --client value")
            client = rest[i + 1]
            i += 2
        elif a.startswith("--client="):
            client = a[len("--client="):]
            i += 1
        elif a == "--room":
            if i + 1 >= len(rest):
                return _usage("missing --room value")
            i += 2
        elif a.startswith("--room="):
            i += 1
        else:
            return _usage("unknown flag")
    if client is None or client not in CLIENTS:
        return _usage("missing or unknown client")
    if client == "claude-code":
        expected = ["claude", "mcp", "add", "tasklight", "--scope", "user", "-e",
                    "CW_HOME=" + str(_cw_home()), "--", sys.executable, _mcp_path_str()]
        command = shlex.join(expected)
        return _emit({"ok": True, "client": "claude-code", "command": command,
                      "restart_hint": _restart_hint("claude-code")}, 0)
    entry = _expected_entry(client)
    target = _target_path(client)
    if not apply_:
        if client == "codex":
            return _emit({"ok": True, "client": client, "file": str(target),
                          "snippet": _codex_snippet(), "restart_hint": _restart_hint(client)}, 0)
        container = "servers" if client == "vscode" else "mcpServers"
        return _emit({"ok": True, "client": client, "file": str(target),
                      "snippet": {container: {"tasklight": entry}},
                      "restart_hint": _restart_hint(client)}, 0)
    if client == "codex":
        return _do_mcp_codex_apply(entry, target, force)
    return _do_mcp_json_apply(client, entry, target, force)


def _manifest_dir(browser):
    home = Path.home()
    plat = sys.platform
    if plat.startswith("win"):
        local = os.environ.get("LOCALAPPDATA")
        if not local:
            local = str(home / "AppData" / "Local")
        return Path(local) / "TaskLight" / "native"
    if plat == "darwin":
        return home / "Library" / "Application Support" / _DARWIN_SUBDIRS[browser] / "NativeMessagingHosts"
    return home / ".config" / _LINUX_SUBDIRS[browser] / "NativeMessagingHosts"


def _browser_profile(browser):
    """Detect user profiles, independently of browser executables on PATH."""
    home = Path.home()
    if sys.platform.startswith("win"):
        vendors = {"chrome": "Google/Chrome", "chromium": "Chromium",
                   "edge": "Microsoft/Edge", "brave": "BraveSoftware/Brave-Browser"}
        return home / "AppData" / "Local" / vendors[browser] / "User Data"
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / _DARWIN_SUBDIRS[browser]
    return home / ".config" / _LINUX_SUBDIRS[browser]


def _check_one_native(browser, dev_id):
    mpath = _manifest_dir(browser) / (HOST_NAME + ".json")
    if dev_id is None:
        return False, "missing extension id"
    try:
        if not mpath.is_file():
            return False, "native host manifest missing at " + str(mpath)
        try:
            data = json.loads(mpath.read_text(encoding="utf-8"))
        except Exception:
            return False, "native host manifest malformed"
        if not isinstance(data, dict):
            return False, "native host manifest malformed"
        origins = data.get("allowed_origins")
        expected = "chrome-extension://" + dev_id + "/"
        if not isinstance(origins, list) or expected not in origins:
            return False, "native host allowed_origins missing dev id"
        launcher = data.get("path")
        if not isinstance(launcher, str) or not launcher:
            return False, "native host launcher missing"
        lp = Path(launcher)
        if not lp.is_file():
            return False, "native host launcher missing"
        if not os.access(str(lp), os.X_OK):
            return False, "native host launcher not executable"
        return True, "native host ok for " + browser
    except Exception:
        return False, "native host check failed"


def _do_doctor(rest):
    browser = None
    clients = []
    room = "demo"
    i = 0
    while i < len(rest):
        a = rest[i]
        if a == "--json":
            i += 1
        elif a == "--browser":
            if i + 1 >= len(rest):
                return _usage("missing --browser value")
            browser = rest[i + 1]
            i += 2
        elif a.startswith("--browser="):
            browser = a[len("--browser="):]
            i += 1
        elif a == "--room":
            if i + 1 >= len(rest):
                return _usage("missing --room value")
            room = rest[i + 1]
            i += 2
        elif a.startswith("--room="):
            room = a[len("--room="):]
            i += 1
        elif a == "--client":
            if i + 1 >= len(rest):
                return _usage("missing --client value")
            clients.append(rest[i + 1])
            i += 2
        elif a.startswith("--client="):
            clients.append(a[len("--client="):])
            i += 1
        else:
            return _usage("unknown flag")
    if browser is not None and browser not in BROWSERS:
        return _usage("bad browser")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,47}(?::(?:private|standard))?", room):
        return _usage("bad room")
    for c in clients:
        if c not in CLIENTS:
            return _usage("bad client")
    checks = []
    dev_id = _dev_id()
    # python
    try:
        major = sys.version_info[0]
        minor = sys.version_info[1]
        py_ok = (major, minor) >= (3, 10)
        py_detail = "python " + str(major) + "." + str(minor)
    except Exception:
        py_ok = False
        py_detail = "python unknown"
    if py_ok:
        checks.append({"id": "python", "status": "ok", "detail": py_detail})
    else:
        checks.append({"id": "python", "status": "fail", "detail": py_detail,
                       "fix": "Install Python 3.10 or newer."})
    # node
    node_path = shutil.which("node")
    node_ok = False
    node_detail = "node not found"
    if node_path is not None:
        try:
            res = subprocess.run([node_path, "--version"], capture_output=True, text=True, timeout=5)
            if res.returncode != 0:
                node_detail = "node --version failed"
            else:
                out = (res.stdout or "") + (res.stderr or "")
                m = re.search(r"v(\d+)\.(\d+)\.(\d+)", out)
                if m is None:
                    node_detail = "node version unparsable"
                else:
                    full = m.group(0)
                    node_ok = int(m.group(1)) >= 22
                    node_detail = "node " + full
        except (OSError, ValueError):
            node_detail = "node --version failed"
    if node_ok:
        checks.append({"id": "node", "status": "ok", "detail": node_detail})
    else:
        checks.append({"id": "node", "status": "fail", "detail": node_detail,
                       "fix": "Install Node.js 22 or newer."})
    # node_modules
    vite = _repo_root() / "node_modules" / "vite"
    if vite.is_dir():
        checks.append({"id": "node_modules", "status": "ok", "detail": "node_modules/vite present"})
    else:
        checks.append({"id": "node_modules", "status": "fail", "detail": "node_modules/vite missing",
                       "fix": "npm ci"})
    # cw_home
    cw = _cw_home()
    try:
        if cw.exists() and not cw.is_dir():
            checks.append({"id": "cw_home", "status": "fail", "detail": "cw_home is not a directory",
                           "fix": "Set CW_HOME to an existing writable directory."})
        else:
            cw.mkdir(parents=True, exist_ok=True)
            if os.access(str(cw), os.W_OK):
                checks.append({"id": "cw_home", "status": "ok", "detail": "cw_home writable at " + str(cw)})
            else:
                checks.append({"id": "cw_home", "status": "fail", "detail": "cw_home not writable",
                               "fix": "Grant your user write permission on " + str(cw) + "."})
    except OSError:
        checks.append({"id": "cw_home", "status": "fail", "detail": "cw_home not creatable",
                       "fix": "Set CW_HOME to an existing writable directory."})
    # Parse separately because load_config deliberately returns None on errors.
    cfg_path = cw / "wall.config.json"
    cfg_ok = False
    cfg_detail = "wall.config.json invalid content"
    cfg_fix = "Correct " + str(cfg_path) + ": config validation failed (expected v1 config and at least one room)."
    try:
        from bridge.wall.emit import load_config as _load_config
        data = json.loads(cfg_path.read_text(encoding="utf-8"))
        cfg = _load_config(data)
        if cfg is not None:
            rooms = cfg.get("rooms")
            allow = rooms.get("allow") if isinstance(rooms, dict) else rooms
            cfg_ok = isinstance(allow, list) and len(allow) >= 1
        if cfg_ok:
            cfg_detail = "wall.config.json ok"
    except FileNotFoundError:
        cfg_detail = "wall.config.json missing"
        cfg_fix = ("python3 bridge/install.py --browser " + (browser or "chrome") +
                   " --room " + room + " --apply")
    except (OSError, ValueError) as exc:
        cfg_fix = "Correct " + str(cfg_path) + ": " + str(exc)
    if cfg_ok:
        checks.append({"id": "config", "status": "ok", "detail": cfg_detail})
    else:
        checks.append({"id": "config", "status": "fail", "detail": cfg_detail,
                       "fix": cfg_fix})
    # extension_build
    ext_manifest = cw / "extension" / "manifest.json"
    ext_ok = False
    ext_detail = "extension build missing"
    if dev_id is not None:
        try:
            if ext_manifest.is_file():
                data = json.loads(ext_manifest.read_text(encoding="utf-8"))
                if isinstance(data, dict) and _derive_id(data.get("key")) == dev_id:
                    ext_ok = True
                    ext_detail = "extension build ok"
        except Exception:
            ext_ok = False
    if ext_ok:
        checks.append({"id": "extension_build", "status": "ok", "detail": ext_detail})
    else:
        checks.append({"id": "extension_build", "status": "fail", "detail": ext_detail,
                       "fix": "python3 bridge/tasklight_setup.py build-extension --json"})
    # native_host
    if browser is not None:
        to_check = [browser]
    else:
        to_check = [b for b in BROWSERS if _browser_profile(b).is_dir()]
    if not to_check:
        checks.append({"id": "native_host", "status": "fail", "detail": "no Chrome-family browser detected",
                       "fix": "Install Google Chrome."})
    else:
        for b in to_check:
            ok_one, detail_one = _check_one_native(b, dev_id)
            check = {"id": "native_host" if len(to_check) == 1 else "native_host_" + b,
                     "status": "ok" if ok_one else "fail", "detail": detail_one}
            if not ok_one:
                check["fix"] = "python3 bridge/install.py --browser " + b + " --apply"
            checks.append(check)
    # mcp_<client>
    for c in clients:
        cid = "mcp_" + c
        if c == "claude-code":
            claude = shutil.which("claude")
            if claude is None:
                checks.append({"id": cid, "status": "warn", "detail": "claude not found",
                               "fix": "install Claude Code or use another client"})
                continue
            expected = _expected_entry(c)
            matched = False
            try:
                result = subprocess.run([claude, "mcp", "get", "tasklight"],
                                        capture_output=True, text=True, timeout=5)
                if result.returncode == 0:
                    output = result.stdout or ""
                    try:
                        registered = json.loads(output)
                        matched = (isinstance(registered, dict) and
                                   registered.get("command") == expected["command"] and
                                   registered.get("args") == expected["args"])
                    except ValueError:
                        fields = {}
                        for line in output.splitlines():
                            name, sep, value = line.strip().partition(":")
                            if sep and name in ("Command", "Args"):
                                fields[name] = value.strip()
                        matched = (fields.get("Command") == expected["command"] and
                                   fields.get("Args") in (shlex.join(expected["args"]),
                                                          " ".join(expected["args"])))
            except (OSError, subprocess.TimeoutExpired):
                pass
            check = {"id": cid, "status": "ok" if matched else "fail",
                     "detail": "registration matches" if matched else "registration missing or different"}
            if not matched:
                check["fix"] = shlex.join(["claude", "mcp", "add", "tasklight", "--scope", "user",
                                           "-e", "CW_HOME=" + str(_cw_home()), "--",
                                           expected["command"], *expected["args"]])
            checks.append(check)
            continue
        entry = _expected_entry(c)
        target = _target_path(c)
        ok_c = False
        detail_c = "mcp " + c + " missing"
        try:
            if c == "codex":
                if target.is_file():
                    text = target.read_text(encoding="utf-8")
                    sections = _parse_codex(text)
                    want_main = {"command": entry["command"], "args": entry["args"]}
                    want_env = {"CW_HOME": entry["env"]["CW_HOME"]}
                    if sections.get("mcp_servers.tasklight") == want_main and sections.get("mcp_servers.tasklight.env") == want_env:
                        ok_c = True
                        detail_c = "mcp codex ok"
            else:
                container = "servers" if c == "vscode" else "mcpServers"
                if target.is_file():
                    data = json.loads(target.read_text(encoding="utf-8"))
                    if isinstance(data, dict):
                        cont = data.get(container)
                        if isinstance(cont, dict) and cont.get("tasklight") == entry:
                            ok_c = True
                            detail_c = "mcp " + c + " ok"
        except Exception:
            ok_c = False
        if ok_c:
            checks.append({"id": cid, "status": "ok", "detail": detail_c})
        else:
            checks.append({"id": cid, "status": "fail", "detail": detail_c,
                           "fix": "python3 bridge/tasklight_setup.py mcp-config --client " + c + " --apply --json"})
    # templates
    tpl_ok = False
    tpl_detail = "templates invalid"
    try:
        from bridge.plan.template import load_template as _load_tpl
        planning = _repo_root() / "templates" / "planning"
        tpls = {}
        try:
            files = sorted(planning.glob("*.json"))
        except Exception:
            files = []
        for p in files:
            try:
                tpl = _load_tpl(str(p))
                tpls[tpl.get("id")] = tpl
            except Exception:
                continue
        if len(tpls) >= 1 and "autonomous-software" in tpls:
            tpl_ok = True
            tpl_detail = "templates ok"
    except Exception:
        tpl_ok = False
    if tpl_ok:
        checks.append({"id": "templates", "status": "ok", "detail": tpl_detail})
    else:
        checks.append({"id": "templates", "status": "fail", "detail": tpl_detail,
                       "fix": "git restore -- templates/planning/autonomous-software.json"})
    failed = any(c["status"] == "fail" for c in checks)
    return _emit({"ok": not failed, "checks": checks}, 1 if failed else 0)


def _do_wall(rest):
    port = 5173
    port_str = None
    i = 0
    while i < len(rest):
        a = rest[i]
        if a == "--json":
            i += 1
        elif a == "--port":
            if i + 1 >= len(rest):
                return _usage("missing --port value")
            port_str = rest[i + 1]
            i += 2
        elif a.startswith("--port="):
            port_str = a[len("--port="):]
            i += 1
        else:
            return _usage("unknown flag")
    if port_str is not None:
        try:
            port = int(port_str)
        except ValueError:
            return _usage("bad port")
        if str(port) != port_str and port_str not in ("0" + str(port),):
            # Allow leading zeros normalization but reject junk; keep simple
            pass
        # Reject non-decimal forms strictly
        if re.fullmatch(r"[0-9]+", port_str) is None:
            return _usage("bad port")
        if port == 5998 or port < 1 or port > 65535:
            return _usage("bad port")
    dev_id = _dev_id()
    if dev_id is None:
        return _emit({"ok": False, "error": "invalid_key"}, 1)
    url = "http://localhost:" + str(port) + "/"
    command = ["node", "node_modules/vite/bin/vite.js", "--config", "tools/demo/vite.demo.config.ts",
               "--host", "127.0.0.1", "--port", str(port), "--strictPort"]
    env = dict(os.environ)
    env["VITE_EXTENSION_ORIGINS"] = "chrome-extension://" + dev_id
    try:
        proc = subprocess.Popen(command, cwd=str(_repo_root()), env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        return _emit({"ok": False, "error": "wall_failed"}, 1)
    def stop_child():
        if proc.poll() is not None:
            proc.wait(timeout=3)
            return
        try:
            proc.terminate()
        except OSError:
            pass
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)

    def interrupted(signum, frame):
        raise KeyboardInterrupt

    handlers = {}
    emitted = False
    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            handlers[signum] = signal.getsignal(signum)
            signal.signal(signum, interrupted)
        deadline = time.monotonic() + 15
        ready = False
        while proc.poll() is None:
            try:
                with urllib.request.urlopen(url, timeout=2) as resp:
                    status = getattr(resp, "status", None)
                    if status is None:
                        status = resp.getcode()
                if status == 200:
                    ready = True
                    break
            except Exception:
                pass
            if time.monotonic() >= deadline:
                break
            time.sleep(0.25)
        if not ready:
            emitted = True
            return _emit({"ok": False, "error": "not_ready"}, 1)
        emitted = True
        _emit({"ok": True, "url": url}, 0)
        proc.wait()
        return 0
    except KeyboardInterrupt:
        if not emitted:
            return _emit({"ok": False, "error": "interrupted"}, 1)
        return 0
    except Exception:
        if not emitted:
            return _emit({"ok": False, "error": "wall_failed"}, 1)
        return 1
    finally:
        try:
            stop_child()
        except (OSError, subprocess.TimeoutExpired, KeyboardInterrupt):
            pass
        finally:
            for signum, handler in handlers.items():
                signal.signal(signum, handler)


def main(argv=None):
    args = list(sys.argv[1:]) if argv is None else list(argv)
    if not args:
        return _usage("missing verb")
    verb = args[0]
    rest = args[1:]
    try:
        if verb == "extension-id":
            return _do_extension_id(rest)
        if verb == "build-extension":
            return _do_build_extension(rest)
        if verb == "mcp-config":
            return _do_mcp_config(rest)
        if verb == "doctor":
            return _do_doctor(rest)
        if verb == "wall":
            return _do_wall(rest)
        return _usage("unknown verb")
    except BrokenPipeError:
        return 1
    except Exception as exc:
        try:
            return _emit({"ok": False, "error": "internal", "detail": str(exc)[:200]}, 1)
        except Exception:
            return 1


if __name__ == "__main__":
    sys.exit(main())



