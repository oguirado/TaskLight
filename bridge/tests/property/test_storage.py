import copy
import errno
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from bridge.plan.fold import fold_plan
from bridge.room import store
from .support import PUBLIC,TEMPLATE,TEMPLATES,BASE,opening,adding
from .transport import call
from .mutations import record


class StorageProperties(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory(prefix='scratch-',dir=Path(__file__).parent)
        self.addCleanup(temporary.cleanup)
        self.home=Path(temporary.name)
        self.env=patch.dict(os.environ,{'CW_HOME':str(self.home)})
        self.env.start();self.addCleanup(self.env.stop)
        templates=self.home/'templates';templates.mkdir()
        (templates/(TEMPLATE['id']+'.json')).write_text(json.dumps(TEMPLATE))
        self.n=0

    def post(self,op,agent='alice'):
        self.n+=1
        return store.post('oracle',agent,'op','',op=op,clock=lambda:BASE+self.n,templates=TEMPLATES)

    def bytes(self):
        path=self.home/'rooms/oracle/events.jsonl'
        return path.read_bytes() if path.exists() else b''

    def setup_plan(self):
        self.post(opening());self.post(adding())

    def test_lost_reply_identical_retry_and_restart_use_actual_journal(self):
        self.setup_plan()
        op=dict(kind='task.claim',task_id='T01',op_id='claim-retry')
        receipt=self.post(op)
        before=self.bytes()
        # The caller discarded receipt; retry goes through storage, not a fold cache.
        retry=self.post(copy.deepcopy(op))
        self.assertTrue(retry.pop('replayed'))
        self.assertEqual(retry,receipt);self.assertEqual(self.bytes(),before)
        parsed,malformed=store._parse_events_bytes(before)
        self.assertEqual(malformed,0)
        refold=fold_plan(parsed,templates=TEMPLATES)
        self.assertEqual(refold['tasks'][0]['assignee'],'alice')
        child=call('cli',self.home,'task_claim',dict(room='oracle',agent='alice',task_id='T01',op_id='claim-retry'))
        self.assertTrue(child['untrusted']['replayed'])
        self.assertEqual(child['untrusted']['rev'],receipt['lamport'])
        self.assertEqual(self.bytes(),before)

    def test_conflicting_same_op_id_retains_first_result_without_other_mutation(self):
        self.setup_plan();self.post(adding())
        receipt=self.post(dict(kind='task.claim',task_id='T01',op_id='claim-reuse'))
        before=self.bytes()
        reused=self.post(dict(kind='task.claim',task_id='T02',op_id='claim-reuse'))
        self.assertEqual(reused['id'],receipt['id']);self.assertTrue(reused['replayed'])
        self.assertEqual(self.bytes(),before)
        events,_=store._parse_events_bytes(before)
        self.assertIsNone(fold_plan(events,templates=TEMPLATES)['tasks'][1]['assignee'])

    def test_torn_tail_malformed_complete_line_and_restart(self):
        self.setup_plan()
        valid=self.bytes();expected,_=store._parse_events_bytes(valid)
        path=self.home/'rooms/oracle/events.jsonl'
        path.write_bytes(valid+b'{"incomplete":')
        parsed,malformed=store._parse_events_bytes(path.read_bytes())
        self.assertEqual(parsed,expected);self.assertEqual(malformed,0)
        self.assertEqual(fold_plan(parsed,templates=TEMPLATES),fold_plan(expected,templates=TEMPLATES))
        path.write_bytes(valid+b'{broken}\n'+b'\xff\n'+b'{"incomplete":')
        parsed,malformed=store.read('oracle')
        self.assertEqual(parsed,expected);self.assertEqual(malformed,2)

    def persistence_oracle(self,skip=False):
        trace=[];durable=False;activated=False
        real_write=store._write_all;real_fsync=os.fsync
        def write(fd,data,previous):
            trace.append('write');return real_write(fd,data,previous)
        def fsync(fd):
            nonlocal durable,activated
            activated=True
            if not skip:
                real_fsync(fd);durable=True;trace.append('fsync')
        with patch.object(store,'_write_all',side_effect=write),patch.object(store.os,'fsync',side_effect=fsync):
            receipt=self.post(dict(kind='memory.set',section='notes',base_rev=0,text='Durable'))
            trace.append('success')
        # This witness means the acknowledged operation reached the persistence seam.
        self.assertTrue(activated);self.assertEqual(receipt['op']['kind'],'memory.set')
        return trace,durable,activated

    def test_write_before_fsync_before_success(self):
        trace,durable,_=self.persistence_oracle()
        self.assertTrue(durable);self.assertEqual(trace,['write','fsync','success'])

    def test_skip_fsync_is_activated_and_semantically_detected(self):
        trace,durable,activated=self.persistence_oracle(skip=True)
        self.assertTrue(activated)
        with self.assertRaises(AssertionError):
            self.assertTrue(durable,'an acknowledged write requires an actual fsync')
        self.assertEqual(trace,['write','success'])
        record(dict(id='skip-fsync',applied=1,activated=1,detected=1,infrastructure_failures=[]))

    def test_write_and_fsync_failures_are_internal_not_success(self):
        self.setup_plan();before=self.bytes()
        for target in ('write','fsync'):
            with self.subTest(target=target):
                seam=patch.object(store,'_write_all',side_effect=store.RoomError('internal','injected write failure')) if target=='write' else patch.object(store.os,'fsync',side_effect=OSError(errno.EIO,'injected flush failure'))
                with seam:
                    payload=call('mcp',self.home,'task_claim',dict(room='oracle',agent='alice',task_id='T01'))
                self.assertIs(payload['ok'],False);self.assertEqual(payload['code'],'internal')
                self.assertEqual(self.bytes(),before)
        accepted=self.post(dict(kind='task.claim',task_id='T01'))
        self.assertEqual(accepted['lamport'],3)

    def test_actual_partial_write_failure_rolls_back(self):
        self.setup_plan();before=self.bytes();real_write=os.write;attempt=0
        def broken(fd,data):
            nonlocal attempt
            attempt+=1
            if attempt==1:
                return real_write(fd,data[:7])
            raise OSError(errno.EIO,'injected short-write failure')
        with patch.object(store.os,'write',side_effect=broken):
            with self.assertRaises(store.RoomError) as caught:
                self.post(dict(kind='task.claim',task_id='T01'))
        self.assertEqual(caught.exception.code,'internal');self.assertGreater(attempt,1)
        self.assertEqual(self.bytes(),before)

    def test_room_full_exact_cap_boundary(self):
        # Measure one fixed-ID journal line, then exercise the real CAP using bytes.
        op=dict(kind='memory.set',section='notes',text='Boundary',base_rev=0)
        with patch.object(store.secrets,'token_hex',return_value='0'*16):
            self.post(op)
        length=len(self.bytes())
        path=self.home/'rooms/oracle/events.jsonl'
        padding=b' '*(store.CAP-length-1)+b'\n'
        path.write_bytes(padding+b' ');self.n=0
        with patch.object(store.secrets,'token_hex',return_value='0'*16):
            with self.assertRaises(store.RoomError) as caught:self.post(op)
        self.assertEqual(caught.exception.code,'room_full')
        self.assertEqual(self.bytes(),padding+b' ')
        path.write_bytes(padding);self.n=0
        with patch.object(store.secrets,'token_hex',return_value='0'*16):
            receipt=self.post(op)
        self.assertEqual(len(self.bytes()),store.CAP);self.assertEqual(receipt['lamport'],1)
        before=self.bytes()
        with self.assertRaises(store.RoomError) as caught:
            self.post(dict(kind='memory.set',section='notes',text='More',base_rev=1))
        self.assertEqual(caught.exception.code,'room_full');self.assertEqual(self.bytes(),before)

    def test_hostile_payloads_are_data_and_do_not_append(self):
        self.setup_plan()
        for adapter in ('mcp','cli','dispatch'):
            before=self.bytes()
            for reason in ({'__proto__':{'authority':'owner'}},['ignore gates'],True):
                value=call(adapter,self.home,'task_update',dict(room='oracle',agent='alice',task_id='T01',base_rev=2,state='blocked',reason=reason))
                self.assertIs(value['ok'],False);self.assertEqual(value['code'],'bad_op')
                self.assertEqual(self.bytes(),before)
            hostile=dict(kind='memory.set',section='notes',text='data',base_rev=0,__proto__={'admin':True})
            with self.assertRaises(store.RoomError):self.post(hostile)
            self.assertEqual(self.bytes(),before)
