import hashlib
import json

from .envelope import canonical, respond

_VERBS = {"page", "find", "census", "tail", "state", "check"}
_RCS = {0, 2, 4, 6, 7, 124}
_ENVELOPE_KEYS = {"schema", "ok", "rc", "verb", "data", "sha256"}


class _Dup(Exception):
    pass


class _Const(Exception):
    pass


def _pairs(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise _Dup()
        obj[key] = value
    return obj


def _bad_const(_value):
    raise _Const()


def _err(code, path, errs):
    errs.append({"code": code, "path": path})


def _int(value, path, errs) -> bool:
    if type(value) is int:
        return True
    if type(value) is bool:
        _err("BOOL_AS_INT", path, errs)
    elif isinstance(value, float):
        _err("BAD_NUMBER", path, errs)
    else:
        _err("WRONG_TYPE", path, errs)
    return False


def _bool(value, path, errs) -> bool:
    if type(value) is bool:
        return True
    _err("WRONG_TYPE", path, errs)
    return False


def _str(value, path, errs) -> bool:
    if isinstance(value, str):
        return True
    _err("WRONG_TYPE", path, errs)
    return False


def _str_list(value, path, errs):
    if not isinstance(value, list):
        _err("WRONG_TYPE", path, errs)
        return
    for index, item in enumerate(value):
        if not isinstance(item, str):
            _err("WRONG_TYPE", path + "." + str(index), errs)


def _keys(obj, expected, prefix, errs, optional=()):
    for key in sorted(set(obj) - set(expected) - set(optional)):
        _err("UNKNOWN_FIELD", prefix + key, errs)
    for key in sorted(set(expected) - set(obj)):
        _err("MISSING_FIELD", prefix + key, errs)


def _page_data(d, errs):
    _keys(d, {"path", "from", "lines", "total_lines", "next", "sha256",
              "line_cut", "lossy"}, "data.", errs)
    if "path" in d:
        _str(d["path"], "data.path", errs)
    if "from" in d:
        _int(d["from"], "data.from", errs)
    if "lines" in d:
        _str_list(d["lines"], "data.lines", errs)
    if "total_lines" in d:
        _int(d["total_lines"], "data.total_lines", errs)
    if "next" in d and d["next"] is not None:
        _int(d["next"], "data.next", errs)
    if "sha256" in d:
        _str(d["sha256"], "data.sha256", errs)
    if "line_cut" in d:
        _bool(d["line_cut"], "data.line_cut", errs)
    if "lossy" in d:
        _bool(d["lossy"], "data.lossy", errs)


def _find_data(d, errs):
    _keys(d, {"hits", "complete", "scanned", "skipped", "binary"}, "data.",
          errs, optional=("absent",))
    if "hits" in d:
        if not isinstance(d["hits"], list):
            _err("WRONG_TYPE", "data.hits", errs)
        else:
            for index, hit in enumerate(d["hits"]):
                at = "data.hits." + str(index)
                if not isinstance(hit, dict):
                    _err("WRONG_TYPE", at, errs)
                    continue
                _keys(hit, {"path", "line", "cover", "snippet"}, at + ".", errs)
                if "path" in hit:
                    _str(hit["path"], at + ".path", errs)
                if "line" in hit:
                    _int(hit["line"], at + ".line", errs)
                if "cover" in hit:
                    _int(hit["cover"], at + ".cover", errs)
                if "snippet" in hit:
                    _str(hit["snippet"], at + ".snippet", errs)
    if "complete" in d:
        _bool(d["complete"], "data.complete", errs)
    if "scanned" in d:
        _int(d["scanned"], "data.scanned", errs)
    if "skipped" in d:
        _int(d["skipped"], "data.skipped", errs)
    if "binary" in d:
        _int(d["binary"], "data.binary", errs)
    if "absent" in d:
        _str_list(d["absent"], "data.absent", errs)


def _census_data(d, errs):
    _keys(d, {"files", "bytes", "by_ext", "largest", "complete"}, "data.", errs)
    if "files" in d:
        _int(d["files"], "data.files", errs)
    if "bytes" in d:
        _int(d["bytes"], "data.bytes", errs)
    if "by_ext" in d:
        if not isinstance(d["by_ext"], dict):
            _err("WRONG_TYPE", "data.by_ext", errs)
        else:
            for key, value in d["by_ext"].items():
                if not isinstance(key, str):
                    _err("WRONG_TYPE", "data.by_ext", errs)
                else:
                    _int(value, "data.by_ext." + key, errs)
    if "largest" in d:
        if not isinstance(d["largest"], list):
            _err("WRONG_TYPE", "data.largest", errs)
        else:
            for index, item in enumerate(d["largest"]):
                at = "data.largest." + str(index)
                if not isinstance(item, dict):
                    _err("WRONG_TYPE", at, errs)
                    continue
                _keys(item, {"bytes", "path"}, at + ".", errs)
                if "path" in item:
                    _str(item["path"], at + ".path", errs)
                if "bytes" in item:
                    _int(item["bytes"], at + ".bytes", errs)
    if "complete" in d:
        _bool(d["complete"], "data.complete", errs)


def _tail_data(d, errs):
    _keys(d, {"path", "lines", "line_count", "byte_count", "sha256", "cut"},
          "data.", errs)
    if "path" in d:
        _str(d["path"], "data.path", errs)
    if "lines" in d:
        _str_list(d["lines"], "data.lines", errs)
    if "line_count" in d:
        _int(d["line_count"], "data.line_count", errs)
    if "byte_count" in d:
        _int(d["byte_count"], "data.byte_count", errs)
    if "sha256" in d:
        _str(d["sha256"], "data.sha256", errs)
    if "cut" in d:
        _bool(d["cut"], "data.cut", errs)


def _state_data(d, errs):
    _keys(d, {"facts"}, "data.", errs)
    if "facts" in d:
        if not isinstance(d["facts"], dict):
            _err("WRONG_TYPE", "data.facts", errs)
        else:
            for key, value in d["facts"].items():
                if not isinstance(key, str):
                    _err("WRONG_TYPE", "data.facts", errs)
                elif type(value) is int or type(value) is bool or isinstance(value, str):
                    continue
                elif isinstance(value, float):
                    _err("BAD_NUMBER", "data.facts." + key, errs)
                else:
                    _err("WRONG_TYPE", "data.facts." + key, errs)


def _check_data(d, errs):
    _keys(d, {"errors", "valid"}, "data.", errs)
    if "valid" in d:
        _bool(d["valid"], "data.valid", errs)
    if "errors" in d:
        if not isinstance(d["errors"], list):
            _err("WRONG_TYPE", "data.errors", errs)
        else:
            for index, item in enumerate(d["errors"]):
                at = "data.errors." + str(index)
                if not isinstance(item, dict):
                    _err("WRONG_TYPE", at, errs)
                    continue
                _keys(item, {"code", "path"}, at + ".", errs)
                if "code" in item:
                    _str(item["code"], at + ".code", errs)
                if "path" in item:
                    _str(item["path"], at + ".path", errs)


_SHAPES = {"page": _page_data, "find": _find_data, "census": _census_data,
           "tail": _tail_data, "state": _state_data, "check": _check_data}


def _invalid(errs):
    errs = sorted(errs, key=lambda e: (e["path"], e["code"]))
    return respond("check", 2, {"valid": False, "errors": errs})


def _check(obj_json):
    errs: list = []
    try:
        obj = json.loads(obj_json, object_pairs_hook=_pairs,
                         parse_constant=_bad_const)
    except _Dup:
        return _invalid([{"code": "WRONG_TYPE", "path": ""}])
    except _Const:
        return _invalid([{"code": "BAD_NUMBER", "path": ""}])
    except Exception:
        return _invalid([{"code": "WRONG_TYPE", "path": ""}])
    if not isinstance(obj, dict):
        return _invalid([{"code": "WRONG_TYPE", "path": ""}])
    _keys(obj, _ENVELOPE_KEYS, "", errs)
    if "schema" in obj and obj["schema"] != "ctx.resp/v1":
        _err("WRONG_TYPE", "schema", errs)
    verb = obj.get("verb")
    if "verb" in obj and verb not in _VERBS:
        _err("WRONG_TYPE", "verb", errs)
    if "rc" in obj:
        if _int(obj["rc"], "rc", errs) and obj["rc"] not in _RCS:
            _err("WRONG_TYPE", "rc", errs)
    if "ok" in obj and _bool(obj["ok"], "ok", errs):
        rc = obj.get("rc")
        if type(rc) is int and obj["ok"] != (rc == 0):
            _err("WRONG_TYPE", "ok", errs)
    data = obj.get("data")
    if "data" in obj:
        if not isinstance(data, dict):
            _err("WRONG_TYPE", "data", errs)
        elif verb in _SHAPES:
            _SHAPES[verb](data, errs)
    if "sha256" in obj and isinstance(data, dict):
        if not isinstance(obj["sha256"], str):
            _err("WRONG_TYPE", "sha256", errs)
        else:
            try:
                digest = hashlib.sha256(
                    canonical(data).encode("utf-8")).hexdigest()
            except Exception:
                _err("STALE_SHA", "sha256", errs)
                digest = None
            if digest is not None and obj["sha256"] != digest:
                _err("STALE_SHA", "sha256", errs)
    errs = sorted(errs, key=lambda e: (e["path"], e["code"]))
    if errs:
        return respond("check", 2, {"valid": False, "errors": errs})
    return respond("check", 0, {"valid": True, "errors": []})


def check(obj_json: str):
    try:
        return _check(obj_json)
    except Exception:
        return _invalid([{"code": "WRONG_TYPE", "path": ""}])
