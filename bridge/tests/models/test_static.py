"""Static + regression controls (GREEN now unless marked): no network code leaks into bridge/wall, frozen constants."""
import ast, importlib, inspect, pathlib, subprocess, sys
from bridge.tests.wall import netscan
from . import support as S

WALL = S.REPO / "bridge" / "wall"
MODELS = S.REPO / "bridge" / "models"
BANNED_NET = {"socket", "ssl", "http", "urllib", "importlib", "ftplib", "smtplib", "xmlrpc", "asyncio"}


def imports(path):
    out = []
    for n in ast.walk(ast.parse(pathlib.Path(path).read_text())):
        if isinstance(n, ast.Import):
            out += [(a.name, 0) for a in n.names]
        elif isinstance(n, ast.ImportFrom):
            out.append((n.module or "", n.level))
    return out


class Static(S.Base):
    def test_wall_tree_has_no_network_imports(self):               # GREEN control (spec F1, acceptance 17)
        files = sorted(WALL.rglob("*.py")) + [S.REPO / "bridge" / "install.py"]
        self.assertEqual(netscan.scan_files(files), [])

    def test_only_transport_imports_network_modules(self):          # GREEN on the stub
        mods = sorted(MODELS.rglob("*.py"))
        self.assertIn("transport.py", [m.name for m in mods])
        for m in mods:
            hit = {n.split(".")[0] for n, lvl in imports(m) if lvl == 0} & BANNED_NET
            if m.name == "transport.py":
                self.assertFalse(hit & {"urllib", "importlib", "ftplib", "smtplib", "xmlrpc", "asyncio"}, hit)
            else:
                self.assertEqual(hit, set(), m.name)

    def test_no_llm_sdk_or_dynamic_import_in_models(self):          # GREEN on the stub
        self.assertEqual(netscan.scan_files([m for m in MODELS.rglob("*.py") if m.name != "transport.py"]), [])
        hits = [h for h in netscan.scan_files([MODELS / "transport.py"])
                if not any(h[2].startswith("import " + m) for m in ("socket", "ssl", "http"))]
        self.assertEqual(hits, [])

    def test_model_relay_imports_only_models_and_light_stdlib(self):   # RED: file absent (U48 writes it)
        p = WALL / "model_relay.py"
        self.assertTrue(p.is_file(), "bridge/wall/model_relay.py missing")
        allowed = {"threading", "queue", "json", "re", "time", "os", "sys", "__future__", "typing", "collections"}
        for name, lvl in imports(p):
            top = name.split(".")[0]
            ok = (lvl == 0 and name.startswith("bridge.models")) or (lvl == 0 and top in allowed)
            self.assertTrue(ok, "forbidden import %r (level %d)" % (name, lvl))
        self.assertEqual(netscan.scan_files([p]), [])

    def test_frozen_constants(self):                                # GREEN: stub carries the frozen names
        m = importlib.import_module("bridge.models")
        self.assertEqual(sorted(m.NACK_CODES), sorted(S.NACKS))
        self.assertEqual(len(m.NACK_CODES), 16)
        self.assertEqual((m.MAX_FRAME, m.MAX_REQUEST_BODY, m.MAX_REPLY_BYTES, m.MAX_ENDPOINTS),
                         (65536, 49152, 1 << 20, 16))
        self.assertEqual((m.TIMEOUT_PROBE_MS, m.TIMEOUT_LOCAL_GENERATE_MS, m.TIMEOUT_REMOTE_GENERATE_MS),
                         (1500, 30000, 60000))
        self.assertEqual(m.KINDS, ("local-openai-compatible", "remote-openai-compatible"))
        self.assertEqual(m.TIERS, ("private", "standard", "shared"))
        self.assertEqual(m.HEALTH_STATES, ("available", "needs_setup", "offline", "blocked"))
        for n in ("hello", "list", "probe", "health", "generate", "result", "nack", "cancel"):
            self.assertEqual(getattr(m, "FRAME_" + n.upper()), "model_" + n)

    def test_public_surface_signatures(self):                       # GREEN: frozen signatures on the stub
        st = importlib.import_module("bridge.models.store")
        tr = importlib.import_module("bridge.models.transport")
        for fn, params in ((st.load, ["home"]), (st.save_endpoints, ["home", "endpoints"]),
                           (st.set_key, ["home", "endpoint_id", "key"]), (st.remove, ["home", "endpoint_id"]),
                           (tr.probe, ["endpoint", "key", "timeout_s"]),
                           (tr.generate, ["endpoint", "key", "body", "deadline", "cancel"]),
                           (tr.check_loopback, ["host", "port"])):
            self.assertEqual(list(inspect.signature(fn).parameters)[:len(params)], params, fn.__name__)
        for fn in (tr.probe, tr.generate, tr.check_loopback):
            self.assertIn("resolver", inspect.signature(fn).parameters)
        e = tr.TransportError("redirect", status=302)
        self.assertEqual((e.code, e.status), ("redirect", 302))

    def test_oracle_sources_hold_no_secret_literals(self):          # GREEN control
        for p in pathlib.Path(__file__).parent.glob("*.py"):
            t = p.read_text()
            self.assertNotIn("-----BEGIN" + " RSA", t)
            self.assertNotIn("sk-" + "proj", t)
