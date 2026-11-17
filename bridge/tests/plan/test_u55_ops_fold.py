import copy
import itertools
import json
from unittest.mock import patch
from bridge.plan.fold import empty_projection, fold_plan, apply_op_event
from bridge.plan.ops import validate_op_shape, is_valid_op_shape
from bridge.plan.template import validate_template
from .support import OracleCase, BASE_TS, event, opening, adding, templates, template, empty_expected


class FoldOracle(OracleCase):
    def test_O1_all_ten_ops(self):
        ops=[opening(),{'kind':'plan.phase','base_rev':1,'phase':'finish'},
             adding(base_rev=2,microtasks=[{'text':'First','accept':'Pass'}]),
             {'kind':'task.set','task_id':'T01','base_rev':3,'title':'Edited','estimate':None,'reason':None,'state':None},
             {'kind':'task.claim','task_id':'T01','base_rev':4},
             {'kind':'micro.add','task_id':'T01','base_rev':5,'text':'Second'},
             {'kind':'micro.set','micro_id':'T01.M01','state':'done','outcome':'OK','took':'1m','evidence':[{'path':'proof','sha256':'a'*64}]},
             # A-U109c: (a) release unfinished work, reclaim before completion, M3/M5, Amendment C A-U109-1.
             {'kind':'task.release','task_id':'T01','base_rev':7},
             {'kind':'task.claim','task_id':'T01'},
             {'kind':'micro.set','micro_id':'T01.M02','state':'done'},
             {'kind':'memory.set','section':'notes','text':'Decision','base_rev':0},
             {'kind':'plan.close','base_rev':2,'outcome':'Finished'}]
        s=empty_projection()
        for n,op in enumerate(ops,1):
            s,_=apply_op_event(s,event(n,op),templates=templates())
            if op['kind']=='task.release':
                self.assertIsNone(s['tasks'][0]['assignee'])
                self.assertIsNone(s['tasks'][0]['claim_lamport'])
        self.assertEqual(s['rejected'],[])
        self.assertEqual(s['plan']['state'],'closed')
        self.assertEqual(s['plan']['rev'],12)
        self.assertEqual(s['plan']['closed_outcome'],'Finished')
        t=s['tasks'][0]
        self.assertEqual((t['id'],t['rev'],t['state'],t['ready'],t['assignee']),('T01',10,'done',False,'alice'))
        self.assertEqual([m['id'] for m in t['microtasks']],['T01.M01','T01.M02'])
        self.assertEqual([m['rev'] for m in t['microtasks']],[7,10])
        self.assertEqual(s['memory']['notes'],{'id':'notes','text':'Decision','rev':11,'by':'alice','ts':BASE_TS+11})
        self.assertEqual(s['rollup'],{'tasks_total':1,'tasks_done':1,'tasks_blocked':0,'tasks_ready':0,'micro_total':2,'micro_done':2,'progress':1.0,'progress_pct':100})

    def test_O2_no_plan(self):
        self.assertCode('no_plan',apply_op_event,empty_projection(),event(1,adding()))

    def test_O2_plan_exists(self):
        self.assertCode('plan_exists',self.apply,self.start(),2,opening())

    def test_O2_unknown_template(self):
        o=opening();o['template_id']='missing'
        self.assertCode('unknown_template',apply_op_event,empty_projection(),event(1,o),templates=templates())

    def test_O2_hash_mismatch(self):
        o=opening();o['template_hash']='f'*64
        self.assertCode('bad_op',apply_op_event,empty_projection(),event(1,o),templates=templates())

    def test_O2_bad_template(self):
        self.assertCode('bad_template',validate_template,{'v':False})

    def test_O2_bad_op(self):
        self.assertCode('bad_op',validate_op_shape,{'kind':'unsupported'})

    def test_O2_missing_task(self):
        self.assertCode('not_found',self.apply,self.start(),2,{'kind':'task.claim','task_id':'T01'})

    def test_O2_missing_dep(self):
        self.assertCode('not_found',self.apply,self.start(),2,adding(deps=['T02']))

    def test_O2_duplicate_dep(self):
        self.assertCode('bad_op',self.apply,self.start(adding()),3,adding(deps=['T01','T01']))

    def test_O2_stale_plan_revision(self):
        self.assertCode('stale_rev',self.apply,self.start(),2,{'kind':'plan.close','base_rev':2})

    def test_O3_self_cycle(self):
        self.assertCode('dep_cycle',self.apply,self.start(adding()),3,{'kind':'task.set','task_id':'T01','base_rev':2,'deps':['T01']})

    def test_O3_two_cycle(self):
        s=self.start(adding(),adding(deps=['T01']))
        self.assertCode('dep_cycle',self.apply,s,4,{'kind':'task.set','task_id':'T01','base_rev':2,'deps':['T02']})

    def test_O3_three_cycle(self):
        s=self.start(adding(),adding(deps=['T01']),adding(deps=['T02']))
        self.assertCode('dep_cycle',self.apply,s,5,{'kind':'task.set','task_id':'T01','base_rev':2,'deps':['T03']})

    def test_O3_over_eight_deps(self):
        self.assertCode('limit_exceeded',validate_op_shape,adding(deps=['T%02d'%i for i in range(1,10)]))

    def test_O4_task_41(self):
        s=self.start(*[adding() for _ in range(40)])
        self.assertEqual([t['id'] for t in s['tasks']],['T%02d'%i for i in range(1,41)])
        self.assertCode('limit_exceeded',self.apply,s,42,adding())

    def test_O4_micro_13(self):
        s=self.start(adding(microtasks=[{'text':'Step'} for _ in range(12)]))
        self.assertEqual([m['id'] for m in s['tasks'][0]['microtasks']],['T01.M%02d'%i for i in range(1,13)])
        self.assertCode('limit_exceeded',self.apply,s,3,{'kind':'micro.add','task_id':'T01','base_rev':2,'text':'Overflow'})

    def test_O4_utf8_payload_cap(self):
        # All component lengths are legal: byte cap is the only violated limit.
        op=adding(microtasks=[{'text':'😀'*80,'accept':'😀'*160} for _ in range(12)])
        self.assertGreater(len(json.dumps(op,ensure_ascii=False,separators=(',',':'),sort_keys=True).encode()),8192)
        self.assertCode('limit_exceeded',validate_op_shape,op)

    def test_O4_exact_utf8_cap(self):
        # Fixed ASCII keys plus variable UTF-8 content, exactly at and one over cap.
        op=adding(microtasks=[{'text':'😀'*80,'accept':'😀'*80} for _ in range(12)])
        for m in op['microtasks']:
            while len(json.dumps(op,ensure_ascii=False,separators=(',',':'),sort_keys=True).encode())<8192 and len(m['accept'])<160:
                m['accept']+='a'
        size=len(json.dumps(op,ensure_ascii=False,separators=(',',':'),sort_keys=True).encode())
        self.assertEqual(size,8192)
        self.assertIsInstance(validate_op_shape(op),dict)
        op['title']+='a'
        self.assertCode('limit_exceeded',validate_op_shape,op)

    def test_O5_replay_agent_scope_and_first_result(self):
        s=self.start()
        op=adding(op_id='repeat_01')
        s,first=self.apply(s,2,op)
        changed=dict(op,title='Changed')
        s,replay=self.apply(s,3,changed)
        self.assertIs(replay['replayed'],True)
        self.assertEqual({k:v for k,v in replay.items() if k!='replayed'},{k:v for k,v in first.items() if k!='replayed'})
        self.assertEqual(len(s['tasks']),1)
        self.assertEqual(s['tasks'][0]['title'],'Action')
        self.assertIn('["alice","repeat_01"]',s['replayed_ops'])
        s,result=self.apply(s,4,op,agent='bob')
        self.assertEqual([t['id'] for t in s['tasks']],['T01','T02'])
        self.assertFalse(result.get('replayed',False))

    def test_O6_takeover_claim_boundary(self):
        s=self.start(adding())
        s,_=self.apply(s,3,{'kind':'task.claim','task_id':'T01'},ts=BASE_TS+100)
        op={'kind':'task.claim','task_id':'T01','takeover':True}
        self.assertCode('claimed_by_other',self.apply,s,4,op,agent='bob',ts=BASE_TS+600100)
        s,_=self.apply(s,5,op,agent='bob',ts=BASE_TS+600101)
        self.assertEqual(s['tasks'][0]['assignee'],'bob')

    def test_O6_takeover_legacy_room_activity(self):
        events=[event(1,opening()),event(2,adding()),event(3,{'kind':'task.claim','task_id':'T01'},ts=BASE_TS+100),
                event(4,agent='alice',act='heartbeat',ts=BASE_TS+1000),
                event(5,{'kind':'task.claim','task_id':'T01','takeover':True},agent='bob',ts=BASE_TS+601000),
                event(6,{'kind':'task.claim','task_id':'T01','takeover':True},agent='bob',ts=BASE_TS+601001)]
        s=fold_plan(events,templates=templates())
        self.assertEqual([r['code'] for r in s['rejected']],['claimed_by_other'])
        self.assertEqual(s['tasks'][0]['assignee'],'bob')

    def test_O6_explicit_activity_context(self):
        s=self.start(adding(assignee='alice'))
        s,_=self.apply(s,3,{'kind':'task.claim','task_id':'T01'},ts=BASE_TS+100)
        self.assertCode('claimed_by_other',apply_op_event,s,event(4,{'kind':'task.claim','task_id':'T01','takeover':True},agent='bob',ts=BASE_TS+601000),templates=templates(),last_by_agent={'alice':BASE_TS+1000})

    def test_O7_memory_before_plan_stale(self):
        op={'kind':'memory.set','section':'notes','text':'Remember','base_rev':0}
        s,_=apply_op_event(empty_projection(),event(1,op))
        self.assertIsNone(s['plan'])
        self.assertEqual(s['memory']['notes']['rev'],1)
        self.assertCode('stale_rev',apply_op_event,s,event(2,op))

    def test_O7_memory_template_limit(self):
        self.assertCode('limit_exceeded',self.apply,self.start(),2,{'kind':'memory.set','section':'notes','text':'x'*101,'base_rev':0})

    def test_O7_claim_protects_micro_and_release(self):
        s=self.start(adding(assignee='alice',microtasks=[{'text':'Step'}]))
        for op in ({'kind':'micro.set','micro_id':'T01.M01','state':'done'}, {'kind':'task.release','task_id':'T01'}, {'kind':'task.claim','task_id':'T01'}):
            self.assertCode('claimed_by_other',self.apply,s,3,op,agent='bob')

    def test_O8_order_purity_rejection_continuation(self):
        events=[event(1,opening()),event(2,{'kind':'bad'}),event(3,adding())]
        before=copy.deepcopy(events);t=templates();tb=copy.deepcopy(t)
        expected=fold_plan(events,templates=t)
        for shuffled in itertools.permutations(events):
            self.assertEqual(fold_plan(shuffled,templates=t),expected)
        self.assertEqual(events,before);self.assertEqual(t,tb)
        self.assertEqual(expected['rejected'],[{'id':events[1]['id'],'lamport':2,'op_id':None,'code':'bad_op'}])
        self.assertEqual(expected['last_lamport'],3)
        self.assertEqual(expected['rollup']['progress'],0.0)
        self.assertEqual(len(expected['tasks']),1)

    def test_O8_empty_projection(self):
        self.assertEqual(empty_projection(),empty_expected())
        self.assertEqual(fold_plan([]),empty_expected())

    def test_O8_duplicate_event_and_ordinal_tie(self):
        a=event(2,adding(title='First')); b=event(2,adding(title='Second'),id='e-0000000000000003')
        s=fold_plan([b,a,event(1,opening()),copy.deepcopy(a)],templates=templates())
        self.assertEqual([t['title'] for t in s['tasks']],['First','Second'])

    def test_O8_micro_tie_last_write(self):
        a=event(3,{'kind':'micro.set','micro_id':'T01.M01','state':'active'})
        b=event(3,{'kind':'micro.set','micro_id':'T01.M01','state':'done'},id='e-0000000000000004')
        # A-U109c: (a) tied writes still require their event agent to own the task, M3.
        s=fold_plan([b,event(2,adding(assignee='alice',microtasks=[{'text':'Step'}])),a,event(1,opening())],templates=templates())
        self.assertEqual(s['tasks'][0]['state'],'done')

    def test_O8_no_clock_or_filesystem(self):
        t=templates();events=[event(1,opening()),event(2,adding())]
        with patch('time.time',side_effect=AssertionError('wall clock')),patch('time.monotonic',side_effect=AssertionError('timer')),patch('builtins.open',side_effect=AssertionError('filesystem')):
            s=fold_plan(events,templates=t)
        self.assertEqual(len(s['tasks']),1)

    def test_lifecycle_archive_memory_and_cancelled_ids(self):
        s=self.start(adding(),{'kind':'task.set','task_id':'T01','base_rev':2,'state':'cancelled'},adding(),{'kind':'memory.set','section':'notes','text':'Keep','base_rev':0})
        self.assertEqual([t['id'] for t in s['tasks']],['T01','T02'])
        # A-U109c: (a) explicitly cancel remaining work before archiving, M6.
        s,_=self.apply(s,6,{'kind':'task.set','task_id':'T02','base_rev':4,'state':'cancelled'})
        s,_=self.apply(s,7,{'kind':'plan.close','base_rev':1,'outcome':'Old'})
        self.assertCode('no_plan',self.apply,s,8,adding())
        s,_=self.apply(s,9,opening())
        self.assertEqual(s['tasks'],[])
        self.assertEqual(s['memory']['notes']['text'],'Keep')
        self.assertEqual(s['archived_plans'],[{'id':'p1','title':'Plan','template_id':'neutral','opened_ts':BASE_TS+1,'closed_ts':BASE_TS+7,'tasks_total':2,'tasks_done':0,'outcome':'Old'}])
        s,_=self.apply(s,10,adding())
        self.assertEqual(s['tasks'][0]['id'],'T01')

    def test_optional_revisions(self):
        s=self.start(adding())
        self.assertCode('stale_rev',self.apply,s,3,adding(base_rev=2))
        for kind in ('task.claim','task.release'):
            self.assertCode('stale_rev',self.apply,s,3,{'kind':kind,'task_id':'T01','base_rev':1})

    def test_invalid_phase_transition(self):
        s=self.start(adding())
        for op in ({'kind':'plan.phase','phase':'missing','base_rev':1},adding(phase='missing'),{'kind':'task.set','task_id':'T01','base_rev':2,'phase':'missing'}):
            self.assertCode('bad_op',self.apply,s,3,op)


