"""U48 STUB (fail-first oracle). Frozen constants only; behaviour lands in the implementation unit.

Frozen by SPEC_U48 (v = 1). Public surface used by bridge/wall/model_relay.py and bridge/tests/models.
"""
import re

V = 1
MAX_FRAME = 65536
MAX_REQUEST_BODY = 49152          # 48 KiB serialized HTTP request body
MAX_REPLY_BYTES = 1 << 20         # 1 MiB
MAX_ENDPOINTS = 16
MAX_STORE_BYTES = 64 * 1024

TIMEOUT_PROBE_MS = 1500
TIMEOUT_LOCAL_GENERATE_MS = 30000
TIMEOUT_REMOTE_GENERATE_MS = 60000

FRAME_HELLO = "model_hello"
FRAME_LIST = "model_list"
FRAME_PROBE = "model_probe"
FRAME_HEALTH = "model_health"
FRAME_GENERATE = "model_generate"
FRAME_RESULT = "model_result"
FRAME_NACK = "model_nack"
FRAME_CANCEL = "model_cancel"

KIND_LOCAL = "local-openai-compatible"
KIND_REMOTE = "remote-openai-compatible"
KINDS = (KIND_LOCAL, KIND_REMOTE)
TIERS = ("private", "standard", "shared")
ROLES = ("system", "user", "assistant")
HEALTH_STATES = ("available", "needs_setup", "offline", "blocked")

NACK_CODES = (
    "unknown_endpoint", "needs_setup", "policy", "busy", "too_large", "not_loopback", "redirect",
    "timeout", "offline", "auth", "rate_limited", "rung_unsupported", "http_error", "bad_reply",
    "reply_too_large", "cancelled",
)

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
RID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
