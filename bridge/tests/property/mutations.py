"""Process-local mutants: only assertion failures after activation are detections."""
import hashlib
import types
from pathlib import Path
from .support import ROOT


def source_mutant(relative, old, new, package='bridge.plan'):
    source=(ROOT / relative).read_text()
    if source.count(old)!=1:
        raise RuntimeError('mutation target did not match exactly once')
    module=types.ModuleType('u116_disposable_mutant')
    module.__package__=package
    module._mutation_activated=False
    exec(compile(source.replace(old,new),relative,'exec'),module.__dict__)
    return module


def assess(identifier, apply, activate, assertion):
    result=dict(id=identifier,applied=0,activated=0,detected=0,infrastructure_failures=[])
    try:
        target=apply()
        result['applied']=1
        value,witness=activate(target)
        result['activated']=int(witness is True)
        if not witness:
            raise RuntimeError('no activation witness')
        try:
            assertion(value)
        except AssertionError:
            result['detected']=1
    except Exception as error:
        result['infrastructure_failures'].append(type(error).__name__)
    return result


def tie_mutant():
    old='ordered = sorted(sortable, key=lambda e: (e.get("lamport"), e.get("id")))'
    new=('ordered = sorted(sortable, key=lambda e: e.get("lamport"))\n'
         '    globals()["_mutation_activated"] = any(a["lamport"] == b["lamport"] and a["id"] > b["id"] for a,b in zip(sortable, sortable[1:]))')
    return source_mutant('bridge/plan/fold.py',old,new)


def ownership_mutant():
    # Keep the unassigned, claim-fence and dependency gates intact; plant only
    # the foreign-owner bug in the current U109 micro.set branch.
    old='''        if assignee != agent:
            raise PlanError("claimed_by_other", "claimed")
        if "claim_lamport" in op and op["claim_lamport"] != task.get("claim_lamport"):'''
    new='''        globals()["_mutation_activated"] = globals()["_mutation_activated"] or assignee != agent
        if "claim_lamport" in op and op["claim_lamport"] != task.get("claim_lamport"):'''
    return source_mutant('bridge/plan/fold.py',old,new)


def sha(relative):
    return hashlib.sha256((ROOT / relative).read_bytes()).hexdigest()


def record(result):
    import json
    from .support import PUBLIC
    folder=PUBLIC/'artifacts';folder.mkdir(exist_ok=True)
    (folder/('mutation-'+result['id']+'.json')).write_text(json.dumps(result,indent=2)+'\n')
