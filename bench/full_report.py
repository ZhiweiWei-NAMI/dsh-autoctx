#!/usr/bin/env python3
"""Full-evaluation comparison (metadata only; theoretical cost, not billed).

Walks one evaluation root (e.g. results/full-<commit>) for case directories <task>/<arm> holding result.json, skipping
_infra-archive. A case is valid when it has no infra-error.json and, for arm A, no Jev transport failure. For each
executor x arm: valid cases, official resolved rate, wall time, execution/Jev requests and theoretical USD (catalog
prices, exact-prefix reuse, same assumptions for every arm; see singlecase_export.export). Paired comparisons per
executor match the same (task, repeat) across arms; differences are A minus the other arm, with a percentile
bootstrap 95% interval over tasks (task-level means across repeats; 10000 resamples, fixed seed).

Usage: full_report.py ROOT [--json OUT] [--md OUT]
"""
import json
import os
import random
import re
import statistics
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import singlecase_export  # noqa: E402

ARMS = ('B', 'C', 'A')
LABEL = {'A': 'AutoCTX', 'B': 'single agent (plugin off)', 'C': 'native subagents (plugin off)'}


def jev_transport(case):
    try:
        calls = json.loads((case / 'requests.json').read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return 0
    return sum(1 for c in calls if c.get('kind') == 'jev' and c.get('httpStatus') != 200 and c.get('transportError'))


def repeat_of(case):
    for part in case.parts:
        m = re.fullmatch(r'repeat-(\d+)', part)
        if m:
            return int(m.group(1)) + 1
        m = re.match(r'[ABC]-r(\d+)-lane\d+', part)
        if m:
            return int(m.group(1))
    return 1


def cases(root):
    for result in sorted(root.glob('**/result.json')):
        case = result.parent
        if '_infra-archive' in case.parts or case.name not in ARMS or 'plugin' in case.parts:
            continue
        yield case


def collect(root):
    rows = []
    for case in cases(root):
        e = singlecase_export.export(str(case), None)
        invalid = []
        if (case / 'infra-error.json').exists():
            invalid.append('infra-error')
        if case.name == 'A' and jev_transport(case):
            invalid.append('jev-transport')
        rows.append({'executor': e['executor'], 'arm': case.name, 'task': case.parent.name, 'repeat': repeat_of(case),
                     'valid': not invalid, 'invalid': invalid, 'resolved': e['official']['resolved'] is True,
                     'graded': e['official']['status'] is not None, 'status': e['executionStatus'],
                     'wall': e['agentWallSeconds'], 'usd': e['theoreticalTotalUSD'],
                     'requests': e['executionRequests'], 'jev': e['jevRequests'] or 0, 'children': e['childrenStarted'] or 0})
    return rows


def mean(xs):
    return round(statistics.fmean(xs), 4) if xs else None


def bootstrap(diffs, n=10000, seed=1):
    if len(diffs) < 2:
        return None
    rnd = random.Random(seed)
    means = sorted(statistics.fmean(rnd.choices(diffs, k=len(diffs))) for _ in range(n))
    return [round(means[int(0.025 * n)], 4), round(means[int(0.975 * n) - 1], 4)]


def summarize(rows):
    out = {'arms': [], 'paired': []}
    executors = sorted({r['executor'] for r in rows})
    for ex in executors:
        for arm in ARMS:
            mine = [r for r in rows if r['executor'] == ex and r['arm'] == arm]
            ok = [r for r in mine if r['valid']]
            out['arms'].append({
                'executor': ex, 'arm': arm, 'label': LABEL[arm], 'cases': len(mine), 'valid': len(ok),
                'invalid': len(mine) - len(ok), 'ungraded': sum(1 for r in ok if not r['graded']),
                'resolved': sum(r['resolved'] for r in ok),
                'resolvedRate': round(sum(r['resolved'] for r in ok) / len(ok), 4) if ok else None,
                'timeouts': sum(1 for r in ok if r['status'] not in ('finished', None)),
                'meanWallSeconds': mean([r['wall'] for r in ok if r['wall'] is not None]),
                'medianWallSeconds': round(statistics.median([r['wall'] for r in ok]), 1) if ok else None,
                'meanUSD': mean([r['usd'] for r in ok]), 'totalUSD': round(sum(r['usd'] for r in ok), 4),
                'meanExecRequests': mean([r['requests'] for r in ok if r['requests'] is not None]),
                'meanJevRequests': mean([r['jev'] for r in ok]), 'meanChildren': mean([r['children'] for r in ok]),
            })
        for other in ('B', 'C'):
            key = lambda r: (r['task'], r['repeat'])
            a = {key(r): r for r in rows if r['executor'] == ex and r['arm'] == 'A' and r['valid']}
            o = {key(r): r for r in rows if r['executor'] == ex and r['arm'] == other and r['valid']}
            pairs = [(a[k], o[k]) for k in sorted(a.keys() & o.keys())]
            if not pairs:
                continue
            tasks = sorted({k[0] for k in a.keys() & o.keys()})
            per_task = {m: [statistics.fmean(f(x, y) for (x, y) in pairs if x['task'] == t) for t in tasks] for m, f in {
                'resolved': lambda x, y: int(x['resolved']) - int(y['resolved']),
                'wall': lambda x, y: x['wall'] - y['wall'],
                'usd': lambda x, y: x['usd'] - y['usd']}.items()}
            out['paired'].append({
                'executor': ex, 'comparison': f'A vs {other}', 'pairs': len(pairs), 'tasks': len(tasks),
                'aResolvedOnly': sum(1 for x, y in pairs if x['resolved'] and not y['resolved']),
                'otherResolvedOnly': sum(1 for x, y in pairs if y['resolved'] and not x['resolved']),
                'bothResolved': sum(1 for x, y in pairs if x['resolved'] and y['resolved']),
                'neitherResolved': sum(1 for x, y in pairs if not x['resolved'] and not y['resolved']),
                'meanResolvedDiff': mean(per_task['resolved']), 'resolvedDiffCI95': bootstrap(per_task['resolved']),
                'meanWallDiffSeconds': mean(per_task['wall']), 'wallDiffCI95': bootstrap(per_task['wall']),
                'aFasterPairs': sum(1 for x, y in pairs if x['wall'] < y['wall']),
                'meanUSDDiff': mean(per_task['usd']), 'usdDiffCI95': bootstrap(per_task['usd']),
                'aCheaperPairs': sum(1 for x, y in pairs if x['usd'] < y['usd']),
            })
    return out


def markdown(summary, title):
    lines = [f'# {title}', '', 'Theoretical cost at catalog list prices (not billed); official SWE-bench grading. '
             'Invalid = infra-affected after reruns (excluded).', '',
             '| Executor | Arm | Valid / cases | Resolved | Rate | Non-finished | Mean wall s | Median wall s | Mean USD | Total USD | Mean exec req | Mean Jev req | Mean children |',
             '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
    for a in summary['arms']:
        lines.append(f"| {a['executor']} | {a['arm']} {a['label']} | {a['valid']} / {a['cases']} | {a['resolved']} | {a['resolvedRate']} | {a['timeouts']} | "
                     f"{a['meanWallSeconds']} | {a['medianWallSeconds']} | {a['meanUSD']} | {a['totalUSD']} | {a['meanExecRequests']} | {a['meanJevRequests']} | {a['meanChildren']} |")
    lines += ['', '## Paired (same task and repeat; A minus other arm; 95% bootstrap CI over task means)', '',
              '| Executor | Comparison | Pairs (tasks) | A only / other only / both / neither resolved | Resolved diff [CI] | Wall diff s [CI] | A faster | USD diff [CI] | A cheaper |',
              '|---|---|---|---|---|---|---:|---|---:|']
    for p in summary['paired']:
        lines.append(f"| {p['executor']} | {p['comparison']} | {p['pairs']} ({p['tasks']}) | {p['aResolvedOnly']} / {p['otherResolvedOnly']} / {p['bothResolved']} / {p['neitherResolved']} | "
                     f"{p['meanResolvedDiff']} {p['resolvedDiffCI95']} | {p['meanWallDiffSeconds']} {p['wallDiffCI95']} | {p['aFasterPairs']}/{p['pairs']} | "
                     f"{p['meanUSDDiff']} {p['usdDiffCI95']} | {p['aCheaperPairs']}/{p['pairs']} |")
    return '\n'.join(lines) + '\n'


def main():
    root = Path(sys.argv[1]).resolve()
    args = sys.argv[2:]
    rows = collect(root)
    summary = summarize(rows)
    summary['cases'] = rows
    if '--json' in args:
        Path(args[args.index('--json') + 1]).write_text(json.dumps(summary, indent=1) + '\n')
    md = markdown(summary, f'Full evaluation: {root.name}')
    if '--md' in args:
        Path(args[args.index('--md') + 1]).write_text(md)
    print(md)


if __name__ == '__main__':
    main()
