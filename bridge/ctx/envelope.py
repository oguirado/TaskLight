import hashlib
import json

SCHEMA = "ctx.resp/v1"


def _validate(obj):
    if obj is None or isinstance(obj, (bool, str)):
        return
    if type(obj) is int:
        return
    if isinstance(obj, float):
        raise ValueError("float")
    if isinstance(obj, (list, tuple)):
        for item in obj:
            _validate(item)
        return
    if isinstance(obj, dict):
        for key, value in obj.items():
            if not isinstance(key, str):
                raise TypeError("key")
            _validate(value)
        return
    raise TypeError("obj")


def canonical(obj: object) -> str:
    _validate(obj)
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)


def _hash(data: dict) -> str:
    return hashlib.sha256(canonical(data).encode("utf-8")).hexdigest()


def respond(verb, rc, data) -> dict:
    try:
        digest = _hash(data)
    except (ValueError, TypeError) as exc:
        data = {"error": type(exc).__name__}
        digest = _hash(data)
        rc = 2
    return {"schema": SCHEMA, "ok": rc == 0, "rc": rc, "verb": verb,
            "data": data, "sha256": digest}
