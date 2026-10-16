"""Summarize recorded cases, preserving every run and repeat of each model."""
import argparse
import json
from collections import defaultdict
from pathlib import Path

from common import case_paths, child_counts, events, numeric, read_json, records, usage_of, write_json


def total(rows, key):
    values = [row[key] for row in rows if row.get(key) is not None]
    return sum(values) if values else None


def case_row(case):
    result = read_json(case / 'result.json')
    if not isinstance(result, dict) or 'executionStatus' not in result:
        return None
    captured = read_json(case / 'requests.json')
    calls = [call for call in records(captured) if call.get('kind') in ('execution', 'jev')]
    evaluation = read_json(case / 'evaluation.json')
    evaluation = evaluation if isinstance(evaluation, dict) else {}
    resolved = evaluation.get('resolved')
    if type(resolved) is not bool:
        resolved = result.get('resolved')
    lifecycle = records(read_json(case / 'decisions-and-children.json'))
    lifecycle += events(case / 'trial/native-events.jsonl') + events(case / 'trial/auto-events.jsonl')
    children = child_counts(lifecycle, calls)
    for key in children:
        if children[key] is None:
            children[key] = numeric(result.get(key))
    counts = {key: numeric(result.get(key)) for key in ('executionCalls', 'jevCalls', 'upstreamCalls')}
    if isinstance(captured, list):
        counts = {'executionCalls': sum(c['kind'] == 'execution' for c in calls),
                  'jevCalls': sum(c['kind'] == 'jev' for c in calls), 'upstreamCalls': len(calls)}
    return {'instance_id': result['instance_id'], 'arm': result['arm'],
            'resolved': resolved if type(resolved) is bool else None,
            'evaluationStatus': evaluation.get('status'), 'executionStatus': result['executionStatus'],
            'wallSeconds': numeric(result.get('solveAndExportSeconds')),
            'usage': [usage_of(call) for call in calls],
            'jevUsage': [usage_of(call) for call in calls if call['kind'] == 'jev'],
            **counts, **children}


def aggregate(rows, expected):
    usage = [entry for row in rows for entry in row['usage']]
    jev = [entry for row in rows for entry in row['jevUsage']]
    totals = {key: total(rows, key) for key in
              ('wallSeconds', 'executionCalls', 'jevCalls', 'upstreamCalls', 'childrenStarted', 'childrenCompleted')}
    return {'expectedCases': expected, 'completedCases': len(rows), 'missingCases': expected - len(rows),
            'resolved': sum(row['resolved'] is True for row in rows),
            'ungraded': sum(row['resolved'] is None for row in rows), **totals,
            **{key + 'Tokens': total(usage, key) for key in ('input', 'cached', 'uncached', 'output')},
            'jevInputTokens': total(jev, 'input'), 'jevOutputTokens': total(jev, 'output'),
            'measuredRequests': {key: sum(entry[key] is not None for entry in usage)
                                 for key in ('input', 'cached', 'uncached', 'output')}}


def fmt(value):
    return str(value) if value is not None else 'n/a'


def markdown(model, root, arms, groups, matrix):
    lines = [f'# {model} — {root}', '',
             '| arm | resolved | missing / ungraded | wall s | upstream calls | input | cached | uncached | output | Jev calls |',
             '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
    for arm in arms:
        group = groups[arm]
        lines.append(f"| {arm} | {group['resolved']}/{group['expectedCases']} | "
                     f"{group['missingCases']} / {group['ungraded']} | " + ' | '.join(fmt(group[key]) for key in
                     ('wallSeconds', 'upstreamCalls', 'inputTokens', 'cachedTokens', 'uncachedTokens',
                      'outputTokens', 'jevCalls')) + ' |')
    lines += ['', 'Token sums include only reported usage (execution + Jev); coverage is measured / upstream requests.', '',
              '| arm | input coverage | cached coverage | uncached coverage | output coverage |',
              '| --- | --- | --- | --- | --- |']
    for arm in arms:
        group = groups[arm]
        lines.append('| ' + arm + ' | ' + ' | '.join(
            f"{group['measuredRequests'][key]}/{fmt(group['upstreamCalls'])}"
            for key in ('input', 'cached', 'uncached', 'output')) + ' |')
    lines += ['', '## Per-task matrix', '', '| instance | repeat | ' + ' | '.join(arms) + ' |',
              '| --- | --- | ' + ' | '.join('---' for _ in arms) + ' |']
    for entry in matrix:
        lines.append('| ' + ' | '.join([entry['instance_id'], str(entry['repeat'])] +
                                      [entry['arms'][arm] for arm in arms]) + ' |')
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('roots', type=Path, nargs='+')
    args = parser.parse_args()
    summary = defaultdict(list)
    roots = list(dict.fromkeys(path.resolve() for path in args.roots))
    for root in roots:
        config = json.loads((root / 'run-config.json').read_text())
        tasks = json.loads((root / 'tasks.json').read_text())['tasks']
        arms, repeat, model = config['arms'], config['repeat'], config['model']
        cases, cells = [], {}
        for task, arm, k, path in case_paths(root, tasks, arms, repeat):
            row = case_row(path)
            cell = 'missing'
            if row is not None:
                row['repeat'] = k
                cases.append(row)
                cell = 'pass' if row['resolved'] is True else 'fail' if row['resolved'] is False else 'ungraded'
            cells[task['instance_id'], arm, k] = cell
        groups = {arm: aggregate([row for row in cases if row['arm'] == arm], len(tasks) * repeat) for arm in arms}
        matrix = [{'instance_id': task['instance_id'], 'repeat': k,
                   'arms': {arm: cells[task['instance_id'], arm, k] for arm in arms}}
                  for task in tasks for k in range(repeat)]
        report = {'model': model, 'run': str(root), 'arms': groups, 'perTask': matrix, 'cases': cases}
        summary[model].append(report)
        write_json(root / 'summary.json', report)
        (root / 'summary.md').write_text(markdown(model, root, arms, groups, matrix))
    if len(roots) > 1:
        write_json(roots[0].parent / 'bench-summary.json', summary)
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
