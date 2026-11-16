"""Independent public-shape builders, fixed timestamps, no filesystem writes."""
import copy
import json
import unittest
from pathlib import Path
from bridge.plan.errors import PlanError
from bridge.plan.fold import apply_op_event, empty_projection, fold_plan

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "fixtures" / "plan"
BASE_TS = 1700000000000

def template():
    return json.loads((FIXTURES / "templates.v1.json").read_text(encoding="utf-8"))["templates"][0]

def templates():
    t = template()
    return {t["id"]: t}

def event(n, op=None, *, agent="alice", ts=None, **extra):
    e = {"id": "e-%016x" % n, "lamport": n, "ts": BASE_TS+n if ts is None else ts,
         "room": "oracle", "agent": agent, "act": "op", "text": ""}
    if op is not None:
        e["op"] = copy.deepcopy(op)
    e.update(extra)
    return e

def opening():
    return {"kind":"plan.open", "title":"Plan", "template_id":"neutral",
            "template_hash":template()["hash"], "brief":{"goal":"Deliver"}, "phase":"start"}

def adding(**kw):
    op = {"kind":"task.add", "title":"Action", "type":"action", "phase":"start"}
    op.update(kw)
    return op

def empty_expected():
    return {"plan":None,"tasks":[],"memory":{},"archived_plans":[],
            "rollup":{"tasks_total":0,"tasks_done":0,"tasks_blocked":0,"tasks_ready":0,
                      "micro_total":0,"micro_done":0,"progress":0.0,"progress_pct":0},
            "replayed_ops":{},"rejected":[],"last_lamport":0}

def plan_expected():
    s=empty_expected()
    o=opening()
    s["plan"]={"id":"p1","title":"Plan","template_id":"neutral","template_hash":o["template_hash"],
               "brief":{"goal":"Deliver"},"phase":"start","state":"active","rev":1,
               "opened_lamport":1,"opened_ts":BASE_TS+1,"closed_outcome":None}
    s["last_lamport"]=1
    return s

def task_expected(n=2, tid="T01", **kw):
    t={"id":tid,"title":"Action","type":"action","phase":"start","accept":"", "deps":[],
       "assignee":None,"claim_lamport":None,"claim_ts":None,"estimate":None,"rev":n,
       "explicit_state":None,"blocked_reason":None,"state":"pending","ready":True,"microtasks":[]}
    t.update(kw)
    return t

def micro_expected(n=3, mid="T01.M01", **kw):
    m={"id":mid,"text":"Step","accept":"","state":"pending","outcome":None,"took":None,"evidence":[],"rev":n}
    m.update(kw)
    return m

class OracleCase(unittest.TestCase):
    def assertCode(self, code, fn, *args, **kwargs):
        with self.assertRaises(PlanError) as cm:
            fn(*args, **kwargs)
        self.assertEqual(cm.exception.code, code)

    def start(self, *ops):
        return fold_plan([event(1,opening())]+[event(i+2,op) for i,op in enumerate(ops)], templates=templates())

    def apply(self, s, n, op, **kw):
        return apply_op_event(s,event(n,op,**kw),templates=templates())
