#!/usr/bin/env python3
"""Benchmark comparison: quality, theoretical cost, theoretical cache rates and model-call frequencies per arm, plus a figure.

Costs and cache rates come from theoretical_cost.py (theoretical estimates at catalog prices, not billed costs). Every
denominator is stated: resolved per graded case, cost per arm over all its cases, calls per case.

Usage: report.py SPEC.json [--json OUT.json] [--figure OUT.png]
SPEC: {"arms": [{"name": "AutoCTX 1.2.5 frozen", "dirs": ["results/*/label-r1/*/A", ...]}, ...]}
"""
import argparse
import collections
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import theoretical_cost as tc  # noqa: E402

ROLE_ORDER = ('executor', 'compaction', 'reviewer', 'advisor', 'worker', 'subagent', 'jev')


def child_roles(case_dir):
    """AutoCTX child session -> reviewer/advisor/worker from the plugin's records; anything else is a native subagent."""
    path = os.path.join(case_dir, 'decisions-and-children.json')
    if not os.path.exists(path):
        return {}
    roles, pending = {}, None
    for record in json.load(open(path)):
        kind = record.get('kind')
        if kind == 'review_start':
            pending = 'reviewer'
        elif kind == 'advisor_start':
            pending = 'advisor'
        elif kind == 'child_start' and record.get('provider') and record.get('id'):
            roles[record['id']] = pending or 'worker'
            pending = None
    return roles


def role_of(request, roles):
    if request.get('kind') == 'jev':
        return 'jev'
    if request.get('role') == 'main':
        return 'executor'
    if request.get('role') == 'compaction':
        return 'compaction'
    return roles.get(request.get('session'), 'subagent' if not roles else 'worker')


def arm_metrics(name, patterns, prices, jev_prices):
    dirs = sorted({d for p in patterns for d in glob.glob(p) if os.path.exists(os.path.join(d, 'result.json'))})
    totals = collections.Counter()
    calls = collections.Counter()
    resolved_by_model = collections.Counter()
    cases_by_model = collections.Counter()
    children = collections.Counter()
    for d in dirs:
        result = json.load(open(os.path.join(d, 'result.json')))
        totals += tc.case_totals(d, prices, jev_prices, None)
        model = result.get('model')
        cases_by_model[model] += 1
        resolved_by_model[model] += result.get('resolved') is True
        children['started'] += result.get('childrenStarted') or 0
        children['casesWithChild'] += bool(result.get('childrenStarted'))
        roles = child_roles(d)
        for request in json.load(open(os.path.join(d, 'requests.json'))):
            calls[(role_of(request, roles), request.get('actualModel') or request.get('model'))] += 1
    method = 'exact' if totals['exact_cases'] == totals['cases'] else 'log'
    summary = tc.summary(totals, method)
    n = totals['cases']
    by_role = collections.Counter()
    for (role, _), count in calls.items():
        by_role[role] += count
    return {
        'name': name, 'cases': n, 'resolved': totals['resolved'], 'graded': totals['graded'],
        'resolvedByModel': {m: [resolved_by_model[m], cases_by_model[m]] for m in sorted(cases_by_model)},
        'theoretical': summary, 'childrenStarted': children['started'], 'casesWithChild': children['casesWithChild'],
        'callsPerCase': {role: by_role[role] / n for role in ROLE_ORDER if by_role[role]},
        'callsPerCaseByRoleModel': {f'{role} | {model}': count / n for (role, model), count in
                                    sorted(calls.items(), key=lambda kv: (ROLE_ORDER.index(kv[0][0]), -kv[1]))},
        'missingUsage': totals['missingUsage'],
    }