def install_shape(name,op,code=None):
    def test(self):
        if code:
            self.assertCode(code,validate_op_shape,copy.deepcopy(op))
            self.assertIs(is_valid_op_shape(copy.deepcopy(op)),False)
        else:
            self.assertIsInstance(validate_op_shape(copy.deepcopy(op)),dict)
            self.assertIs(is_valid_op_shape(copy.deepcopy(op)),True)
    setattr(FoldOracle,'test_shape_'+name,test)

valid_ops=[opening(),{'kind':'plan.close','base_rev':1}, {'kind':'plan.phase','base_rev':1,'phase':'start'},adding(),
           {'kind':'task.set','task_id':'T01','base_rev':1,'state':None,'estimate':None,'reason':None},
           {'kind':'task.claim','task_id':'T01'}, {'kind':'task.release','task_id':'T01'},
           {'kind':'micro.add','task_id':'T01','base_rev':1,'text':'Step'},
           {'kind':'micro.set','micro_id':'T01.M01','state':'done'}, {'kind':'memory.set','section':'notes','text':'','base_rev':0}]
for i,op in enumerate(valid_ops):
    install_shape('valid_%02d'%i,op)
    install_shape('unknown_%02d'%i,dict(op,unknown=True),'bad_op')
    for label,value in [('null',None),('short','short'),('long','a'*65),('space','abcdefgh '),('number',123)]:
        install_shape('op_id_%02d_%s'%(i,label),dict(op,op_id=value),'bad_op')
    if 'base_rev' in op:
        if op['kind']!='task.add':
            missing=dict(op);missing.pop('base_rev')
            install_shape('missing_rev_%02d'%i,missing,'bad_op')
        for label,value in [('bool',True),('negative',-1),('float',1.5),('nan',float('nan')),('inf',float('inf')),('unsafe',9007199254740992)]:
            install_shape('rev_%02d_%s'%(i,label),dict(op,base_rev=value),'bad_op')
