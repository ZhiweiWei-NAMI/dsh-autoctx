#!/usr/bin/env python3
"""Full-evaluation comparison (metadata only; theoretical cost, not billed).

Walks one evaluation root (e.g. results/full-<commit>) for case directories <task>/<arm> holding result.json, skipping
_infra-archive. A case is valid when it has no infra-error.json and, for arm A, no `jev_unavailable` (Jev fell back
after the plugin's own retry). For each
executor x arm: valid cases, official resolved rate, wall time, execution/Jev requests and theoretical USD (catalog
prices, exact-prefix reuse, same assumptions for every arm; see singlecase_export.export). Paired comparisons per
executor match the same (task, repeat) across arms; differences are A minus the other arm, with a percentile
bootstrap 95% interval over tasks (task-level means across repeats; 10000 resamples, fixed seed). Reruns after infra
errors are counted per arm from _infra-archive; because long runs are likelier to hit a transient error, a
sensitivity table repeats the paired comparison without any pair that involved a rerun.

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
    """Jev fell back after the plugin's own retry (`jev_unavailable`); retried-and-recovered calls are valid."""
    try:
        records = json.loads((case / 'decisions-and-children.json').read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return 0
    return sum(1 for r in records if r.get('kind') == 'jev_unavailable')


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


def reruns(root):
    """(executor, arm, task, repeat) keys with archived infra-affected attempts, and the attempt counts. Archived
    attempts are counted by their infra-reasons.json (some were archived before writing result.json)."""
    archive = root / '_infra-archive'
    counts = {}
    for reasons in archive.glob('**/infra-reasons.json'):
        case = reasons.parent
        key = (case.relative_to(archive).parts[0], case.name.split('-')[0], case.parent.name, repeat_of(case))
        counts[key] = counts.get(key, 0) + 1
    return counts


def collect(root):
    rows = []
    for case in cases(root):
        e = singlecase_export.export(str(case), None)
        invalid = []
        if (case / 'infra-error.json').exists():
            invalid.append('infra-error')
        if case.name == 'A' and jev_transport(case):
            invalid.append('jev-unavailable')
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


def paired(rows, ex, other, exclude):
    """A vs other on the same (task, repeat); pairs where either arm has a key in `exclude` are dropped."""
    key = lambda r: (r['task'], r['repeat'])
    skip = {(t, k) for (e, _, t, k) in exclude if e == ex}
    a = {key(r): r for r in rows if r['executor'] == ex and r['arm'] == 'A' and r['valid']}
    o = {key(r): r for r in rows if r['executor'] == ex and r['arm'] == other and r['valid']}
    keys = sorted((a.keys() & o.keys()) - skip)
    pairs = [(a[k], o[k]) for k in keys]
    if not pairs:
        return None
    tasks = sorted({k[0] for k in keys})
    per_task = {m: [statistics.fmean(f(x, y) for (x, y) in pairs if x['task'] == t) for t in tasks] for m, f in {
        'resolved': lambda x, y: int(x['resolved']) - int(y['resolved']),
        'wall': lambda x, y: x['wall'] - y['wall'],
        'usd': lambda x, y: x['usd'] - y['usd']}.items()}
    return {
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
    }


def summarize(rows, rerun_keys=None):
    rerun_keys = rerun_keys or {}
    out = {'arms': [], 'paired': [], 'pairedCleanOnly': []}
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
                'casesRerun': sum(1 for k in rerun_keys if k[0] == ex and k[1] == arm),
                'archivedAttempts': sum(n for k, n in rerun_keys.items() if k[0] == ex and k[1] == arm),
            })
        for clean in (False, True):
            for other in ('B', 'C'):
                p = paired(rows, ex, other, rerun_keys if clean else {})
                if p:
                    out['pairedCleanOnly' if clean else 'paired'].append(p)
    return out


def markdown(summary, title):
    lines = [f'# {title}', '', 'Theoretical cost at catalog list prices (not billed); official SWE-bench grading. '
             'Invalid = infra-affected after reruns (excluded).', '',
             '| Executor | Arm | Valid / cases | Ungraded | Resolved | Rate | Non-finished | Mean wall s | Median wall s | Mean USD | Total USD | Mean exec req | Mean Jev req | Mean children | Cases rerun (archived attempts) |',
             '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
    for a in summary['arms']:
        lines.append(f"| {a['executor']} | {a['arm']} {a['label']} | {a['valid']} / {a['cases']} | {a['ungraded']} | {a['resolved']} | {a['resolvedRate']} | {a['timeouts']} | "
                     f"{a['meanWallSeconds']} | {a['medianWallSeconds']} | {a['meanUSD']} | {a['totalUSD']} | {a['meanExecRequests']} | {a['meanJevRequests']} | {a['meanChildren']} | {a['casesRerun']} ({a['archivedAttempts']}) |")
    for name, title in (('paired', 'Paired (same task and repeat; A minus other arm; 95% bootstrap CI over task means)'),
                        ('pairedCleanOnly', 'Sensitivity: paired, excluding pairs where either arm was rerun after an infra error')):
        lines += ['', f'## {title}', '',
                  '| Executor | Comparison | Pairs (tasks) | A only / other only / both / neither resolved | Resolved diff [CI] | Wall diff s [CI] | A faster | USD diff [CI] | A cheaper |',
                  '|---|---|---|---|---|---|---:|---|---:|']
        for p in summary[name]:
            lines.append(f"| {p['executor']} | {p['comparison']} | {p['pairs']} ({p['tasks']}) | {p['aResolvedOnly']} / {p['otherResolvedOnly']} / {p['bothResolved']} / {p['neitherResolved']} | "
                         f"{p['meanResolvedDiff']} {p['resolvedDiffCI95']} | {p['meanWallDiffSeconds']} {p['wallDiffCI95']} | {p['aFasterPairs']}/{p['pairs']} | "
                         f"{p['meanUSDDiff']} {p['usdDiffCI95']} | {p['aCheaperPairs']}/{p['pairs']} |")
    return '\n'.join(lines) + '\n'


def main():
    root = Path(sys.argv[1]).resolve()
    args = sys.argv[2:]
    rows = collect(root)
    summary = summarize(rows, reruns(root))
    summary['cases'] = rows
    if '--json' in args:
        Path(args[args.index('--json') + 1]).write_text(json.dumps(summary, indent=1) + '\n')
    md = markdown(summary, f'Full evaluation: {root.name}')
    if '--md' in args:
        Path(args[args.index('--md') + 1]).write_text(md)
    print(md)


if __name__ == '__main__':
    main()
