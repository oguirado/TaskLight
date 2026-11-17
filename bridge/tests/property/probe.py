"""JSON-only Python adapter, used by the independent Vitest project."""
import copy
import json
import sys
from bridge.plan.fold import fold_plan
from .support import TEMPLATES, VERSION, digest, history, invariant


def prefixes(events, templates):
    values=[]
    original=copy.deepcopy((events,templates))
    for i in range(len(events)+1):
        p=fold_plan(events[:i],templates=templates)
        invariant(events[:i],p)
        values.append(p)
    assert (events,templates)==original, 'Python fold mutated its inputs'
    return values


def main():
    request=json.load(sys.stdin)
    mode=request['mode']
    if mode=='generated':
        result=[]
        for seed in range(request['seeds']):
            events=history(seed,request['steps'])
            result.append(dict(seed=seed,events=events,hash=digest(events),prefixes=prefixes(events,TEMPLATES)))
        json.dump(dict(version=VERSION,cases=result),sys.stdout)
    elif mode=='vectors':
        json.dump([dict(projection=fold_plan(c['events'],templates=c['templates']),
                        prefixes=prefixes(c['events'],c['templates'])) for c in request['cases']],sys.stdout)
    elif mode=='fold':
        json.dump(fold_plan(request['events'],templates=request.get('templates',TEMPLATES)),sys.stdout)
    else:
        raise ValueError('unknown adapter mode')


if __name__=='__main__':
    main()