for field in ('base_rev','id','evidence_wrong'):
    install_shape('micro_forbidden_'+field,dict(valid_ops[8],**{field:1}),'bad_op')
for field in ('assignee','status'):
    install_shape('task_set_forbidden_'+field,dict(valid_ops[4],**{field:'alice'}),'bad_op')
install_shape('task_set_no_mutation',{'kind':'task.set','task_id':'T01','base_rev':1},'bad_op')
for i,e in enumerate([{'path':'','sha256':'a'*64},{'path':'proof','sha256':'A'*64},{'path':'proof','sha256':'a'*63},{'path':'proof','sha256':'a'*64,'extra':1}, {'path':'x'*513,'sha256':'a'*64}]):
    install_shape('evidence_%d'%i,dict(valid_ops[8],evidence=[e]),'bad_op')
install_shape('evidence_cap',dict(valid_ops[8],evidence=[{'path':'proof','sha256':'a'*64}]*9),'limit_exceeded')
for key in ('__proto__','constructor','prototype'):
    install_shape('dangerous_'+key,dict(valid_ops[8],**{key:None}),'bad_op')
for label,value in [('none',None),('array',[]),('string','op'),('int',1)]:install_shape('nonobject_'+label,value,'bad_op')
install_shape('unicode_codepoints',adding(title='😀'*120))
install_shape('ordinary_operation_text',adding(title='<script>\x1bjavascript:'))
install_shape('micro_inline_unknown',adding(microtasks=[{'text':'Step','extra':1}]),'bad_op')
for field,bad in [('task_id','T00'),('task_id','T41'),('task_id','T01\n')]:install_shape(field+'_'+repr(bad),dict(valid_ops[5],**{field:bad}),'bad_op')
for bad in ('T01.M00','T01.M13','T41.M01'):install_shape('micro_id_'+bad,dict(valid_ops[8],micro_id=bad),'bad_op')


