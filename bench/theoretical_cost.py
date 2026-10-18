#!/usr/bin/env python3
"""Theoretical prompt-cache rates and costs for bench runs. These are estimates, not billed costs.

Provider-reported cached tokens vary with routing, accounts and eviction, so arms are compared on the cache they
could reuse given exactly what they sent. The same assumptions and prices apply to every arm:

- A request reuses the longest prefix it shares with an earlier request of the same case in the same cache space
  (model + thinking/effort configuration [+ tools for the exact method]), across sessions; no expiry within a case
  unless --ttl is given; message-level granularity; no account split or minimum cacheable length.
- Prices from models.json: uncached input at `input` (or `cacheWrite` where listed), reused input at `cacheRead`,
  output at `output`. Jev requests are priced from the catalog's `jev` table by their model, no cache.
- Executor (role main), child and Jev costs are reported separately and summed.

Methods:
- exact: the observer's cumulative per-message prefix hashes (messageHashes/configHash/toolsHash). Prefix token counts
  come from requests whose full input equals that prefix, so reuse is a lower bound when no such request exists.
- log: only per-request order, session, model, effort and token counts. Input grows append-only within a session;
  a drop marks a context rewrite, after which a space reuses only the session's first request. Runs recorded before
  prefix hashes existed can only use this method.

Usage: theoretical_cost.py [--ttl SECONDS] [--models models.json] NAME=GLOB [NAME=GLOB ...]
  GLOB matches per-case arm directories holding result.json and requests.json, e.g.
  'B=results/deepseek-v4.1-flash/bc-r1/*/B'.
"""
import argparse
import collections
import glob
import json
import os

JEV_FALLBACK = {'input': 0.042, 'output': 0}


def space_config(r):
    extras = r.get('bodyExtras') or {}
    thinking = (extras.get('thinking') or {}).get('type') if isinstance(extras.get('thinking'), dict) else extras.get('thinking')
    return (r.get('effort') or extras.get('reasoning_effort'), thinking)


def log_method(requests, ttl):
    reused, sessions = {}, {}
    for r in requests:
        s = sessions.setdefault(r.get('session'), {'last': None, 'epoch': 0, 'base': r['inputTokens'], 'spaces': {}})
        if s['last'] is not None and r['inputTokens'] < s['last']:
            s['epoch'] += 1
        space = (r.get('actualModel') or r.get('model'), space_config(r))
        seen = s['spaces'].get(space)
        shared = 0
        if seen and (ttl is None or r['startedUnix'] - seen['t'] <= ttl):
            shared = seen['input'] if seen['epoch'] == s['epoch'] else s['base']
        reused[id(r)] = min(shared, r['inputTokens'])
        s['spaces'][space] = {'input': r['inputTokens'], 'epoch': s['epoch'],
                              't': r['startedUnix'] + (r.get('elapsedSeconds') or 0)}
        s['last'] = r['inputTokens']
    return reused


def exact_method(requests, ttl):
    if not requests or not all(r.get('messageHashes') for r in requests):
        return None
    prefix_tokens = collections.defaultdict(dict)
    for r in requests:
        prefix_tokens[(r.get('actualModel') or r.get('model'), r.get('toolsHash'))][r['messageHashes'][-1]] = r['inputTokens']
    seen, reused = collections.defaultdict(dict), {}
    for r in requests:
        model = r.get('actualModel') or r.get('model')
        space, hashes = (model, r.get('configHash'), r.get('toolsHash')), r['messageHashes']
        k = 0
        for i in range(len(hashes) - 1, -1, -1):
            t = seen[space].get(hashes[i])
            if t is not None and (ttl is None or r['startedUnix'] - t <= ttl):
                k = i + 1
                break
        shared, table = 0, prefix_tokens[(model, r.get('toolsHash'))]
        for i in range(k - 1, -1, -1):
            if hashes[i] in table:
                shared = table[hashes[i]]
                break
        reused[id(r)] = min(shared, r['inputTokens'])
        end = r['startedUnix'] + (r.get('elapsedSeconds') or 0)
        for h in hashes:
            seen[space][h] = end
    return reused


