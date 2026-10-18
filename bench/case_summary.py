#!/usr/bin/env python3
"""One-case summary (metadata only): outcome, model/effort per role, children, theoretical cost and prefix reuse.

Costs and cache rates are theoretical estimates at catalog prices (models.json), not billed costs.
Prefix reuse is the exact theoretical method (observer message hashes, same cache space, same case).

Usage: case_summary.py CASE_DIR [CASE_DIR ...]
"""
import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import theoretical_cost as tc  # noqa: E402
import report  # noqa: E402

MODELS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'models.json')


def summarize(case):
    document = json.load(open(MODELS))
    prices = {m['id']: m['price'] for m in document['models'] if m.get('price')}
    result = json.load(open(os.path.join(case, 'result.json')))
    requests = json.load(open(os.path.join(case, 'requests.json')))
    roles = report.child_roles(case)
    calls = collections.Counter()
    for r in requests:
        calls[(report.role_of(r, roles), r.get('actualModel') or r.get('model'), r.get('effort') or 'default')] += 1
    records = json.load(open(os.path.join(case, 'decisions-and-children.json')))
    totals = tc.case_totals(case, prices, document.get('jev', {}), None)
    method = 'exact' if totals['exact_cases'] else 'log'
    theo = tc.summary(totals, method)
    decisions = [{k: r.get(k) for k in ('kind', 'model', 'effort', 'provider', 'profile', 'choice', 'reason')
                  if r.get(k) is not None} for r in records
                 if r.get('kind') in ('delegation_decision', 'delegation_declined', 'child_start', 'model_choice')]
    return {
        'case': case, 'executionStatus': result.get('executionStatus'), 'resolved': result.get('resolved'),
        'executionCalls': result.get('executionCalls'), 'jevCalls': result.get('jevCalls'),
        'childrenStarted': result.get('childrenStarted'),
        'callsByRoleModelEffort': {' | '.join(k): v for k, v in sorted(calls.items())},
        'delegationRecords': decisions,
        'theoretical': {'method': theo['method'], 'usd': {k: round(v, 5) for k, v in theo['usd'].items()},
                        'cacheRateExecutor': round(theo['cacheRateMain'], 4),
                        'cacheRateChildren': round(theo['cacheRateChildren'], 4),
                        'unpricedRequests': theo['unpricedRequests'], 'label': theo['label']},
    }


if __name__ == '__main__':
    for case in sys.argv[1:]:
        print(json.dumps(summarize(case), indent=1))