def figure(arms, path):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt

    ink, ink2, grid, surface = '#0b0b0b', '#52514e', '#e4e3df', '#fcfcfb'
    colors = {'executor': '#2a78d6', 'children': '#eb6834', 'jev': '#1baf7a', 'compaction': '#eda100'}
    labels = {'executor': 'Executor', 'children': 'Children (reviewer/advisor/worker/subagent)', 'jev': 'Jev',
              'compaction': 'Native compaction'}
    names = [a['name'] for a in arms]
    x = range(len(arms))
    plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 9, 'axes.edgecolor': grid, 'axes.labelcolor': ink2,
                         'xtick.color': ink2, 'ytick.color': ink2, 'text.color': ink})
    fig, axes = plt.subplots(2, 2, figsize=(11, 7.4), dpi=170, facecolor=surface)
    for ax in axes.flat:
        ax.set_facecolor(surface)
        ax.grid(axis='y', color=grid, linewidth=0.8)
        ax.set_axisbelow(True)
        for side in ('top', 'right', 'left'):
            ax.spines[side].set_visible(False)
        ax.tick_params(length=0)
        ax.set_xticks(list(x), names)

    def stacked(ax, parts, fmt):
        bottoms = [0.0] * len(arms)
        for key, values in parts:
            ax.bar(x, values, 0.56, bottom=bottoms, color=colors[key], edgecolor=surface, linewidth=1.5, label=labels[key])
            bottoms = [b + v for b, v in zip(bottoms, values)]
        for i, total in enumerate(bottoms):
            ax.text(i, total, fmt(total), ha='center', va='bottom', fontsize=9, color=ink, fontweight='bold')
        ax.set_ylim(0, max(bottoms) * 1.15)

    ax = axes[0][0]
    values = [a['resolved'] for a in arms]
    ax.bar(x, values, 0.56, color=ink2, edgecolor=surface)
    for i, a in enumerate(arms):
        ax.text(i, a['resolved'], f"{a['resolved']}/{a['cases']}", ha='center', va='bottom', fontsize=9, fontweight='bold')
    ax.set_ylim(0, max(a['cases'] for a in arms))
    ax.set_title('A. Resolved cases (official SWE-bench harness)', loc='left', fontsize=10, color=ink)

    ax = axes[0][1]
    stacked(ax, [(k, [a['theoretical']['usd'][k] for a in arms])
                 for k in ('executor', 'compaction', 'children', 'jev')], lambda v: f'${v:.2f}')
    ax.set_title(f"B. Theoretical cost, USD per {arms[0]['cases']} cases (catalog prices)", loc='left', fontsize=10, color=ink)

    ax = axes[1][0]
    width = 0.28
    for offset, key, field in ((-width / 2, 'executor', 'cacheRateMain'), (width / 2, 'children', 'cacheRateChildren')):
        for i, a in enumerate(arms):
            value = a['theoretical'][field] * 100
            has = field == 'cacheRateMain' or a['childrenStarted'] > 0
            if has:
                ax.bar(i + offset, value, width, color=colors[key], edgecolor=surface, linewidth=1.5)
                note = '' if key == 'executor' else f"\n{a['childrenStarted']} child{'' if a['childrenStarted'] == 1 else 'ren'}"
                ax.text(i + offset, value, f'{value:.0f}%{note}', ha='center', va='bottom', fontsize=8)
            else:
                ax.text(i + offset, 3, 'no\nchildren', ha='center', va='bottom', fontsize=7, color=ink2)
    ax.set_ylim(0, 112)
    ax.set_title('C. Theoretical prompt-cache hit rate (token-weighted)', loc='left', fontsize=10, color=ink)

    ax = axes[1][1]
    stacked(ax, [(k, [sum(v for r, v in a['callsPerCase'].items() if (r == k) or (k == 'children' and r in
                  ('reviewer', 'advisor', 'worker', 'subagent'))) for a in arms])
                 for k in ('executor', 'compaction', 'children', 'jev')], lambda v: f'{v:.1f}')
    ax.set_title('D. Model calls per case, by role', loc='left', fontsize=10, color=ink)

    handles = [plt.Rectangle((0, 0), 1, 1, color=colors[k]) for k in ('executor', 'compaction', 'children', 'jev')]
    fig.legend(handles, [labels[k] for k in ('executor', 'compaction', 'children', 'jev')], loc='upper center', ncol=4,
               frameon=False, bbox_to_anchor=(0.5, 0.995))
    methods = sorted({f"{a['name']}: {a['theoretical']['method']}" for a in arms})
    fig.text(0.01, 0.005, 'Costs and cache rates are theoretical estimates at catalog prices, not actual bills. Prefix-reuse method: '
             + '; '.join(methods) + '.', fontsize=7.5, color=ink2)
    fig.tight_layout(rect=(0, 0.025, 1, 0.955))
    fig.savefig(path, facecolor=surface)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('spec')
    parser.add_argument('--models', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'models.json'))
    parser.add_argument('--json')
    parser.add_argument('--figure')
    args = parser.parse_args()
    spec = json.load(open(args.spec))
    document = json.load(open(args.models))
    prices = {m['id']: m['price'] for m in document['models'] if m.get('price')}
    arms = [arm_metrics(a['name'], a['dirs'], prices, document.get('jev', {})) for a in spec['arms']]
    for a in arms:
        t = a['theoretical']
        print(f"{a['name']:24s} res {a['resolved']}/{a['cases']}  theoretical ${t['usd']['total']:.3f} ({t['method']})  "
              f"cache exec {t['cacheRateMain']:.1%} children {t['cacheRateChildren']:.1%}  children started {a['childrenStarted']} "
              f"in {a['casesWithChild']} cases  calls/case {json.dumps({k: round(v, 2) for k, v in a['callsPerCase'].items()})}")
    if args.json:
        json.dump(arms, open(args.json, 'w'), indent=1)
    if args.figure:
        figure(arms, args.figure)


if __name__ == '__main__':
    main()
