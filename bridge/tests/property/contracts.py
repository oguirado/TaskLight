"""Fail-first gate contract. Baseline compatibility is kept in separate vectors."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from bridge.plan.fold import fold_plan
from bridge.room import app,store
from .support import PUBLIC,TEMPLATE,TEMPLATES,BASE,event,opening,adding
from .transport import call


def stage_status():
    contract=json.loads((PUBLIC/'contracts.json').read_text())
    p=fold_plan([event(1,opening()),event(2,adding()),
                 event(3,dict(kind='micro.set',micro_id='T01.M01',state='active'))],templates=TEMPLATES)
    gates=bool(p['rejected']) and p['rejected'][-1]['code']=='not_conformant'
    return {
        'baseline':dict(status='AVAILABLE'),
        'gates':dict(status='AVAILABLE' if gates else 'BLOCKED',reason=None if gates else 'U109 gate precondition not met: unassigned activation is accepted'),
        'cache':dict(status='BLOCKED',reason=contract['cache']['reason']),
        'lifecycle':dict(status='BLOCKED',reason=contract['lifecycle']['reason'],
                         tool_present='agent_lifecycle' in app.tool_names())}


class GateContracts(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory(prefix='gates-',dir=Path(__file__).parent)
        self.addCleanup(temporary.cleanup)
        self.folder=Path(temporary.name)
        self.homes={a:self.folder/a for a in ('mcp','cli','dispatch')}
        for home in self.homes.values():
            (home/'templates').mkdir(parents=True)
            (home/'templates'/('neutral.json')).write_text(json.dumps(TEMPLATE))
            for n,op in enumerate((opening(),adding(),adding(deps=['T01'])),1):
                store.post('oracle','alice','op','',op=op,home=home,clock=lambda:BASE+n,templates=TEMPLATES)

    def raw(self,home):
        return (home/'rooms/oracle/events.jsonl').read_bytes()

    def projections(self):
        return {a:fold_plan(store._parse_events_bytes(self.raw(h))[0],templates=TEMPLATES) for a,h in self.homes.items()}

    def equivalent(self,tool,fields,code=None):
        values=[]
        for adapter,home in self.homes.items():
            before=self.raw(home)
            value=call(adapter,home,tool,dict(room='oracle',agent='alice',**fields))
            if code:
                self.assertIs(value.get('ok'),False)
                self.assertEqual(value.get('code'),code)
                self.assertIsInstance(value.get('detail'),str);self.assertTrue(value['detail'])
                self.assertEqual(self.raw(home),before,'domain rejection appended bytes')
                values.append(value)
            else:
                self.assertIn('untrusted',value)
        if code:
            self.assertEqual(values[0],values[1]);self.assertEqual(values[1],values[2])

    def test_foreign_writer_unassigned_and_dependency_blocked(self):
        for state in ('active','done'):
            self.equivalent('microtask_set',dict(id='T01.M01',state=state),'not_conformant')
        self.equivalent('task_claim',dict(task_id='T02'))
        for state in ('active','done'):
            self.equivalent('microtask_set',dict(id='T02.M01',state=state),'not_conformant')
        for adapter,home in self.homes.items():
            before=self.raw(home)
            value=call(adapter,home,'microtask_set',dict(room='oracle',agent='bob',id='T02.M01',state='active'))
            self.assertEqual(value['code'],'claimed_by_other');self.assertTrue(value['detail'])
            self.assertEqual(self.raw(home),before)

    def test_optional_stale_claim_fence_and_release_reset(self):
        self.equivalent('task_claim',dict(task_id='T01'))
        claim=next(iter(self.projections().values()))['tasks'][0]['claim_lamport']
        self.equivalent('microtask_set',dict(id='T01.M01',state='active',claim_lamport=claim-1),'stale_rev')
        self.equivalent('microtask_set',dict(id='T01.M01',state='active',claim_lamport=claim))
        self.equivalent('task_release',dict(task_id='T01'))
        for p in self.projections().values():
            self.assertIsNone(p['tasks'][0]['assignee'])
            self.assertEqual(p['tasks'][0]['microtasks'][0]['state'],'pending')

    def test_premature_close_rejected_cancellation_allows_closure(self):
        self.equivalent('plan_close',dict(base_rev=1),'not_conformant')
        for tid,rev in (('T01',2),('T02',3)):
            self.equivalent('task_update',dict(task_id=tid,base_rev=rev,state='cancelled'))
        self.equivalent('plan_close',dict(base_rev=1,outcome='Cancelled unfinished work'))
        for p in self.projections().values():
            self.assertEqual(p['plan']['state'],'closed')
            self.assertEqual(p['rollup']['tasks_done'],0)

    def test_permissive_baseline_control_fails_gate_oracle(self):
        # Explicit permissive control: an accepted response cannot satisfy the gate.
        permissive={'untrusted':{'rev':4}}
        with self.assertRaises(AssertionError):
            self.assertEqual(permissive.get('code'),'not_conformant')
