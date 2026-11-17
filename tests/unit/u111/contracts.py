"""Text oracles for the public U111 contract; no product replacements."""
import json
import re

RESERVED = ("work_acquire", "work_report", "agent_lifecycle")
# Public product spellings, not an assumption about the deploying harness.
PRODUCTS = ("Claude Code", "Codex", "Cursor", "GitHub Copilot", "Windsurf",
            "Cline", "Aider", "OpenCode", "Gemini CLI", "Continue.dev")


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def has(text, pattern, message):
    require(re.search(pattern, text, re.I | re.S) is not None, message)


def passive(text):
    """Accept the existing serializer/fence contract, independent of payload keys."""
    blocks = list(re.finditer(r"^```untrusted\n(.*?)\n```[ \t]*$", text, re.M | re.S))
    require(bool(blocks), "serialized passive-data fence missing")
    payloads = []
    for block in blocks:
        raw = block.group(1)
        require("</untrusted>" not in raw, "closing untrusted tag must be escaped")
        require(not re.search(r"^```", raw, re.M), "data must not terminate a fence")
        try:
            payloads.append(json.loads(raw))
        except (ValueError, TypeError) as exc:
            raise AssertionError("passive fence must contain serialized JSON") from exc
    outside = re.sub(r"^```untrusted\n.*?\n```[ \t]*$", "", text, flags=re.M | re.S)
    has(outside, r"(?:do not|don't|never|must not)[^.\n]*(?:follow|obey|execute)[^.\n]*(?:inside|within|fenc|data|untrusted)",
        "instruction region must prohibit following directives inside passive data")
    return outside, payloads


def contains(value, expected):
    if value == expected:
        return True
    if isinstance(value, dict):
        return any(contains(v, expected) for v in value.values())
    if isinstance(value, list):
        return any(contains(v, expected) for v in value)
    return False


def fenced_values(text, args, template=None):
    outside, payloads = passive(text)
    for key, value in args.items():
        require(any(contains(p, value) for p in payloads), "argument %s missing from serialized data" % key)
        # Whole identifiers only: 'room' in the name room_send is not interpolation.
        require(re.search(r"(?<![\w.-])" + re.escape(value) + r"(?![\w.-])", outside) is None,
                "argument %s interpolated into instructions" % key)
    if template is not None:
        require(any(contains(p, template) for p in payloads), "embedded template fields must remain serialized passive data")
    return outside


def identity(text):
    has(text, r"run_id", "run_id missing")
    has(text, r"(?:fresh|new|generat)[^.\n]{0,100}run_id|run_id[^.\n]{0,100}(?:fresh|new|generat)", "generate a fresh run_id for a new attempt")
    has(text, r"(?:per|each|every|for (?:an?|each))[^.\n]{0,55}attempt|attempt[^.\n]{0,55}(?:run_id|fresh|new)",
        "run_id must be fresh per execution attempt, not per beat")
    has(text, r"(?:reus\w*|same|stable|unchanged)[^.\n]{0,100}(?:run_id|beat|attempt)|run_id[^.\n]{0,100}(?:reus\w*|same|stable|unchanged)",
        "the same run_id must be reused across attempt beats")
    require(not re.search(r"(?:every|each)[^.\n]{0,20}beat[^.\n]{0,40}(?:fresh|new)\s+run_id|every\s+30\s*s[^.\n]{0,30}(?:fresh|new)\s+run_id", text, re.I),
            "fresh run_id per beat is forbidden")


def release(text):
    require("task_release" in text, "handoff must name task_release")
    require(not re.search(r"\b(?:with|call|tool|using)\s+[`\"']?release\b", text, re.I),
            "nonexistent release tool advertised")