def event_integer_case(field,value,label):
    def test(self):
        self.assertCode('bad_op',apply_op_event,empty_projection(),event(1,opening(),**{field:value}))
    setattr(FoldOracle,'test_O4_event_'+field+'_'+label,test)
for field in ('lamport','ts'):
    for label,v in [('bool',True),('nan',float('nan')),('inf',float('inf')),('unsafe',9007199254740992),('fraction',1.5)]:event_integer_case(field,v,label)
for label,v in [('above_date_bound',8640000000000001),('below_date_bound',-8640000000000001)]:event_integer_case('ts',v,label)


def derived_case(ms,explicit,want,ready):
    def test(self):
        # A-U109c: (a) derived-state fixtures assign the writer before every micro state, M3.
        s=self.start(adding(assignee='alice',microtasks=[{'text':'Step'} for _ in ms]))
        n=3
        for i,state in enumerate(ms,1):
            s,_=self.apply(s,n,{'kind':'micro.set','micro_id':'T01.M%02d'%i,'state':state});n+=1
        if explicit:
            s,_=self.apply(s,n,{'kind':'task.set','task_id':'T01','base_rev':s['tasks'][0]['rev'],'state':explicit})
        self.assertEqual((s['tasks'][0]['state'],s['tasks'][0]['ready']),(want,ready))
    name='test_derived_'+('_'.join(ms) or 'empty')+'_'+str(explicit)
    setattr(FoldOracle,name,test)
