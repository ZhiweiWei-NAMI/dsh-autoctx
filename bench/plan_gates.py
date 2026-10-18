#!/usr/bin/env python3
"""Plan-mode smoke gates for one benchmark case directory (metadata only; no prompts or contents printed).

Gates: a plan recorded; a child started; same-model prefix reuse observed (theoretical, exact message-hash prefix
between the child's first request and an earlier parent request in the same cache space); every plugin-appended
message source-labelled; Jev calls counted by the observer.

Usage: plan_gates.py CASE_DIR [CASE_DIR ...]
"""
import json
import os
import sys


def load(case, name):
    path = os.path.join(case, name)
    return json.load(open(path)) if os.path.exists(path) else []


def shared(a, b):
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def gates(case):
    records = load(case, 'decisions-and-children.json')
    requests = load(case, 'requests.json')
    result = json.load(open(os.path.join(case, 'result.json'))) if os.path.exists(os.path.join(case, 'result.json')) else {}
    kinds = [r.get('kind') for r in records]
    plans = [r for r in records if r.get('kind') == 'plan_recorded']
    assignments = [r for r in records if r.get('kind') == 'child_assignment']
    starts = {r.get('id') for r in records if r.get('kind') == 'child_start' and r.get('provider')}
    appended = [r for r in records if r.get('kind') == 'message_appended']
    executions = [r for r in requests if r.get('kind') == 'execution']
    root = [r for r in executions if r.get('role') == 'main']
    reuse = []
    for a in assignments:
        child = a.get('child')
        mine = [r for r in executions if child and child in (r.get('session') or '')]
        if not mine or not mine[0].get('messageHashes'):
            reuse.append({'child': child, 'sameSpace': a.get('sameSpace'), 'requests': len(mine), 'observed': None})
            continue
        first = mine[0]
        earlier = [r for r in root if r.get('startedUnix', 0) <= first.get('startedUnix', 0) and r.get('messageHashes')]
        compatible = [r for r in earlier if r.get('configHash') == first.get('configHash') and r.get('toolsHash') == first.get('toolsHash')]
        best = max((shared(r['messageHashes'], first['messageHashes']) for r in compatible), default=0)
        reuse.append({'child': child, 'sameSpace': a.get('sameSpace'), 'option': a.get('contextOption'),
                      'requests': len(mine), 'configMatch': bool([r for r in earlier if r.get('configHash') == first.get('configHash')]),
                      'toolsMatch': bool([r for r in earlier if r.get('toolsHash') == first.get('toolsHash')]),
                      'sharedMessages': best, 'childFirstMessages': len(first['messageHashes']), 'observed': best > 0})
    same = [r for r in reuse if r.get('sameSpace')]
    out = {
        'case': case,
        'status': result.get('executionStatus'),
        'resolved': result.get('resolved'),
        'plan_recorded': len(plans),
        'delegated': sum(p.get('delegated', 0) for p in plans),
        'child_started': len(starts),
        'assignments': len(assignments),
        'reuse': reuse,
        'appended': len(appended),
        'appended_unlabelled': sum(1 for r in appended if not r.get('label')),
        'jev_calls_observer': sum(1 for r in requests if r.get('kind') == 'jev'),
        'jev_calls_result': result.get('jevCalls'),
        'executor_requests': len(root),
        'child_requests': sum(1 for r in executions if r.get('role') != 'main'),
        'kinds': {k: kinds.count(k) for k in sorted(set(kinds)) if k and (k.startswith('plan') or k.startswith('child') or k in ('dispatch_queued', 'message_appended', 'route_learning'))},
    }
    out['gates'] = {
        'plan_recorded': out['plan_recorded'] > 0,
        'child_started': out['child_started'] > 0,
        'same_model_prefix_reuse_observed': bool(same) and all(r.get('observed') for r in same),
        'appended_messages_labelled': out['appended'] > 0 and out['appended_unlabelled'] == 0,
        'jev_calls_counted': out['jev_calls_result'] is not None and out['jev_calls_result'] == out['jev_calls_observer'],
    }
    return out


if __name__ == '__main__':
    for case in sys.argv[1:]:
        print(json.dumps(gates(case), indent=1))