def executor(text):
    has(text, r"planning[ _-]contract|tasklight://contract", "read the planning contract")
    for token in ("next_work", "task_claim", "microtask_set"):
        require(token in text, "executor must use " + token)
    has(text, r"next_work.*?task_claim.*?microtask_set", "eligible selection must precede claim and activation")
    has(text, r"target|task_id", "optional target selection must retain eligibility and ownership")
    has(text, r"eligib|ready work|ready task", "eligibility must not be bypassed")
    has(text, r"owner|assignee|claimed_by_other", "ownership must not be bypassed")
    has(text, r"coarse", "use coarse microtasks")
    has(text, r"boundar", "report progress at microtask boundaries")
    for token in ("outcome", "evidence", "activity_beat", "tools/list"):
        require(token in text, "executor guidance missing " + token)
    has(text, r"30\s*(?:s\b|sec|second)", "beat every 30 seconds")
    has(text, r"skip[^.\n]*(?:beat|activity_beat)|(?:unavailable|absent|missing)[^.\n]*skip", "skip unavailable activity_beat after discovery")
    has(text, r"liveness|periodic|heartbeat", "liveness is an exception to boundary reporting")
    has(text, r"(?:human|operator)[^.\n]{0,180}harness|harness[^.\n]{0,180}(?:human|operator)", "route human questions through the harness")
    has(text, r"addressed|\bto\b", "human questions must use addressed room messages")
    identity(text)
    release(text)


def coordinator(text):
    has(text, r"harness", "address the harness role")
    for token in ("plan_create", "assignee", "plan_get", "plan_check", "read_inbox"):
        require(token in text, "coordinator guidance missing " + token)
    has(text, r"planning[ _-]contract|tasklight://contract", "read the planning contract")
    has(text, r"template", "read the template")
    has(text, r"dependenc", "dependency-ordered shared plan")
    has(text, r"coarse", "coarse microtasks")
    has(text, r"(?:distinct|unique|different)[^.\n]{0,80}(?:slug|executor|agent)", "distinct executor slugs")
    has(text, r"disjoint|non.overlap", "externally enforced disjoint write surfaces")
    has(text, r"external|harness.{0,80}(?:enforce|write|file)", "write isolation belongs to the harness")
    has(text, r"room_events|event(?:s| cursor| reads)", "reconcile event and inbox reads")
    has(text, r"reconcil", "reconcile shared state")
    has(text, r"address|room_send", "route addressed messages through rooms")
    has(text, r"(?:hook[^.\n]{0,100}lifecycl|lifecycl[^.\n]{0,100}hook)", "hooks own lifecycle recording")
    has(text, r"(?:do not|never|must not|not)[^.\n]{0,100}(?:announce|deployment|exit)|executors[^.\n]{0,100}(?:do not|never)",
        "executors must not announce deployment or exit")
    # Look for an ordered workflow, allowing an introductory description of deployment.
    has(text, r"(?:contract|template).*?plan_create.*?(?:deploy|launch|start)[^.\n]{0,120}(?:harness|external)|(?:contract|template).*?plan_create.*?(?:harness|external)[^.\n]{0,120}(?:deploy|launch|start)",
        "assign assignees during plan_create before external deployment")
    has(text, r"assignee[^.\n]{0,150}plan_create|plan_create[^.\n]{0,150}assignee", "assignees belong in plan_create")
    require(not re.search(r"TaskLight\s+(?:(?:can|will)\s+)?(?:launches?\b|deploys?\b|authenticates?\b|enforces?\s+(?:file|write)\s+ownership)", text, re.I), "TaskLight must not claim deployment, file ownership enforcement or authentication")


