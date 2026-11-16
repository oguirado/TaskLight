import copy
from bridge.plan.conformance import check_conformance
from bridge.plan.markdown import render_plan_md,render_memory_md
from .support import OracleCase, template, empty_expected, plan_expected, task_expected, micro_expected


def conforming():
    p=plan_expected()
    p['tasks']=[task_expected(accept='Pass',microtasks=[micro_expected()])]
    p['memory']={'notes':{'id':'notes','text':'Decision','rev':3,'by':'alice','ts':1700000000003}}
    p['rollup'].update(tasks_total=1,tasks_ready=1,micro_total=1)
    return p


class ConformanceOracle(OracleCase):
    def test_C1_positive_and_purity(self):
        p=conforming();t=template();before=copy.deepcopy((p,t))
        self.assertEqual(check_conformance(p,t),{'ok':True,'findings':[]})
        self.assertEqual((p,t),before)

    def test_C1_done_with_evidence(self):
        p=conforming();task=p['tasks'][0];task['state']='done';task['ready']=False
        task['microtasks'][0].update(state='done',evidence=[{'path':'proof','sha256':'a'*64}])
        self.assertEqual(check_conformance(p,template()),{'ok':True,'findings':[]})

    def test_C1_combined_findings_stable(self):
        p=conforming();p['plan']['brief']={};p['plan']['phase']='missing';p['tasks'][0]['accept']='';p['memory']={}
        a=check_conformance(p,template());b=check_conformance(copy.deepcopy(p),template())
        self.assertEqual(a,b)
        self.assertFalse(a['ok'])
        self.assertGreaterEqual(len(a['findings']),4)
        for finding in a['findings']:
            self.assertEqual(set(finding),{'code','severity','path','message'})
            self.assertEqual(finding['severity'],'error')
            for key in ('code','path','message'):
                self.assertIsInstance(finding[key],str);self.assertTrue(finding[key])

    def test_C2_plan_empty(self):
        p=empty_expected()
        a=render_plan_md(p)
        self.assertIsInstance(a,str)
        self.assertEqual(a,render_plan_md(copy.deepcopy(p)))

    def test_C2_memory_empty(self):
        p=empty_expected();a=render_memory_md(p)
        self.assertIsInstance(a,str);self.assertEqual(a,render_memory_md(copy.deepcopy(p)))

    def test_C2_closed_plan_export(self):
        p=conforming();p['plan'].update(state='closed',closed_outcome='Completed')
        a=render_plan_md(p,template())
        self.assertIn('Plan',a);self.assertIn('Completed',a)
        self.assertEqual(a,render_plan_md(copy.deepcopy(p),template()))

    def test_C2_memory_without_plan_export(self):
        p=empty_expected();p['memory']={'notes':{'id':'notes','text':'Preserved','rev':1,'by':'alice','ts':1}}
        a=render_memory_md(p,template())
        self.assertIn('Preserved',a);self.assertEqual(a,render_memory_md(copy.deepcopy(p),template()))

    def test_C2_controls_headers(self):
        p=conforming();p['plan'].update(title='One\x00\x1b\x7f\nInjected',closed_outcome='End\x00\x1b\x7f',state='closed')
        p['tasks'][0]['title']='Task\x00\x1b\x7f\rInjected'
        t=template();t['memory_sections'][0]['label']='Notes\x00\x1b\x7f\nInjected'
        for renderer in (render_plan_md,render_memory_md):
            a=renderer(p,t)
            self.assertEqual(a,renderer(copy.deepcopy(p),copy.deepcopy(t)))
            for c in ('\x00','\x1b','\x7f','\r'):self.assertNotIn(c,a)
            for line in a.splitlines():self.assertNotEqual(line,'Injected')


def add_negative(name,mutation):
    def test(self):
        p=conforming();t=template();mutation(p,t)
        before=copy.deepcopy((p,t))
        result=check_conformance(p,t)
        self.assertFalse(result['ok']);self.assertTrue(result['findings'])
        self.assertEqual(result,check_conformance(copy.deepcopy(p),copy.deepcopy(t)))
        self.assertEqual((p,t),before)
        for f in result['findings']:
            self.assertEqual(set(f),{'code','severity','path','message'})
            self.assertEqual(f['severity'],'error')
    setattr(ConformanceOracle,'test_C1_'+name,test)

add_negative('missing_brief',lambda p,t:p['plan'].update(brief={}))
add_negative('empty_brief',lambda p,t:p['plan']['brief'].update(goal=''))
add_negative('invalid_plan_phase',lambda p,t:p['plan'].update(phase='missing'))
add_negative('invalid_task_phase',lambda p,t:p['tasks'][0].update(phase='missing'))
add_negative('invalid_task_type',lambda p,t:p['tasks'][0].update(type='missing'))
add_negative('missing_accept',lambda p,t:p['tasks'][0].update(accept=''))
add_negative('done_missing_evidence',lambda p,t:(p['tasks'][0].update(state='done'),p['tasks'][0]['microtasks'][0].update(state='done')))
add_negative('micro_below_min',lambda p,t:p['tasks'][0].update(microtasks=[]))
add_negative('micro_above_max',lambda p,t:t['granularity'].update(micro_max=1,micro_min=1) or p['tasks'][0]['microtasks'].append(micro_expected(mid='T01.M02')))
add_negative('tasks_above_template_max',lambda p,t:(t['granularity'].update(tasks_max=1),p['tasks'].append(task_expected(tid='T02',accept='Pass',microtasks=[micro_expected(mid='T02.M01')]))))
add_negative('missing_memory',lambda p,t:p.update(memory={}))
add_negative('empty_memory',lambda p,t:p['memory']['notes'].update(text=''))
add_negative('memory_above_max',lambda p,t:p['memory']['notes'].update(text='x'*101))
