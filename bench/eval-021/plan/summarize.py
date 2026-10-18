"""Summarize recorded cases, preserving every run and repeat of each model."""
import argparse
import json
from collections import defaultdict
from pathlib import Path

from common import (case_paths, child_counts, cost_usd, events, model_price, numeric, read_json, records, usage_of,
                    write_json)


def total(rows, key):
    values = [row[key] for row in rows if row.get(key) is not None]
    return sum(values) if values else None


def upstream_of(call):
    upstream = call.get('upstream')
    if upstream in ('workbuddy', 'opencode-go', 'jev'):
        return upstream
    return 'jev' if call.get('kind') == 'jev' else 'workbuddy'


def priced(call):
    upstream = upstream_of(call)
    model = call.get('actualModel') or call.get('model')
    cost = 0.0 if upstream == 'jev' or call.get('refused') else cost_usd(model, usage_of(call))
    return upstream, model, cost


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
    model_calls = defaultdict(int)
    costs, paid_costs = [], []
    unpriced, unmeasured, paid_calls = 0, 0, 0
    for call in calls:
        upstream, model, cost = priced(call)
        model_calls[str(model or 'unknown')] += 1
        paid_calls += upstream == 'opencode-go'
        if cost is None:
            if model_price(model) is None:
                unpriced += 1
            else:
                unmeasured += 1
        else:
            costs.append(cost)
            if upstream == 'opencode-go':
                paid_costs.append(cost)
    available = isinstance(captured, list)
    cost = sum(costs) if available and (costs or not calls) else None
    paid = sum(paid_costs) if available and (paid_costs or not paid_calls) else None
    complete = available and not (unpriced or unmeasured)
    return {'instance_id': result['instance_id'], 'arm': result['arm'],
            'resolved': resolved if type(resolved) is bool else None,
            'evaluationStatus': evaluation.get('status'), 'executionStatus': result['executionStatus'],
            'wallSeconds': numeric(result.get('solveAndExportSeconds')),
            'usage': [usage_of(call) for call in calls],
            'jevUsage': [usage_of(call) for call in calls if call['kind'] == 'jev'],
            'costUSD': cost, 'paidCostUSD': paid,
            'costPerResolvedUSD': cost if resolved is True and complete else None,
            'paidCostPerResolvedUSD': paid if resolved is True and complete else None,
            'unpricedCalls': unpriced if available else None,
            'unmeasuredCalls': unmeasured if available else None,
            'costedCalls': len(costs) if available else None, 'costCoverageComplete': complete,
            'callsByModel': dict(model_calls) if available else None, **counts, **children}


def aggregate(rows, expected):
    usage = [entry for row in rows for entry in row['usage']]
    jev = [entry for row in rows for entry in row['jevUsage']]
    totals = {key: total(rows, key) for key in
              ('wallSeconds', 'executionCalls', 'jevCalls', 'upstreamCalls', 'childrenStarted', 'childrenCompleted')}
    resolved = sum(row['resolved'] is True for row in rows)
    cost, paid = total(rows, 'costUSD'), total(rows, 'paidCostUSD')
    complete = len(rows) == expected and all(row['costCoverageComplete'] for row in rows)
    model_calls = defaultdict(int)
    for row in rows:
        for model, count in (row['callsByModel'] or {}).items():
            model_calls[model] += count
    return {'expectedCases': expected, 'completedCases': len(rows), 'missingCases': expected - len(rows),
            'resolved': resolved,
            'ungraded': sum(row['resolved'] is None for row in rows), **totals,
            'costUSD': cost, 'paidCostUSD': paid,
            'costPerResolvedUSD': cost / resolved if cost is not None and resolved and complete else None,
            'paidCostPerResolvedUSD': paid / resolved if paid is not None and resolved and complete else None,
            'unpricedCalls': total(rows, 'unpricedCalls'), 'callsByModel': dict(model_calls),
            'unmeasuredCalls': total(rows, 'unmeasuredCalls'), 'costedCalls': total(rows, 'costedCalls'),
            'costCoverageComplete': complete,
            **{key + 'Tokens': total(usage, key)
               for key in ('input', 'cached', 'uncached', 'cacheWrite', 'output')},
            'jevInputTokens': total(jev, 'input'), 'jevOutputTokens': total(jev, 'output'),
            'measuredRequests': {key: sum(entry[key] is not None for entry in usage)
                                 for key in ('input', 'cached', 'uncached', 'cacheWrite', 'output')}}


def fmt(value):
    return str(value) if value is not None else 'n/a'


def money(value):
    return f'{value:.4f}' if value is not None else 'n/a'


def markdown(model, root, arms, groups, matrix):
    lines = [f'# {model} — {root}', '',
             '| arm | resolved | missing / ungraded | wall s | upstream calls | input | cached | uncached | '
             'cache write | output | Jev calls | cost USD | paid USD | USD / resolved | unpriced | unmeasured | cost complete |',
             '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
    for arm in arms:
        group = groups[arm]
        lines.append(f"| {arm} | {group['resolved']}/{group['expectedCases']} | "
                     f"{group['missingCases']} / {group['ungraded']} | " + ' | '.join(fmt(group[key]) for key in
                     ('wallSeconds', 'upstreamCalls', 'inputTokens', 'cachedTokens', 'uncachedTokens',
                      'cacheWriteTokens', 'outputTokens', 'jevCalls')) + ' | ' + ' | '.join(
                     money(group[key]) for key in ('costUSD', 'paidCostUSD', 'costPerResolvedUSD')) + ' | ' +
                     ' | '.join(fmt(group[key]) for key in
                                ('unpricedCalls', 'unmeasuredCalls', 'costCoverageComplete')) + ' |')
    lines += ['', 'Token sums include only reported usage (execution + Jev); coverage is measured / upstream requests.',
              'Costs sum fully measured, priced calls only; incomplete coverage is flagged. '
              'Cost per resolved task requires complete coverage.', '',
              '| arm | input coverage | cached coverage | uncached coverage | cache write coverage | output coverage |',
              '| --- | --- | --- | --- | --- | --- |']
    for arm in arms:
        group = groups[arm]
        lines.append('| ' + arm + ' | ' + ' | '.join(
            f"{group['measuredRequests'][key]}/{fmt(group['upstreamCalls'])}"
            for key in ('input', 'cached', 'uncached', 'cacheWrite', 'output')) + ' |')
    lines += ['', '## Calls per model', '', '| arm | model | calls |', '| --- | --- | --- |']
    for arm in arms:
        for name, count in sorted(groups[arm]['callsByModel'].items()):
            lines.append(f'| {arm} | {name} | {count} |')
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
