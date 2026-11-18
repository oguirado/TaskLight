"""Independent invariants and deterministic history/shrinking utilities."""
import copy
import hashlib
import json
import random
from pathlib import Path

from bridge.plan.fold import fold_plan
from bridge.plan.limits import PIPELINE_TEMPLATE
from bridge.plan.template import load_template
from bridge.room.store import _is_valid_event

ROOT = Path(__file__).resolve().parents[3]
PUBLIC = ROOT / 'tests/property'
VERSION = 'u116-history-v1'
BASE = 1700000000000
TEMPLATE = json.loads((PUBLIC / 'template.json').read_text())
TEMPLATES = {TEMPLATE['id']: TEMPLATE}
ALPHABET = ('plan.open', 'plan.close', 'plan.phase', 'task.add', 'task.set',
            'task.claim', 'task.release', 'micro.set', 'memory.set',
            'activity.beat', 'agent.lifecycle', 'question')
MANDATORY = frozenset(('open', 'add', 'claim', 'activate', 'foreign_write_rejected',
    'beat', 'retired_beat', 'release', 'reclaim', 'takeover_boundary_rejected',
    'takeover_after_boundary', 'cancel', 'cancel_satisfies_dependency', 'complete',
    'close', 'reopen', 'memory', 'memory_survives_reopen', 'room_traffic', 'retry',
    'duplicate', 'arrival_reordering', 'equal_lamport', 'restart', 'hostile_lamport',
    'reserved_lifecycle'))


def canonical(value):
    # Only object keys are normalized. Lists, nulls, absent keys are untouched.
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def event(n, op=None, *, agent='alice', ts=None, **extra):
    value = dict(id='e-%016x' % n, lamport=n, ts=BASE+n if ts is None else ts,
                 room='oracle', agent=agent, act='op', text='')
    if op is not None:
        value['op'] = copy.deepcopy(op)
    value.update(extra)
    return value


def opening():
    return dict(kind='plan.open', title='Plan', template_id=TEMPLATE['id'],
                template_hash=TEMPLATE['hash'], brief={'goal': 'Deliver'}, phase='start')


def adding(**fields):
    return dict(dict(kind='task.add', title='Action', type='action', phase='start',
                     microtasks=[dict(text='Step', accept='Verified')]), **fields)


