import copy
import hashlib
import json
import math

from .errors import PlanError
from .limits import (
    BRIEF_FIELDS_MAX,
    MEMORY_CHARS_MAX,
    MEMORY_SECTIONS_MAX,
    PHASES_MAX,
    SHA256_RE,
    SLUG_RE,
    TASK_TYPES_MAX,
    TPL_EXIT_MAX,
    TPL_HINT_MAX,
    TPL_LABEL_MAX,
    TPL_NAME_MAX,
    TPL_RULE_MAX,
    TPL_SUMMARY_MAX,
)

_DANGEROUS = frozenset({"__proto__", "constructor", "prototype"})
_CODE_LIKE = ("<script", "javascript:", "data:text/html", "<iframe", "</")
_SAFE_INT_MAX = 9007199254740991

_TOP_KEYS = frozenset({"v", "id", "name", "summary", "lens_id", "brief_fields", "phases", "task_types", "granularity", "memory_sections", "hash"})
_REQUIRED_TOP = frozenset({"v", "id", "name", "summary", "brief_fields", "phases", "task_types", "granularity", "memory_sections"})


def _bad(msg: str = "") -> PlanError:
    return PlanError("bad_template", msg)


def _is_safe_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and abs(v) <= _SAFE_INT_MAX


def _has_control(s: str) -> bool:
    return any(ord(c) < 0x20 or ord(c) == 0x7F for c in s)


def _has_surrogate(s: str) -> bool:
    return any(0xD800 <= ord(c) <= 0xDFFF for c in s)


def _has_code_like(s: str) -> bool:
    low = s.lower()
    for token in _CODE_LIKE:
        if token in low:
            return True
    return False


def _check_string_safe(s: str):
    if _has_control(s):
        raise _bad("control char")
    if _has_surrogate(s):
        raise _bad("surrogate")
    if _has_code_like(s):
        raise _bad("code-like")


def _check_dangerous_and_keys(obj, seen=None):
    if seen is None:
        seen = set()
    if id(obj) in seen:
        raise _bad("cyclic")
    if isinstance(obj, dict):
        seen.add(id(obj))
        for k in obj.keys():
            if not isinstance(k, str):
                raise _bad("non-string key")
            if k in _DANGEROUS:
                raise _bad("dangerous key")
        for v in obj.values():
            _check_dangerous_and_keys(v, seen)
        seen.remove(id(obj))
    elif isinstance(obj, list):
        seen.add(id(obj))
        for v in obj:
            _check_dangerous_and_keys(v, seen)
        seen.remove(id(obj))


def _check_unknown_keys(obj: dict, allowed, what: str):
    for k in obj.keys():
        if k not in allowed:
            raise _bad(f"unknown {what} key {k!r}")


def _check_slug(s, max_len: int = 48):
    if not isinstance(s, str):
        raise _bad("slug type")
    _check_string_safe(s)
    if len(s) > max_len:
        raise _bad("slug length")
    if SLUG_RE.fullmatch(s) is None:
        raise _bad("slug format")


def _check_text(s, max_len: int, what: str):
    if not isinstance(s, str):
        raise _bad(f"{what} type")
    _check_string_safe(s)
    if len(s) > max_len:
        raise _bad(f"{what} length")


