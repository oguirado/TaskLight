import copy
import json
import random
import unittest
from bridge.plan.fold import fold_plan
from .support import (PUBLIC,TEMPLATES,MANDATORY,ALPHABET,digest,event,opening,adding,
                      history,invariant,shrink,ownership_prerequisites,first_difference)
from .mutations import assess,tie_mutant,ownership_mutant,record

VECTORS=json.loads((PUBLIC/'vectors.baseline.json').read_text())['cases']


class FrozenVectors(unittest.TestCase):
    def test_shared_frozen_vectors_and_input_immutability(self):
        for case in VECTORS:
            with self.subTest(case=case['id']):
                before=copy.deepcopy(case)
                p=fold_plan(case['events'],templates=case['templates'])
                self.assertEqual(p,case['expected_projection'])
                self.assertEqual(p['rejected'],case['expected_rejected'])
                self.assertEqual(case,before)

    def test_both_adapters_agreeing_on_a_wrong_projection_does_not_pass(self):
        case=next(c for c in VECTORS if c['id']=='equal_lamport_reverse_id')
        wrong=copy.deepcopy(case['expected_projection'])
        wrong['tasks']=[]
        python_adapter=lambda _: wrong
        typescript_adapter=lambda _: wrong
        self.assertEqual(python_adapter(case),typescript_adapter(case))
        with self.assertRaises(AssertionError):
            self.assertEqual(python_adapter(case),case['expected_projection'])

    def test_ties_and_identical_duplicates_preserve_every_projection_field(self):
        case=next(c for c in VECTORS if c['id']=='equal_lamport_reverse_id')
        for duplicate in case['events']:
            for events in (case['events']+[duplicate],list(reversed(case['events']+[duplicate]))):
                self.assertEqual(fold_plan(events,templates=case['templates']),case['expected_projection'])

    def test_null_missing_and_array_order_are_not_normalized_away(self):
        self.assertEqual(first_difference({}, {'a':None}),'$.a')
        self.assertEqual(first_difference([1,2],[2,1]),'$[0]')
        self.assertEqual(first_difference({'b':1,'a':2},{'a':2,'b':1}),None)
        self.assertNotEqual(digest({'a':None}),digest({}))


