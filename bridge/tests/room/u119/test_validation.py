"""M9 and Amendment B error mapping; every rejection preserves the journal."""
import copy
from bridge.plan.limits import EVIDENCE_MAX, MICRO_MAX, OUTCOME_MAX, TOOK_MAX
from .support import WorkCase


class ValidationOracle(WorkCase):
    pass


def acquire_case(name, transform, code):
    def test(self):
        self.make_plan()
        args = transform(dict(room="demo", agent="alice"))
        self.deny("work_acquire", args, code)
    test.__name__ = "test_m9_acquire_" + name
    setattr(ValidationOracle, test.__name__, test)


def report_case(name, transform, code):
    def test(self):
        self.make_plan(count=2, micros=MICRO_MAX)
        self.claim(); self.micro(state="active")
        args = transform(self, self.report_args())
        self.deny("work_report", args, code)
    test.__name__ = "test_a5_report_" + name
    setattr(ValidationOracle, test.__name__, test)


def without(args, key):
    return {k: v for k, v in args.items() if k != key}


def field(key, value):
    return lambda args: dict(args, **{key: copy.deepcopy(value)})


def nested(key, value):
    def change(case, args):
        args["done"][0][key] = copy.deepcopy(value)
        return args
    return change


for name, value in (("null_args", None), ("array_args", []), ("string_args", "x"),
                    ("boolean_args", True), ("integer_args", 1), ("tuple_args", ())):
    acquire_case(name, lambda args, value=value: value, "bad_args")
    report_case(name, lambda case, args, value=value: value, "bad_args")
for key in ("room", "agent"):
    acquire_case("missing_" + key, lambda args, key=key: without(args, key), "bad_args")
for key in ("room", "agent", "task_id", "claim_lamport", "done"):
    report_case("missing_" + key, lambda case, args, key=key: without(args, key), "bad_args")
for key in ("takeover", "strict", "base_rev"):
    acquire_case("extra_" + key, field(key, True), "bad_args")
    report_case("extra_" + key, lambda case, args, key=key: dict(args, **{key: True}), "bad_args")
for name, key, value, code in (
    ("bad_room", "room", "../demo", "bad_room"),
    ("bad_agent", "agent", "bad agent", "bad_agent"),
    ("bad_op_id", "op_id", "bad!", "bad_op"),
    ("short_op_id", "op_id", "short", "bad_op"),
    ("long_op_id", "op_id", "x" * 65, "bad_op"),
):
    acquire_case(name, field(key, value), code)
    report_case(name, lambda case, args, key=key, value=value: dict(args, **{key: value}), code)
for name, value, code in (("malformed_preference", "T1", "bad_op"),
                           ("number_preference", 1, "bad_args"),
                           ("null_preference", None, "bad_args")):
    acquire_case(name, field("prefer_task", value), code)
for name, value in (("true_fence", True), ("false_fence", False), ("zero_fence", 0),
                    ("negative_fence", -1), ("float_fence", 1.0), ("text_fence", "1"),
                    ("unsafe_fence", 2**53), ("null_fence", None),
                    ("infinite_fence", float("inf")), ("nan_fence", float("nan"))):
    report_case(name, lambda case, args, value=value: dict(args, claim_lamport=value), "bad_args")
for name, value in (("empty_done", []), ("null_done", None), ("object_done", {}),
                    ("text_done", "T01.M01"), ("nonobject_member", ["T01.M01"]),
                    ("null_member", [None]), ("list_member", [[]]), ("boolean_member", [True]),
                    ("tuple_done", ()), ("boolean_done", True)):
    report_case(name, lambda case, args, value=value: dict(args, done=copy.deepcopy(value)), "bad_args")
report_case("duplicate_done", lambda case, args: dict(args, done=args["done"] * 2), "bad_args")
report_case("oversized_done", lambda case, args: dict(args, done=[case.completion("T01.M%02d" % i)
    for i in range(1, MICRO_MAX + 1)] + [case.completion("T02.M01")]), "bad_args")
report_case("malformed_task_id", lambda case, args: dict(args, task_id="T1"), "bad_op")
report_case("malformed_micro_id", nested("id", "T01.M1"), "bad_op")
report_case("unknown_member_key", nested("takeover", True), "bad_args")
for key in ("id", "outcome", "evidence"):
    report_case("missing_member_" + key, lambda case, args, key=key: dict(args,
        done=[without(args["done"][0], key)]), "bad_args")
for key, value in (("id", []), ("outcome", 1), ("outcome", None), ("took", 1), ("took", None)):
    report_case("wrong_type_" + key + "_" + type(value).__name__, nested(key, value), "bad_args")
report_case("oversized_outcome", nested("outcome", "x" * (OUTCOME_MAX + 1)), "limit_exceeded")
report_case("oversized_took", nested("took", "x" * (TOOK_MAX + 1)), "limit_exceeded")
# A-U164r1: empty completion evidence reaches required-evidence admission.
report_case("empty_evidence", nested("evidence", []), "missing_evidence")
for name, value in (("null_evidence", None), ("object_evidence", {}),
                    ("tuple_evidence", ()),
                    ("string_evidence", "proof.txt"), ("relative_evidence", ["proof.txt"]),
                    ("traversal_evidence", ["../x"]), ("number_evidence", [7]),
                    ("digest_object_evidence", [{"path": "proof.txt", "sha256": "0" * 64}])):
    report_case(name, nested("evidence", value), "bad_evidence")
report_case("oversized_evidence", lambda case, args: dict(args,
    done=[case.completion(evidence=[str(case.proof)] * (EVIDENCE_MAX + 1))]), "bad_evidence")
