"""Semantic history gate. Functional tests run even when timing is contaminated."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import time
from .support import ROOT,PUBLIC,VERSION,MANDATORY,digest
from .contracts import stage_status


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def classify(exit_code, output):
    if exit_code == 0:
        return 'PASS'
    if exit_code is None:
        return 'INFRASTRUCTURE'
    if 'AssertionError' in output or '\nFAIL:' in output:
        return 'CORRECTNESS'
    return 'INFRASTRUCTURE'


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--stage',choices=('baseline','gates','cache','lifecycle','all'),default='baseline')
    parser.add_argument('--seeds',type=int,default=100)
    parser.add_argument('--steps',type=int,default=128)
    args=parser.parse_args()
    if not 1 <= args.seeds <= 100 or not 38 <= args.steps <= 128:
        parser.error('seeds must be 1..100; steps 38..128')
    artifacts=PUBLIC/'artifacts';artifacts.mkdir(exist_ok=True)
    # Remove previous evidence so stale green files cannot satisfy this run.
    for f in artifacts.glob('*.json'):
        f.unlink()
    baseline=json.loads((PUBLIC/'source-baseline.json').read_text())
    unchanged={name:sha(ROOT/name)==value for name,value in baseline.items() if isinstance(value,str)}
    manifest=json.loads((PUBLIC/'mutants.json').read_text())
    manifest_valid=all(m['target'] is None or m['source_sha256']==sha(ROOT/m['target']) for m in manifest['mutants'])
    bindings=json.loads((PUBLIC/'fixture-hashes.json').read_text())
    fixtures_valid=all(sha(ROOT/path)==expected for path,expected in bindings.items())
    preconditions=all(unchanged.values()) and manifest_valid and fixtures_valid
    if not preconditions:
        print('semantic-history-check: BLOCKED (source or frozen-fixture binding changed)')
        return 2
    start=time.perf_counter();load_before=os.getloadavg()[1]
    commands=[['python3','-B','-m','unittest','discover','-s','bridge/tests/property','-t','.'],
              ['npx','vitest','run','--config','tests/property/vitest.config.ts','--no-cache']]
    statuses=stage_status()
    selected=list(statuses) if args.stage=='all' else [args.stage]
    if 'gates' in selected:
        commands.append(['python3','-B','-m','unittest','bridge.tests.property.contracts.GateContracts'])
    results=[]
    env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1',U116_SEEDS=str(args.seeds),U116_STEPS=str(args.steps))
    for command in commands:
        print('$ '+' '.join(command),flush=True)
        try:
            child=subprocess.run(command,cwd=ROOT,env=env,capture_output=True,text=True,timeout=240)
            output=(child.stdout+'\n'+child.stderr).replace(str(ROOT),'.')
            lines=output.splitlines()
            summary=[x.strip() for x in lines if any(k in x for k in ('Ran ','OK','FAILED (','Test Files','Tests  ','semantic-history-check:'))]
            print('\n'.join(summary),flush=True)
            if child.returncode:
                print('\n'.join(lines[-18:]),flush=True)
            results.append(dict(command=command,exit=child.returncode,summary=summary,classification=classify(child.returncode,output)))
        except (OSError,subprocess.TimeoutExpired) as error:
            results.append(dict(command=command,exit=None,infrastructure_failure=type(error).__name__))
    load_after=os.getloadavg()[1]
    evidence=[]
    for m in manifest['mutants']:
        row={k:m[k] for k in ('id','target','source_sha256','applicability')}
        row.update(applied=None,activated=None,detected=None,infrastructure_failures=[])
        path=artifacts/('mutation-'+m['id']+'.json')
        if path.exists():
            row.update(json.loads(path.read_text()))
        elif m['id']=='remove-id-order-typescript' and (artifacts/'typescript-mutations.json').exists():
            row.update(json.loads((artifacts/'typescript-mutations.json').read_text())[0])
        elif m['applicability']=='baseline':
            row['infrastructure_failures']=['required mutation evidence missing']
        evidence.append(row)
    coverage=json.loads((artifacts/'coverage.json').read_text()) if (artifacts/'coverage.json').exists() else None
    differential=json.loads((artifacts/'differential.json').read_text()) if (artifacts/'differential.json').exists() else None
    baseline_results=results[:2]
    baseline_failure=any(r.get('classification')=='CORRECTNESS' for r in baseline_results)
    gate_failure=statuses['gates']['status']=='AVAILABLE' and any(r.get('classification')=='CORRECTNESS' for r in results[2:])
    correctness_failure=baseline_failure or gate_failure
    infrastructure=any(r['exit'] is None or r.get('classification')=='INFRASTRUCTURE' for r in results) or any(m['infrastructure_failures'] for m in evidence)
    mutant_failure=any(m['applicability']=='baseline' and m['activated']==1 and m['detected']==0 and not m['infrastructure_failures'] for m in evidence)
    missing_mutation_evidence=any(m['applicability']=='baseline' and (m['applied'],m['activated'],m['detected']) != (1,1,1) for m in evidence)
    missing_evidence=missing_mutation_evidence or coverage is None or differential is None or set(coverage['exercised'])!=MANDATORY
    unavailable=[s for s in selected if statuses[s]['status']=='BLOCKED']
    status='BLOCK' if correctness_failure or mutant_failure else 'INCONCLUSIVE' if infrastructure or missing_evidence or unavailable else 'PASS'
    statuses['baseline']['status']=status if args.stage=='baseline' else ('BLOCK' if baseline_failure else 'PASS' if not missing_evidence else 'INCONCLUSIVE')
    # Full acceptance requires every stage, even when only baseline was selected.
    acceptance='BLOCK' if correctness_failure or mutant_failure else 'INCONCLUSIVE' if any(s['status']=='BLOCKED' for s in statuses.values()) or infrastructure or missing_evidence else 'PASS'
    source_hashes={k:sha(ROOT/k) for k in unchanged}
    candidate_files={str(p.relative_to(ROOT)):sha(p) for folder in (PUBLIC,ROOT/'bridge/tests/property')
                     for p in folder.rglob('*') if p.is_file() and 'artifacts' not in p.parts and '__pycache__' not in p.parts}
    report=dict(schema='semantic-history-check/v1',provenance='MEASURED',status=status,acceptance=acceptance,selected_stage=args.stage,
                baseline_revision_cited='4528625',tested_revision=None,tested_revision_reason='AUSENTE — no inventar: isolated copy has no Git metadata',
                candidate_diff_sha256=digest(candidate_files),candidate_diff_kind='digest of new-file paths and content hashes; production baseline separately verified',
                source_hashes=source_hashes,fixture_hashes=bindings,manifest_sha256=sha(PUBLIC/'mutants.json'),
                generator=VERSION,seeds=list(range(args.seeds)),transitions_per_history=args.steps,
                stages=statuses,results=results,coverage=coverage,differential=differential,mutants=evidence,
                minimized_failures=sorted(str(p.relative_to(ROOT)) for p in artifacts.glob('*failure*.json')),
                shrink_control='tests/property/artifacts/shrink-control.json',
                infrastructure_controls=json.loads((artifacts/'infrastructure-controls.json').read_text()) if (artifacts/'infrastructure-controls.json').exists() else None,
                wall_seconds=round(time.perf_counter()-start,6),peak_child_rss_kib=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss,
                rss_scope='maximum waited-for child, not concurrent-process sum',load5_before=load_before,load5_after=load_after,
                timing_status='INCONCLUSIVE' if max(load_before,load_after)>=18 else 'OBSERVED',
                runtime_budget='AUSENTE — no inventar',production_unchanged=unchanged)
    (artifacts/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    print('semantic-history-check: '+status+'; full acceptance '+acceptance)
    for stage,row in statuses.items():print(stage+': '+row['status']+(('; '+row['reason']) if row.get('reason') else ''))
    print('mutants: '+str(sum(m['detected'] or 0 for m in evidence))+' detected; '+str(sum(bool(m['infrastructure_failures']) for m in evidence))+' infrastructure failures')
    print('timing: '+report['timing_status']+'; report tests/property/artifacts/report.json')
    return 1 if status=='BLOCK' else 2 if status=='INCONCLUSIVE' else 0


if __name__=='__main__':
    raise SystemExit(main())