def case_totals(case_dir, prices, jev_prices, ttl):
    result = json.load(open(os.path.join(case_dir, 'result.json')))
    raw = json.load(open(os.path.join(case_dir, 'requests.json')))
    raw = raw if isinstance(raw, list) else raw.get('requests', [])
    jev = [r for r in raw if r.get('kind') == 'jev']
    calls = [r for r in raw if r.get('kind') != 'jev']
    priced = sorted((r for r in calls if r.get('inputTokens') is not None), key=lambda r: r.get('startedUnix') or 0)
    c = collections.Counter(cases=1, resolved=result.get('resolved') is True, graded=result.get('resolved') is not None,
                            missingUsage=len(calls) - len(priced), jevCalls=len(jev))
    for r in jev:
        p = jev_prices.get(r.get('actualModel')) or jev_prices.get(r.get('model')) or JEV_FALLBACK
        c['usd_jev'] += ((r.get('inputTokens') or 0) * p['input'] + (r.get('outputTokens') or 0) * p.get('output', 0)) / 1e6
    for name, reused in (('log', log_method(priced, ttl)), ('exact', exact_method(priced, ttl))):
        if reused is None:
            continue
        c[name + '_cases'] = 1
        for r in priced:
            role = 'main' if r.get('role') == 'main' else 'child'
            hit = reused[id(r)]
            c[f'{name}_in_{role}'] += r['inputTokens']
            c[f'{name}_hit_{role}'] += hit
            p = prices.get(r.get('actualModel')) or prices.get(r.get('model'))
            if p is None:
                c[name + '_unpriced'] += 1
                continue
            c[f'{name}_usd_{role}'] += ((r['inputTokens'] - hit) * p.get('cacheWrite', p['input']) + hit * p['cacheRead']
                                        + (r.get('outputTokens') or 0) * p['output']) / 1e6
    return c


def summary(c, method):
    def rate(roles):
        total = sum(c[f'{method}_in_{r}'] for r in roles)
        return sum(c[f'{method}_hit_{r}'] for r in roles) / total if total else 0.0
    usd = {'executor': c[f'{method}_usd_main'], 'children': c[f'{method}_usd_child'], 'jev': c['usd_jev']}
    return {'method': method, 'cases': c['cases'], 'resolved': c['resolved'], 'missingUsage': c['missingUsage'],
            'unpricedRequests': c[method + '_unpriced'], 'cacheRateMain': rate(['main']), 'cacheRateAll': rate(['main', 'child']),
            'usd': {**usd, 'total': sum(usd.values())}, 'label': 'theoretical estimate, not billed cost'}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('arms', nargs='+', metavar='NAME=GLOB')
    parser.add_argument('--models', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'models.json'))
    parser.add_argument('--ttl', type=float, default=None, help='cache lifetime in seconds since last use (default: none)')
    parser.add_argument('--json', help='also write the summaries to this file')
    args = parser.parse_args()
    document = json.load(open(args.models))
    prices = {m['id']: m['price'] for m in document['models'] if m.get('price')}
    jev_prices = document.get('jev', {})
    out = {}
    print('Theoretical estimates, not billed costs. USD at catalog prices; same cache assumptions for every arm.')
    print(f"{'arm':28s}{'method':>7s}{'cases':>6s}{'res':>5s}{'cache main':>11s}{'cache all':>10s}"
          f"{'exec $':>9s}{'child $':>9s}{'Jev $':>8s}{'total $':>9s}{'$/res':>8s}{'noUsage':>8s}")
    for spec in args.arms:
        name, pattern = spec.split('=', 1)
        dirs = sorted(d for d in glob.glob(pattern) if os.path.exists(os.path.join(d, 'result.json')))
        total = sum((case_totals(d, prices, jev_prices, args.ttl) for d in dirs), collections.Counter())
        out[name] = {}
        for method in ('exact', 'log'):
            if total[method + '_cases'] != total['cases'] or not total['cases']:
                continue
            s = summary(total, method)
            out[name][method] = s
            print(f"{name:28s}{method:>7s}{s['cases']:>6d}{s['resolved']:>5d}{s['cacheRateMain']:>11.1%}{s['cacheRateAll']:>10.1%}"
                  f"{s['usd']['executor']:>9.3f}{s['usd']['children']:>9.3f}{s['usd']['jev']:>8.3f}{s['usd']['total']:>9.3f}"
                  f"{s['usd']['total'] / max(s['resolved'], 1):>8.4f}{s['missingUsage']:>8d}")
    if args.json:
        json.dump(out, open(args.json, 'w'), indent=2)


if __name__ == '__main__':
    main()
