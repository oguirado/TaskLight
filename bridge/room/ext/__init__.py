"""Extension seam for additional MCP tools (S0, frozen interface).

An extension module lives in ``bridge/room/ext/<name>.py`` and calls
``register(tool, handler)`` at import time:

- ``tool`` is an MCP tool descriptor ``{"name", "description", "inputSchema"}``.
- ``handler(args: dict) -> dict`` returns the result data. It raises
  ``bridge.room.store.RoomError`` for tool errors. The server wraps the data
  exactly like the v2 tools (``{"untrusted": data}``) and turns a RoomError
  into ``{"ok": false, "code": ...}`` with ``isError: true``.

Extension modules import ``bridge.room.store`` and ``bridge.plan.*`` only;
they never import ``bridge.room.mcp``.
"""
import importlib

# Modules loaded by ``load()``, in this order. A listed module that does not
# exist yet is skipped; any other import error propagates.
EXT_MODULES = ("events", "activity", "export")

EXT_TOOLS = []
EXT_DISPATCH = {}


def register(tool, handler):
    if not isinstance(tool, dict) or not isinstance(tool.get("name"), str):
        raise ValueError("tool descriptor needs a name")
    name = tool["name"]
    if name in EXT_DISPATCH:
        raise ValueError("duplicate extension tool: %s" % name)
    if not callable(handler):
        raise ValueError("handler must be callable")
    EXT_TOOLS.append(tool)
    EXT_DISPATCH[name] = handler


def load():
    for mod in EXT_MODULES:
        full = "%s.%s" % (__name__, mod)
        try:
            importlib.import_module(full)
        except ModuleNotFoundError as e:
            if e.name != full:
                raise
    return list(EXT_TOOLS)