class GeneratedHistories(unittest.TestCase):
    def test_seeds_and_reserved_alphabet(self):
        self.assertIn('agent.lifecycle',ALPHABET)
        self.assertEqual(len(MANDATORY),26)
        for seed in range(100):
            self.assertEqual(digest(history(seed)),digest(history(seed)))
            self.assertEqual(len(history(seed)),128)
        self.assertNotEqual(digest(history(0)),digest(history(1)))

    def test_mandatory_transitions_have_semantic_witnesses(self):
        events=history(0)
        p=[fold_plan(events[:i],templates=TEMPLATES) for i in range(30)]
        visited=set()
        self.assertEqual(p[1]['plan']['state'],'active');visited.add('open')
        self.assertEqual(len(p[3]['tasks']),2);visited.add('add')
        self.assertEqual(p[4]['tasks'][0]['assignee'],'alice');visited.add('claim')
        self.assertEqual(p[5]['tasks'][0]['state'],'active');visited.add('activate')
        self.assertEqual(p[6]['rejected'][-1]['code'],'claimed_by_other');visited.add('foreign_write_rejected')
        self.assertEqual(p[7]['tasks'][0]['microtasks'][0]['live']['run_id'],'r1');visited.add('beat')
        self.assertEqual(p[9]['tasks'][0]['microtasks'][0]['live']['run_id'],'r2');visited.add('retired_beat')
        self.assertIsNone(p[10]['tasks'][0]['assignee']);visited.add('release')
        self.assertEqual(p[11]['tasks'][0]['assignee'],'alice');visited.add('reclaim')
        self.assertEqual(p[12]['memory']['notes']['text'],'Remember');visited.add('memory')
        self.assertEqual(p[12],p[13]);visited.add('room_traffic')
        self.assertEqual(p[14]['tasks'],p[13]['tasks']);self.assertEqual(p[14]['replayed_ops'],p[13]['replayed_ops']);visited.add('retry')
        self.assertEqual(p[15]['rejected'][-1]['code'],'claimed_by_other');visited.add('takeover_boundary_rejected')
        self.assertEqual(p[16]['tasks'][0]['assignee'],'bob');visited.add('takeover_after_boundary')
        self.assertEqual(p[17]['tasks'][0]['state'],'cancelled');visited.add('cancel')
        self.assertTrue(p[17]['tasks'][1]['ready']);visited.add('cancel_satisfies_dependency')
        self.assertEqual(p[20]['tasks'][1]['state'],'done');visited.add('complete')
        self.assertEqual(p[21]['plan']['state'],'closed');self.assertEqual(p[21]['archived_plans'][0]['tasks_done'],1);visited.add('close')
        self.assertEqual(p[22]['tasks'],[]);visited.add('reopen')
        self.assertEqual(p[22]['memory'],p[12]['memory']);visited.add('memory_survives_reopen')
        self.assertEqual(p[24],p[23]);visited.add('duplicate')
        self.assertEqual(p[25]['rejected'][-1]['code'],'bad_op');visited.add('reserved_lifecycle')
        self.assertEqual(p[26],p[25]);visited.add('hostile_lamport')
        self.assertEqual(events[26]['lamport'],events[27]['lamport']);self.assertGreater(events[26]['id'],events[27]['id']);visited.update(('equal_lamport','arrival_reordering'))
        reloaded=json.loads(json.dumps(events))
        self.assertEqual(fold_plan(reloaded,templates=TEMPLATES),fold_plan(events,templates=TEMPLATES));visited.add('restart')
        self.assertEqual(visited,MANDATORY,'unvisited transitions cannot pass')
        target=PUBLIC/'artifacts';target.mkdir(exist_ok=True)
        (target/'coverage.json').write_text(json.dumps(dict(stage='baseline',exercised=sorted(visited),unvisited=sorted(MANDATORY-visited)),indent=2)+'\n')

    def test_all_prefix_invariants_permutation_and_duplicate_metamorphisms(self):
        for seed in range(4):
            events=history(seed)
            before=copy.deepcopy((events,TEMPLATES))
            for i in range(len(events)+1):
                invariant(events[:i],fold_plan(events[:i],templates=TEMPLATES))
            expected=fold_plan(events,templates=TEMPLATES)
            shuffled=copy.deepcopy(events);random.Random(seed).shuffle(shuffled)
            self.assertEqual(fold_plan(shuffled,templates=TEMPLATES),expected)
            self.assertEqual(fold_plan(events+events[:8],templates=TEMPLATES),expected)
            self.assertEqual((events,TEMPLATES),before)

    def test_conflicting_same_event_id_has_no_permutation_guarantee(self):
        a=event(1,opening());b=copy.deepcopy(a);b['op']['title']='Different'
        self.assertNotEqual(fold_plan([a,b],templates=TEMPLATES),fold_plan([b,a],templates=TEMPLATES))

    def test_planted_ownership_bug_shrinks_with_prerequisites(self):
        original=history(42)[:6]
        mutant=ownership_mutant()
        def fails(events):
            if not ownership_prerequisites(events):
                return False
            p=mutant.fold_plan(events,templates=TEMPLATES)
            return bool(p['tasks']) and p['tasks'][0]['microtasks'][0]['state']=='done' and not any(r['code']=='claimed_by_other' for r in p['rejected'])
        minimized=shrink(original,fails,ownership_prerequisites)
        self.assertEqual(minimized,shrink(original,fails,ownership_prerequisites))
        self.assertLess(len(minimized),len(original))
        self.assertTrue(any(e.get('op',{}).get('title')=='x' for e in minimized),'field simplification must be witnessed')
        self.assertTrue(ownership_prerequisites(minimized));self.assertTrue(fails(minimized))
        good=fold_plan(minimized,templates=TEMPLATES)
        bad=mutant.fold_plan(minimized,templates=TEMPLATES)
        difference=first_difference(good,bad)
        self.assertIsNotNone(difference)
        self.assertTrue(mutant._mutation_activated)
        with self.assertRaises(AssertionError):
            self.assertEqual(bad['tasks'],good['tasks'])
        record(dict(id='ignore-ownership-control',applied=1,activated=1,detected=1,infrastructure_failures=[]))
        target=PUBLIC/'artifacts';target.mkdir(exist_ok=True)
        (target/'shrink-control.json').write_text(json.dumps(dict(kind='deliberate_negative_control',seed=42,original=original,minimized=minimized,first_difference=difference),indent=2)+'\n')


class MutationControls(unittest.TestCase):
    def test_tie_breaker_has_an_activated_semantic_detection(self):
        case=next(c for c in VECTORS if c['id']=='equal_lamport_reverse_id')
        def activate(m):
            value=m.fold_plan(case['events'],templates=case['templates'])
            return value,m._mutation_activated
        result=assess('remove-id-order-python',tie_mutant,activate,
                      lambda value:self.assertEqual(value,case['expected_projection']))
        self.assertEqual((result['applied'],result['activated'],result['detected']),(1,1,1))
        self.assertEqual(result['infrastructure_failures'],[])
        record(result)

    def test_import_crash_patch_miss_timeout_and_inactive_target_are_not_detections(self):
        def crash():raise ImportError('deliberate runner failure')
        def timeout():raise TimeoutError('deliberate timeout')
        def miss():raise RuntimeError('patch miss')
        controls=[]
        for apply in (crash,timeout,miss,lambda:object()):
            r=assess('infrastructure-control',apply,lambda _:({},False),lambda _:self.fail('must not count'))
            self.assertEqual(r['detected'],0)
            self.assertTrue(r['infrastructure_failures'])
            controls.append(r)
        target=PUBLIC/'artifacts';target.mkdir(exist_ok=True)
        (target/'infrastructure-controls.json').write_text(json.dumps(controls,indent=2)+'\n')
