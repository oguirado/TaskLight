"""Static scanner (oracle tooling, stdlib only): exit 0 clean, 1 on any violation.

usage: scan_imports.py DIR   -- scans every *.py under DIR (recursive, sorted)
Rules (SPEC_U29 B4): imports must be stdlib and not in BANNED; `subprocess` only in
state.py; no dynamic import; no write-mode open(); no file-mutating calls.
"""
import ast
import os
import sys

BANNED = {"socket", "ssl", "http", "urllib", "ftplib", "smtplib", "xmlrpc", "asyncio",
          "requests", "importlib"}
WRITE_ATTRS = {"write_text", "write_bytes", "unlink", "rmdir", "mkdir", "makedirs", "remove",
               "removedirs", "rmtree", "system", "popen", "touch", "symlink", "chmod"}


def scan(path):
    out = []
    name = os.path.basename(path)
    tree = ast.parse(open(path, encoding="utf-8").read(), path)
    for n in ast.walk(tree):
        mods = []
        if isinstance(n, ast.Import):
            mods = [a.name for a in n.names]
        elif isinstance(n, ast.ImportFrom) and n.level == 0 and n.module:
            mods = [n.module]
        for m in mods:
            top = m.split(".")[0]
            if top in BANNED:
                out.append("%s:%d banned import %s" % (path, n.lineno, m))
            elif top not in sys.stdlib_module_names:
                out.append("%s:%d non-stdlib import %s" % (path, n.lineno, m))
            elif top == "subprocess" and name != "state.py":
                out.append("%s:%d subprocess outside state.py" % (path, n.lineno))
        if isinstance(n, ast.Call):
            f = n.func
            if isinstance(f, ast.Name) and f.id in ("__import__", "eval", "exec"):
                out.append("%s:%d dynamic %s" % (path, n.lineno, f.id))
            if isinstance(f, ast.Name) and f.id == "open":
                mode = None
                if len(n.args) > 1 and isinstance(n.args[1], ast.Constant):
                    mode = n.args[1].value
                for kw in n.keywords:
                    if kw.arg == "mode" and isinstance(kw.value, ast.Constant):
                        mode = kw.value.value
                if isinstance(mode, str) and set(mode) & set("wax+"):
                    out.append("%s:%d write-mode open" % (path, n.lineno))
            if isinstance(f, ast.Attribute) and f.attr in WRITE_ATTRS:
                out.append("%s:%d mutating call .%s" % (path, n.lineno, f.attr))
    return out


def main(argv):
    if len(argv) != 1:
        print("usage: scan_imports.py DIR")
        return 2
    bad = []
    for dp, dn, fn in os.walk(argv[0]):
        dn.sort()
        for f in sorted(fn):
            if f.endswith(".py"):
                bad += scan(os.path.join(dp, f))
    for b in bad:
        print(b)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
