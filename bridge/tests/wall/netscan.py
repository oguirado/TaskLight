"""Static scanner for B2 (no network/dynamic imports, no eval/exec/__import__, no LLM SDK). Stdlib only.
CLI: python3 -I netscan.py FILE... ; exit 1 when any hit."""
import ast, sys

BANNED = {"socket", "ssl", "http", "urllib", "ftplib", "smtplib", "xmlrpc", "asyncio", "importlib",
          "anthropic", "openai", "langchain", "ollama", "mistralai", "cohere", "litellm", "vertexai", "genai"}
BANNED_DOTTED = ("google.generativeai", "google.genai", "google.cloud.aiplatform")
BANNED_CALLS = {"__import__", "eval", "exec"}


def scan_source(src, name="<src>"):
    hits = []
    for n in ast.walk(ast.parse(src, name)):
        mods = []
        if isinstance(n, ast.Import):
            mods = [a.name for a in n.names]
        elif isinstance(n, ast.ImportFrom) and n.level == 0 and n.module:
            mods = [n.module]
        for m in mods:
            if m.split(".")[0] in BANNED or m.startswith(BANNED_DOTTED):
                hits.append((name, n.lineno, "import " + m))
        if isinstance(n, ast.Name) and n.id in BANNED_CALLS:
            hits.append((name, n.lineno, "name " + n.id))
        if isinstance(n, ast.Attribute) and n.attr == "__import__":
            hits.append((name, n.lineno, "attr __import__"))
    return hits


def scan_files(paths):
    out = []
    for p in paths:
        with open(p, encoding="utf-8") as fh:
            out += scan_source(fh.read(), str(p))
    return out


if __name__ == "__main__":
    h = scan_files(sys.argv[1:])
    for x in h:
        print("%s:%d: %s" % x)
    sys.exit(1 if h else 0)
