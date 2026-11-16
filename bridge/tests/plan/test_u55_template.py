import copy
import hashlib
import json
from bridge.plan.template import canonical_template_json, template_hash, validate_template, load_template, resolve_template
from .support import OracleCase, ROOT, template


class TemplateOracle(OracleCase):
    def test_T1_load_validate_canonical_hash(self):
        raw=template(); raw.pop('hash')
        before=copy.deepcopy(raw)
        valid=validate_template(raw)
        self.assertEqual(raw,before)
        rev=dict(reversed(list(raw.items())))
        self.assertEqual(template_hash(raw),template_hash(rev))
        self.assertEqual(template_hash(valid),valid['hash'])
        self.assertEqual(template_hash(raw),hashlib.sha256(canonical_template_json(raw).encode('utf-8')).hexdigest())
        self.assertEqual(json.loads(canonical_template_json(valid)),raw)
        self.assertEqual(load_template(str(ROOT/'fixtures/plan/load-input.json')),valid)
        self.assertEqual(resolve_template('neutral',{'neutral':valid}),valid)

    def test_T1_resolve_missing(self):
        self.assertCode('unknown_template',resolve_template,'missing',{})

    def test_T1_load_invalid_json(self):
        self.assertCode('bad_template',load_template,str(ROOT/'fixtures/plan/bad-input.json'))

    def test_T1_load_missing_file(self):
        self.assertCode('bad_template',load_template,str(ROOT/'fixtures/plan/missing.json'))

    def test_T5_schema_json_and_neutrality(self):
        # Prerequisite intentionally fails at the public stub before schema inspection.
        validate_template(template())
        path=ROOT/'schemas/planning-template.v1.schema.json'
        self.assertTrue(path.is_file(),'Production schema is required, but outside oracle write surface')
        schema=json.loads(path.read_text(encoding='utf-8'))
        self.assertEqual(schema['$schema'],'https://json-schema.org/draft/2020-12/schema')
        def walk(v):
            if isinstance(v,dict):
                for k,x in v.items():
                    self.assertNotIn(k,('build','test','release'))
                    if k=='enum':
                        for item in x: self.assertNotIn(item,('build','test','release'))
                    walk(x)
            elif isinstance(v,list):
                for x in v: walk(x)
        walk(schema)


def reject_case(name, mutate):
    def test(self):
        raw=template(); raw.pop('hash')
        mutate(raw)
        self.assertCode('bad_template',validate_template,raw)
    test.__name__='test_'+name
    setattr(TemplateOracle,test.__name__,test)

for path in [('v',),('granularity','tasks_max'),('granularity','micro_min'),('granularity','micro_max'),('memory_sections',0,'max_chars')]:
    for label,v in [('bool',True),('false',False),('nan',float('nan')),('infinity',float('inf')),('fraction',1.5)]:
        def mutate(t,path=path,v=v):
            obj=t
            for key in path[:-1]: obj=obj[key]
            obj[path[-1]]=v
        reject_case('T2_'+ '_'.join(map(str,path))+'_'+label,mutate)

for field in ('brief_fields','phases','task_types','memory_sections','granularity','top'):
    def mutate(t,field=field):
        obj=t if field=='top' else t[field] if field=='granularity' else t[field][0]
        obj['unexpected']='x'
    reject_case('T2_unknown_'+field,mutate)

# Apply each hostile string to every existing string position, including IDs/hints.
def string_paths(v,path=()):
    if isinstance(v,str): yield path
    elif isinstance(v,dict):
        for k,x in v.items(): yield from string_paths(x,path+(k,))
    elif isinstance(v,list):
        for i,x in enumerate(v): yield from string_paths(x,path+(i,))
raw=template();raw.pop('hash')
for i,path in enumerate(string_paths(raw)):
    for label,v in [('nul','\x00'),('escape','\x1b'),('del','\x7f'),('script','<script>'),('js','javascript:'),('html','data:text/html'),('iframe','<iframe'),('closing','</x>')]:
        def mutate(t,path=path,v=v):
            obj=t
            for k in path[:-1]:obj=obj[k]
            obj[path[-1]]=v
        reject_case('T3_string_%02d_%s'%(i,label),mutate)

for field,cap in [('brief_fields',8),('phases',8),('task_types',12),('memory_sections',12)]:
    def over(t,field=field,cap=cap):
        t[field]=[dict(t[field][0],id='id-%d'%i) for i in range(cap+1)]
    reject_case('T4_over_'+field,over)
    reject_case('T4_duplicate_'+field,lambda t,field=field:t[field].append(copy.deepcopy(t[field][0])))
for field in ('phases','task_types'):
    reject_case('T4_empty_'+field,lambda t,field=field:t.update({field:[]}))
for field,value in [('tasks_max',0),('tasks_max',41),('micro_min',0),('micro_max',13)]:
    reject_case('T4_%s_%s'%(field,value),lambda t,field=field,value=value:t['granularity'].update({field:value}))
reject_case('T4_reversed_micro_bounds',lambda t:t['granularity'].update(micro_min=3,micro_max=2))
for v in (0,2001):reject_case('T4_memory_chars_'+str(v),lambda t,v=v:t['memory_sections'][0].update(max_chars=v))
for path,cap in [(('name',),40),(('summary',),240),(('lens_id',),40),(('phases',0,'label'),60),(('phases',0,'exit'),160),(('granularity','rule'),240),(('memory_sections',0,'hint'),160),(('task_types',0,'micro_hints',0),80)]:
    def over(t,path=path,cap=cap):
        obj=t
        for k in path[:-1]:obj=obj[k]
        obj[path[-1]]='a'*(cap+1)
    reject_case('T4_text_'+ '_'.join(map(str,path)),over)
for key in ('__proto__','constructor','prototype'):
    reject_case('T2_dangerous_'+key,lambda t,key=key:t.update({key:{}}))
for field in ('brief_fields','task_types','memory_sections'):
    flag='accept_required' if field=='task_types' else 'required'
    reject_case('T2_nonbool_'+field,lambda t,field=field,flag=flag:t[field][0].update({flag:1}))
reject_case('T4_hints_cap',lambda t:t['task_types'][0].update(micro_hints=['Step']*13))
reject_case('T2_nonbool_evidence_required',lambda t:t['task_types'][0].update(evidence_required='false'))
for v in (0,2):reject_case('T2_version_'+str(v),lambda t,v=v:t.update(v=v))