for ms,ex,want,ready in [([],None,'pending',True),(['pending'],None,'pending',True),(['active'],None,'active',True),(['done','pending'],None,'active',True),(['done'],None,'done',False),(['blocked'],None,'blocked',True),(['done'],'blocked','blocked',True),(['blocked'],'cancelled','cancelled',False)]:derived_case(ms,ex,want,ready)

# Further hostile JSON values: recursion/non-JSON must become domain errors.
def hostile_payload(kind):
    if kind=='cycle':
        obj={'kind':'memory.set','section':'notes','text':'x','base_rev':0};obj['loop']=obj
    elif kind=='nonjson':obj=adding(estimate={'not-json'})
    elif kind=='nonstring-key':obj=adding();obj[1]='bad'
    else:obj=adding(brief={'constructor':'bad'})
    return obj
for label in ('cycle','nonjson','nonstring-key'):
    def test(self,label=label):
        self.assertCode('bad_op',validate_op_shape,hostile_payload(label))
        self.assertIs(is_valid_op_shape(hostile_payload(label)),False)
    setattr(FoldOracle,'test_hostile_'+label,test)
for key in ('__proto__','constructor','prototype'):
    install_shape('nested_brief_'+key,dict(opening(),brief={key:'value'}),'bad_op')

for i,op in enumerate(valid_ops):
    if i in (0,3):
        for value in ('', 'a'*121):install_shape('title_%d_%d'%(i,len(value)),dict(op,title=value),'bad_op')
for op,field,cap in [(valid_ops[0],'template_id',48),(valid_ops[2],'phase',48),(valid_ops[3],'type',48),(valid_ops[3],'accept',160),(valid_ops[3],'estimate',32),(valid_ops[4],'reason',240),(valid_ops[7],'text',80),(valid_ops[7],'accept',160),(valid_ops[8],'outcome',240),(valid_ops[8],'took',32),(valid_ops[9],'text',2000)]:
    install_shape('over_%s_%s'%(op['kind'],field),dict(op,**{field:'a'*(cap+1)}),'bad_op')