def canonical_template_json(tpl: dict) -> str:
    if not isinstance(tpl, dict):
        raise _bad("template must be object")
    copy_tpl = copy.deepcopy(tpl)
    copy_tpl.pop("hash", None)
    # Validate that it is JSON serializable; canonical form is sorted compact UTF-8.
    try:
        text = json.dumps(copy_tpl, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        text.encode("utf-8")  # reject lone surrogates / unencodable strings
        return text
    except (TypeError, ValueError, UnicodeError) as e:
        raise _bad(str(e)) from e


def template_hash(tpl: dict) -> str:
    try:
        return hashlib.sha256(canonical_template_json(tpl).encode("utf-8")).hexdigest()
    except PlanError:
        raise
    except (TypeError, ValueError, UnicodeError) as e:
        raise _bad(str(e)) from e


def validate_template(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise _bad("template must be object")
    # Deep copy to avoid mutation; check cyclic/dangerous/unknown first
    try:
        working = copy.deepcopy(raw)
    except Exception as e:
        raise _bad(str(e)) from e

    _check_dangerous_and_keys(working) if isinstance(working, dict) else None
    # Unwrap if raw itself had cycle (deepcopy may preserve cycle) — detect via check above
    # Top-level keys
    _check_unknown_keys(working, _TOP_KEYS, "top")
    # Required presence
    for k in _REQUIRED_TOP:
        if k not in working:
            raise _bad(f"missing {k}")

    # v == 1 and int discipline
    v = working["v"]
    if not _is_safe_int(v) or v != 1:
        raise _bad("v")

    # id
    _check_slug(working["id"])
    # name/summary
    _check_text(working["name"], TPL_NAME_MAX, "name")
    _check_text(working["summary"], TPL_SUMMARY_MAX, "summary")
    # lens_id optional
    if "lens_id" in working:
        _check_slug(working["lens_id"], max_len=40)
    # hash optional: if present must be sha256 hex
    if "hash" in working:
        h = working["hash"]
        if not isinstance(h, str) or SHA256_RE.fullmatch(h) is None:
            raise _bad("hash format")
        _check_string_safe(h)

    # brief_fields
    bf = working["brief_fields"]
    if not isinstance(bf, list):
        raise _bad("brief_fields type")
    if len(bf) > BRIEF_FIELDS_MAX:
        raise _bad("brief_fields cap")
    brief_ids = set()
    for item in bf:
        if not isinstance(item, dict):
            raise _bad("brief_field type")
        _check_unknown_keys(item, {"id", "label", "required"}, "brief_field")
        if "id" not in item or "label" not in item or "required" not in item:
            raise _bad("brief_field missing")
        _check_slug(item["id"])
        if item["id"] in brief_ids:
            raise _bad("duplicate brief id")
        brief_ids.add(item["id"])
        _check_text(item["label"], TPL_LABEL_MAX, "label")
        if not isinstance(item["required"], bool):
            raise _bad("required bool")

    # phases
    ph = working["phases"]
    if not isinstance(ph, list):
        raise _bad("phases type")
    if not (1 <= len(ph) <= PHASES_MAX):
        raise _bad("phases cap")
    phase_ids = set()
    for item in ph:
        if not isinstance(item, dict):
            raise _bad("phase type")
        _check_unknown_keys(item, {"id", "label", "exit"}, "phase")
        if "id" not in item or "label" not in item or "exit" not in item:
            raise _bad("phase missing")
        _check_slug(item["id"])
        if item["id"] in phase_ids:
            raise _bad("duplicate phase id")
        phase_ids.add(item["id"])
        _check_text(item["label"], TPL_LABEL_MAX, "label")
        _check_text(item["exit"], TPL_EXIT_MAX, "exit")

    # task_types
    tt = working["task_types"]
    if not isinstance(tt, list):
        raise _bad("task_types type")
    if not (1 <= len(tt) <= TASK_TYPES_MAX):
        raise _bad("task_types cap")
    type_ids = set()
    for item in tt:
        if not isinstance(item, dict):
            raise _bad("task_type type")
        _check_unknown_keys(item, {"id", "label", "accept_required", "evidence_required", "micro_hints"}, "task_type")
        for req in ("id", "label", "accept_required", "evidence_required", "micro_hints"):
            if req not in item:
                raise _bad("task_type missing")
        _check_slug(item["id"])
        if item["id"] in type_ids:
            raise _bad("duplicate type id")
        type_ids.add(item["id"])
        _check_text(item["label"], TPL_LABEL_MAX, "label")
        if not isinstance(item["accept_required"], bool):
            raise _bad("accept_required bool")
        if not isinstance(item["evidence_required"], bool):
            raise _bad("evidence_required bool")
        hints = item["micro_hints"]
        if not isinstance(hints, list):
            raise _bad("micro_hints type")
        if len(hints) > 12:
            raise _bad("micro_hints cap")
        for h in hints:
            _check_text(h, 80, "hint")

    # granularity
    gran = working["granularity"]
    if not isinstance(gran, dict):
        raise _bad("granularity type")
    _check_unknown_keys(gran, {"tasks_max", "micro_min", "micro_max", "rule"}, "granularity")
    for req in ("tasks_max", "micro_min", "micro_max", "rule"):
        if req not in gran:
            raise _bad("granularity missing")
    for field in ("tasks_max", "micro_min", "micro_max"):
        if not _is_safe_int(gran[field]):
            raise _bad(f"{field} int")
    if not (1 <= gran["tasks_max"] <= 40):
        raise _bad("tasks_max bound")
    if not (1 <= gran["micro_min"] <= 12):
        raise _bad("micro_min bound")
    if not (1 <= gran["micro_max"] <= 12):
        raise _bad("micro_max bound")
    if gran["micro_min"] > gran["micro_max"]:
        raise _bad("micro bounds reversed")
    _check_text(gran["rule"], TPL_RULE_MAX, "rule")

    # memory_sections
    ms = working["memory_sections"]
    if not isinstance(ms, list):
        raise _bad("memory_sections type")
    if len(ms) > MEMORY_SECTIONS_MAX:
        raise _bad("memory_sections cap")
    sec_ids = set()
    for item in ms:
        if not isinstance(item, dict):
            raise _bad("memory_section type")
        _check_unknown_keys(item, {"id", "label", "required", "max_chars", "hint"}, "memory_section")
        for req in ("id", "label", "required", "max_chars", "hint"):
            if req not in item:
                raise _bad("memory_section missing")
        _check_slug(item["id"])
        if item["id"] in sec_ids:
            raise _bad("duplicate section id")
        sec_ids.add(item["id"])
        _check_text(item["label"], TPL_LABEL_MAX, "label")
        if not isinstance(item["required"], bool):
            raise _bad("required bool")
        if not _is_safe_int(item["max_chars"]):
            raise _bad("max_chars int")
        if not (1 <= item["max_chars"] <= MEMORY_CHARS_MAX):
            raise _bad("max_chars bound")
        _check_text(item["hint"], TPL_HINT_MAX, "hint")

    # Global string safety sweep: every string value already checked field-by-field,
    # but ensure IDs/hints etc were covered. No extra work needed.

    # Normalized copy: deep copy without hash, then compute hash
    normalized = copy.deepcopy(working)
    normalized.pop("hash", None)
    try:
        h = hashlib.sha256(json.dumps(normalized, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()
    except (TypeError, ValueError, UnicodeError) as e:
        raise _bad(str(e)) from e
    normalized["hash"] = h
    return normalized


def load_template(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except (OSError, UnicodeError) as e:
        raise _bad(str(e)) from e
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as e:
        raise _bad(str(e)) from e
    return validate_template(raw)


def resolve_template(template_id: str, templates) -> dict:
    try:
        return templates[template_id]
    except (KeyError, TypeError) as e:
        raise PlanError("unknown_template", f"unknown template {template_id!r}") from e