def history(seed, steps=128):
    """A dependency-preserving semantic spine, followed by seeded mixed traffic.

    All clocks are event data. Neither the generator nor oracle calls a fold.
    The ordered spine makes successful transitions observable before late arrival.
    """
    if not 38 <= steps <= 128:
        raise ValueError('steps must cover the mandatory spine and be at most 128')
    rng = random.Random(seed)
    events = []
    def put(op=None, **kw):
        e = event(len(events)+1, op, **kw)
        events.append(e)
        return e
    put(opening())                                                    # 1
    put(adding())                                                     # 2
    put(adding(deps=['T01']))                                         # 3
    claim = put(dict(kind='task.claim', task_id='T01', op_id='claim-first')) # 4
    put(dict(kind='micro.set', micro_id='T01.M01', state='active'))    # 5
    put(dict(kind='micro.set', micro_id='T01.M01', state='done'), agent='bob') # 6 reject
    put(dict(kind='activity.beat', task_id='T01', run_id='r1', op_id='beat-first')) # 7
    put(dict(kind='activity.beat', task_id='T01', run_id='r2', op_id='beat-second')) # 8
    put(dict(kind='activity.beat', task_id='T01', run_id='r1', op_id='beat-retired')) # 9
    put(dict(kind='task.release', task_id='T01'))                       # 10
    put(dict(kind='task.claim', task_id='T01'))                         # 11
    put(dict(kind='memory.set', section='notes', text='Remember', base_rev=0)) # 12
    put(None, act='question', text='Passive status data')              # 13
    put(copy.deepcopy(claim['op']))                                   # 14 replay
    put(dict(kind='task.claim', task_id='T01', takeover=True), agent='bob', ts=BASE+600014) # 15 reject
    put(dict(kind='task.claim', task_id='T01', takeover=True), agent='bob', ts=BASE+600015) # 16 accept
    put(dict(kind='task.set', task_id='T01', base_rev=16, state='cancelled'), agent='bob') # 17
    put(dict(kind='task.claim', task_id='T02'))                         # 18
    put(dict(kind='micro.set', micro_id='T02.M01', state='active'))    # 19
    put(dict(kind='micro.set', micro_id='T02.M01', state='done'))      # 20
    put(dict(kind='plan.close', base_rev=1, outcome='Verified'))        # 21
    put(opening())                                                    # 22
    put(adding())                                                     # 23
    events.append(copy.deepcopy(events[22]))                          # 24 duplicate ID
    put(dict(kind='agent.lifecycle', state='deployed', run_id='r1'))    # 25 reserved
    put(dict(kind='micro.set', micro_id='T01.M01', state='active'), lamport=True) # 26 hostile
    a = put(None, act='question', text='Tie a')                        # 27
    b = put(None, act='question', text='Tie b', lamport=a['lamport'])   # 28
    events[-2:] = [b, a]
    put(None, act='heartbeat', text='Legacy data, never a lifecycle fact')
    for _ in range(steps-len(events)):
        choice = rng.randrange(7)
        if choice == 0:
            put(None, act='question', text='Question %d' % rng.randrange(99))
        elif choice == 1:
            put(dict(kind='micro.set', micro_id='T01.M01', state=rng.choice(['pending','active','blocked','done'])))
        elif choice == 2:
            put(dict(kind='task.claim', task_id='T01'), agent=rng.choice(['alice','bob']))
        elif choice == 3:
            put(dict(kind='memory.set', section='notes', text='Memo %d' % seed, base_rev=12))
        elif choice == 4:
            events.append(copy.deepcopy(rng.choice(events)))
        elif choice == 5:
            put(dict(kind='activity.beat', task_id='T01', run_id='r3', op_id='beat-%08d' % len(events)))
        else:
            put(dict(kind='task.release', task_id='T01'), agent=rng.choice(['alice','bob']))
    # Reorder the seeded tail while retaining each semantic spine observation.
    tail = events[29:]
    rng.shuffle(tail)
    return events[:29] + tail


def first_difference(a, b, path='$'):
    if type(a) is not type(b) and not (type(a) in (int,float) and type(b) in (int,float)):
        return path
    if isinstance(a, dict):
        for key in sorted(set(a) | set(b)):
            if key not in a or key not in b:
                return path+'.'+key
            diff = first_difference(a[key], b[key], path+'.'+key)
            if diff:
                return diff
    elif isinstance(a, list):
        if len(a) != len(b):
            return path+'.length'
        for i, (left, right) in enumerate(zip(a,b)):
            diff = first_difference(left, right, '%s[%d]' % (path,i))
            if diff:
                return diff
    elif a != b:
        return path
    return None


def eligible(events):
    seen = set()
    ordered = sorted((e for e in events if isinstance(e,dict) and isinstance(e.get('id'),str)
                      and type(e.get('lamport')) is int and 1 <= e['lamport'] <= 9007199254740991),
                     key=lambda e:(e['lamport'],e['id']))
    result = []
    for e in ordered:
        if e['id'] not in seen:
            result.append(e)
            seen.add(e['id'])
    return result