install_shape('inline_micro_cap',adding(microtasks=[{'text':'Step'}]*13),'limit_exceeded')
install_shape('empty_inline_micro_text',adding(microtasks=[{'text':''}]),'bad_op')
install_shape('takeover_nonbool',dict(valid_ops[5],takeover=1),'bad_op')
install_shape('invalid_assignee',adding(assignee='Bad Agent'),'bad_op')
install_shape('nullable_assignee',adding(assignee=None))
install_shape('null_micro_state',dict(valid_ops[8],state=None),'bad_op')
install_shape('invalid_explicit_state',dict(valid_ops[4],state='done'),'bad_op')


def filtered_events(self):
    good=[event(1,opening()),event(3,adding())]
    bad=[None,[],{},event(2,adding(),lamport=True),event(2,adding(),lamport=0),event(2,adding(),lamport=float('nan'))]
    self.assertEqual(fold_plan(good+bad,templates=templates()),fold_plan(good,templates=templates()))
setattr(FoldOracle,'test_O8_ineligible_events_filtered',filtered_events)


def dependency_readiness(self):
    # A-U109c: (a) prerequisite completion requires its assignee, M3.
    s=self.start(adding(assignee='alice',microtasks=[{'text':'Step'}]),adding(deps=['T01']))
    self.assertFalse(s['tasks'][1]['ready'])
    s,_=self.apply(s,4,{'kind':'micro.set','micro_id':'T01.M01','state':'done'})
    self.assertTrue(s['tasks'][1]['ready'])
    self.assertEqual(s['rollup']['tasks_done'],1)
setattr(FoldOracle,'test_dependency_readiness',dependency_readiness)


def replay_history_survives_reopen(self):
    s=self.start()
    s,first=self.apply(s,2,adding(op_id='persist_01'))
    # A-U109c: (a) cancel open work before testing replay across reopen, M6/M7.
    s,_=self.apply(s,3,{'kind':'task.set','task_id':'T01','base_rev':2,'state':'cancelled'})
    s,_=self.apply(s,4,{'kind':'plan.close','base_rev':1})
    s,_=self.apply(s,5,opening())
    s,result=self.apply(s,6,adding(op_id='persist_01'))
    self.assertTrue(result['replayed'])
    self.assertEqual(s['tasks'],[])
    self.assertIn('["alice","persist_01"]',s['replayed_ops'])
setattr(FoldOracle,'test_replay_history_survives_reopen',replay_history_survives_reopen)


def rejected_and_replayed_lamport(self):
    events=[event(1,opening()),event(2,adding(op_id='repeat_01')),event(3,adding(op_id='repeat_01')),event(7,{'kind':'bad'})]
    s=fold_plan(events,templates=templates())
    self.assertEqual(s['last_lamport'],7)
    self.assertEqual(len(s['tasks']),1)
    self.assertEqual(s['rejected'][-1]['code'],'bad_op')
setattr(FoldOracle,'test_last_lamport_includes_replay_and_rejection',rejected_and_replayed_lamport)

# not_conformant is a public domain code, but reducer strict mode is forbidden.
# Strict composite rejection itself belongs to U56; see both ORACLE.md files.
from bridge.plan.errors import PlanError
for code in ('no_plan','plan_exists','unknown_template','bad_template','bad_op','not_found','stale_rev','dep_cycle','claimed_by_other','limit_exceeded','not_conformant'):
    def test(self,code=code):
        err=PlanError(code,'detail')
        self.assertIsInstance(err,Exception)
        self.assertEqual(err.code,code)
    setattr(FoldOracle,'test_O2_error_class_'+code,test)


def add_self_dependency(self):
    self.assertCode('dep_cycle',self.apply,self.start(),2,adding(deps=['T01']))
setattr(FoldOracle,'test_O3_task_add_self_cycle',add_self_dependency)

for op in valid_ops[1:9]:
    def test(self,op=op):
        # A-U109c: (a) reach a legitimately closed plan before checking no_plan, M6.
        s=self.start(adding(microtasks=[{'text':'Step'}]),
                     {'kind':'task.set','task_id':'T01','base_rev':2,'state':'cancelled'},
                     {'kind':'plan.close','base_rev':1})
        self.assertCode('no_plan',self.apply,s,5,op)
    setattr(FoldOracle,'test_closed_plan_rejects_'+op['kind'],test)