def protocol(text):
    text = text.replace("`", "")
    for token in ("room_send", "room", "agent", "to", "act", "text", "re", "evidence", "op_id",
                  "ok", "id", "lamport", "question", "answer", "handoff", "ack", "untrusted",
                  "claimed_by_other", "not_conformant", "detail", "stale_rev", "claim_lamport"):
        require(re.search(r"\b" + token + r"\b", text) is not None, "protocol guidance missing " + token)
    has(text, r"agent\s*(?:==|=|must (?:equal|match))\s*(?:target[.'\"\[\]]*to|(?:the )?(?:target|original|addressed)[^.\n]{0,30}(?:recipient|to))|(?:ack|answer)[^.\n]{0,160}(?:recipient|target\.to)",
        "ack/answer sender must equal the addressed target.to")
    for key in ("re", "evidence", "op_id"):
        has(text, r"\b" + key + r"\?|optional[^.\n]{0,140}\b" + key + r"\b|\b" + key + r"\b[^.\n]{0,140}optional",
            key + " must be optional in room_send")
    has(text, r"\{(?=[^{}]*\bok\b)(?=[^{}]*\bid\b)(?=[^{}]*\blamport\b)[^{}]*\}",
        "room_send must describe the ok/id/lamport result shape")
    has(text, r"sha256", "evidence must contain path/sha256 objects")
    has(text, r"\bpath\b", "evidence must contain paths")
    has(text, r"array|list|\[\s*\{", "evidence is an array of objects")
    has(text, r"(?:ack|acknowledg)[^.\n]{0,160}(?:question|handoff)|(?:question|handoff)[^.\n]{0,160}(?:ack|acknowledg)", "acknowledge questions and handoffs")
    has(text, r"\bre\b[^.\n]{0,150}(?:id|referenc)|(?:id|referenc)[^.\n]{0,150}\bre\b", "re must reference the original message id")
    has(text, r"(?:persist|inbox)[^.\n]{0,160}(?:not|never|no proof)|(?:not|never)[^.\n]{0,160}(?:receipt|application|applied)", "persistence/inbox reads do not prove receipt/application")
    has(text, r"(?:same|stable|reus)[^.\n]{0,100}op_id|op_id[^.\n]{0,100}(?:same|stable|reus)", "same-action retries require stable op_id")
    has(text, r"stale_rev[^.\n]{0,180}(?:reread|re.read|read again)|(?:reread|re.read)[^.\n]{0,180}stale_rev", "reread on stale_rev")
    has(text, r"same[ -]action|same[^.\n]{0,50}(?:action|operation)", "op_id reuse is restricted to retries of the same action")
    has(text, r"reconcil", "reconcile before retrying")
    has(text, r"(?:never|do not|must not)[^.\n]{0,80}guess", "do not guess revisions")
    for term in ("U109", "U110", "ownership", "dependenc", "close", "optional"):
        has(text, term, "target protocol qualification missing " + term)
    has(text, r"target|after.{0,50}freez|not.{0,50}(?:I0|guarantee)", "target gates must not be advertised as I0 guarantees")
    has(text, r"(?:never|do not|must not)[^.\n]{0,100}(?:auto.cancel|cancel)[^.\n]{0,100}(?:prerequisit|dependenc)|(?:prerequisit|dependenc)[^.\n]{0,100}(?:never|must not)[^.\n]{0,50}cancel", "never auto-cancel blocked prerequisites")
    if re.search(r"\bverdict\b", text, re.I):
        has(text, r"(?:not|never|exclude|forbid|no|disallow)[^.\n]{0,60}\bverdict\b|\bverdict\b[^.\n]{0,60}(?:not allowed|forbidden|excluded)", "verdict must not be a permitted act")


def exclusions(text, *, u120=False):
    # A-U120c: U120 M7 requires these prompt identifiers; the U111 guide is unchanged.
    if u120:
        for token in RESERVED:
            require(token in text, "U120 M7 guidance missing " + token)
        # A-U120c: U120 M8 requires the exact caller-asserted session-pin notice.
        require("The session pin prevents accidental cross-agent calls. It is not authentication. "
                "Agent identity remains caller-asserted within the same-user CW_HOME boundary." in text,
                "U120 M8 session-pin trust wording missing")
    for token in (PRODUCTS if u120 else RESERVED + PRODUCTS):
        require(re.search(r"(?<!\w)" + re.escape(token) + r"(?!\w)", text, re.I) is None,
                "reserved identifier or named harness product: " + token)
    require(not re.search(r"/(?:home|Users)/|\b[A-Za-z]:\\Users\\", text), "local operator path leaked")
    require(not re.search(r"(?:https?|wss?)://(?:localhost|127\.0\.0\.1|0\.0\.0\.0)|\bsk-[A-Za-z0-9]{16,}", text),
            "local endpoint or key leaked")