def invariant(events, projection):
    """A public-shape oracle independent of both implementations."""
    assert set(projection) == {'plan','tasks','memory','archived_plans','rollup','replayed_ops','rejected','last_lamport'}
    ops = [e for e in eligible(events) if e.get('act') == 'op']
    assert projection['last_lamport'] == max((e['lamport'] for e in ops), default=0), 'watermark'
    tasks = projection['tasks']
    assert [t['id'] for t in tasks] == ['T%02d' % (i+1) for i in range(len(tasks))], 'task IDs'
    by_id = {t['id']: t for t in tasks}
    for task in tasks:
        micros = task['microtasks']
        explicit = task['explicit_state']
        state = ('cancelled' if explicit == 'cancelled' else 'blocked' if explicit == 'blocked' or any(m['state']=='blocked' for m in micros)
                 else 'done' if micros and all(m['state']=='done' for m in micros)
                 else 'active' if any(m['state'] in ('active','done') for m in micros) else 'pending')
        assert task['state'] == state, 'derived state'
        ready = state not in ('done','cancelled') and all(d in by_id and by_id[d]['state'] in ('done','cancelled') for d in task['deps'])
        assert task['ready'] is ready, 'dependency readiness'
        assert [m['id'] for m in micros] == ['%s.M%02d' % (task['id'],i+1) for i in range(len(micros))]
        assert task['rev'] <= projection['last_lamport']
        for micro in micros:
            assert micro['rev'] <= task['rev']
            if 'live' in micro:
                assert micro['state']=='active' and micro['live']['agent']==task['assignee']
    r = projection['rollup']
    assert r['tasks_total']==len(tasks)
    assert r['tasks_done']==sum(t['state']=='done' for t in tasks), 'cancelled is not done'
    assert r['tasks_ready']==sum(t['ready'] for t in tasks)
    assert r['tasks_blocked']==sum(t['state']=='blocked' for t in tasks)
    assert r['micro_total']==sum(len(t['microtasks']) for t in tasks)
    assert r['micro_done']==sum(m['state']=='done' for t in tasks for m in t['microtasks'])
    assert r['progress'] == (r['micro_done']/r['micro_total'] if r['micro_total'] else 0)
    assert r['progress_pct'] == int(r['progress']*100)
    ordered_ids = [e['id'] for e in ops]
    rejected = projection['rejected']
    assert all(r['id'] in ordered_ids for r in rejected)
    assert [ordered_ids.index(r['id']) for r in rejected] == sorted(ordered_ids.index(r['id']) for r in rejected)
    for key, mem in projection['memory'].items():
        assert mem['id']==key and mem['rev'] <= projection['last_lamport']


def ownership_prerequisites(events):
    claims = [(i,e) for i,e in enumerate(events) if e.get('op',{}).get('kind')=='task.claim']
    return any(any(w.get('op',{}).get('kind')=='micro.set' and w.get('agent') != c.get('agent')
                   for w in events[i+1:]) for i,c in claims) and any(e.get('op',{}).get('kind')=='task.add' for e in events)


def _journal_op(event):
    op = event.get('op')
    return op if event.get('act') == 'op' and isinstance(op, dict) else {}


def _repair_checkpoint(events, templates):
    """Observe a retained operation at its logical position in the journal."""
    target = events[-1]
    op = _journal_op(target)
    opening_id = None
    task_origins = {}
    deployments = {}
    terminals = {}
    receipts = {}
    replayed = False

    def observe(event, state, disposition):
        nonlocal opening_id, replayed
        if disposition is None:
            return
        agent = event['agent']
        operation = event['op']
        if operation.get('op_id') is not None:
            receipts.setdefault((agent, operation['op_id']), event['id'])
        if event is target:
            replayed = disposition.get('replayed', False)
        if disposition.get('replayed') or disposition.get('noop'):
            return
        kind = operation['kind']
        if kind == 'plan.open':
            opening_id = event['id']
            task_origins.clear()
        elif kind == 'task.add':
            task_origins[state['tasks'][-1]['id']] = event['id']
        elif kind == 'agent.lifecycle':
            run = (agent, operation['run_id'])
            if operation['state'] == 'deployed':
                deployments[run] = event['id']
            elif operation['state'] in ('finished', 'failed'):
                terminals[run] = event['id']

    state = fold_plan(events, templates=templates, _observe=observe)
    rejection = next((row['code'] for row in state['rejected'] if row['id'] == target['id']), None)
    agent, op_id = target.get('agent'), op.get('op_id')
    receipt = receipts.get((agent, op_id)) if isinstance(agent, str) and isinstance(op_id, str) else None
    disposition = (rejection, replayed, receipt)

    def lineage(agent, run_id):
        if isinstance(agent, str) and isinstance(run_id, str):
            run = (agent, run_id)
            return deployments.get(run), terminals.get(run)

    if op['kind'] == 'agent.lifecycle':
        return (disposition, lineage(agent, op.get('run_id')),
                lineage(op.get('parent_agent'), op.get('parent_run_id')))

    task_id = op.get('task_id')
    if task_id is None and isinstance(op.get('micro_id'), str):
        task_id = op['micro_id'].split('.', 1)[0]
    task = next((row for row in state['tasks'] if row['id'] == task_id), {})
    steps = [
        (step['binding'], [
            (attempt['lamport'], attempt['result_agent'], attempt['result_run_id'],
             attempt['state'], attempt.get('terminal'), attempt.get('decision', {}).get('lamport'))
            for attempt in step['attempts']
        ])
        for step in task.get('pipeline', {}).get('steps', ())
    ]
    plan = state['plan'] or {}
    return (
        disposition, (opening_id, plan.get('opened_lamport'), plan.get('state')),
        tuple(task_origins.items()), tuple(task.get('deps', ())),
        [(micro['id'], micro['state']) for micro in task.get('microtasks', ())],
        steps, [(row['lamport'], row['verdict']) for row in task.get('decisions', ())],
        lineage(op.get('result_agent', op.get('agent')), op.get('result_run_id', op.get('run_id'))),
    )


def _repair_replay_guard(events):
    ordered = eligible(events)
    if not any(op.get('kind') == 'plan.open' and op.get('template_id') == PIPELINE_TEMPLATE
               for op in map(_journal_op, ordered)):
        return lambda _: True

    template = load_template(ROOT / 'templates/planning' / f'{PIPELINE_TEMPLATE}.json')
    templates = {**TEMPLATES, PIPELINE_TEMPLATE: template}
    original_ids = {event['id'] for event in ordered}
    kinds = ('task.add', 'task.set', 'task.claim', 'task.release', 'micro.add', 'micro.set',
             'unit.bind', 'unit.repair', 'unit.decision', 'agent.lifecycle')
    expected = {
        event['id']: _repair_checkpoint(ordered[:index + 1], templates)
        for index, event in enumerate(ordered)
        if _journal_op(event).get('kind') in kinds
    }

    def preserves_replay(trial):
        ordered_trial = eligible(trial)
        retained_ids = {event['id'] for event in ordered_trial}
        for event in ordered_trial:
            reference = event.get('re')
            if isinstance(reference, str) and reference in original_ids - retained_ids:
                return False
        # Compare per operation so later retries and independent rejections can
        # disappear without taking a retained witness's causal context with them.
        for index in range(len(ordered_trial) - 1, -1, -1):
            event = ordered_trial[index]
            event_id = event['id']
            if _journal_op(event).get('kind') not in kinds:
                if event_id in expected:
                    return False
                continue
            if event_id not in expected or _repair_checkpoint(ordered_trial[:index + 1], templates) != expected[event_id]:
                return False
        return True

    return preserves_replay


def shrink(events, fails, prerequisites=lambda _: True):
    """Shrink a witnessed failure while preserving retained repair checkpoints."""
    result = copy.deepcopy(events)
    assert prerequisites(result) and fails(result), 'shrink needs a witnessed failure'
    preserves_replay = _repair_replay_guard(result)

    def admissible(trial):
        return prerequisites(trial) and fails(trial) and preserves_replay(trial)

    changed = True
    while changed:
        changed = False
        for i in range(len(result)):
            trial = result[:i]+result[i+1:]
            if admissible(trial):
                result=trial; changed=True; break
    for i in range(len(result)):
        for container in ('op', None):
            source = result[i].get('op',{}) if container else result[i]
            if not isinstance(source, dict):
                continue
            for key in sorted(list(source)):
                if key not in ('title','text','accept','outcome','reason','note','estimate'):
                    continue
                candidates=('', 'x') if isinstance(source[key],str) else (None,)
                for simplified in candidates:
                    if isinstance(simplified,str) and len(simplified)>=len(source[key]):
                        continue
                    trial=copy.deepcopy(result)
                    obj=trial[i]['op'] if container else trial[i]
                    obj[key]=simplified
                    if trial == result:
                        continue
                    # A malformed replacement can yield the same rejection as
                    # a well-formed stale reference but cannot replay from disk.
                    if _is_valid_event(result[i]) and not _is_valid_event(trial[i]):
                        continue
                    if admissible(trial):
                        result=trial
                        break
    return result
