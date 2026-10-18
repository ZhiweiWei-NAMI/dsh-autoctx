#!/usr/bin/env python3
"""Anonymous single-case cost/time export from existing benchmark records (no prompts, credentials or payloads).

For each case: official grading status and time, agent wall time, actual model/effort per role, token totals,
theoretical reused tokens (exact prefix method, same case, same cache space, no expiry) and the catalog prices
used, so the theoretical cost can be recomputed independently:
  usd = (input - reused) * uncachedRate + reused * cacheRead + output * output   (per 1M tokens)
  uncachedRate = cacheWrite where the model lists one, else input. Jev: input * jev.input + output * jev.output.
Costs are theoretical estimates at catalog list prices, not billed amounts.

Usage: singlecase_export.py OUT_DIR [--mechanism] [--title TITLE] LABEL=CASE_DIR[@COMMIT] ... [--separate LABEL=CASE_DIR:REASON ...]
  --mechanism adds mechanism_check.py counts: theoretical reuse split into within-session and cross-agent,
  per-child seeding/cache-space facts and heuristic exploration counts.
"""
import collections
import hashlib
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import theoretical_cost as tc  # noqa: E402
import report  # noqa: E402

MODELS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'models.json')


def run_root_file(case, name):
    """Nearest ancestor of a case directory holding NAME (run roots are <root>/<task>/<arm> or <root>/repeat-k/<task>/<arm>)."""
    directory = os.path.dirname(os.path.abspath(case))
    while directory != os.path.dirname(directory):
        if os.path.exists(os.path.join(directory, name)):
            return os.path.join(directory, name)
        directory = os.path.dirname(directory)
    raise FileNotFoundError(name + ' above ' + case)


def prompt_hash(case):
    """sha256 of the exact harness prompt for this case (harness prompt_for, recorded task); the text is never written."""
    import importlib.util
    harness = os.environ.get('BENCH_HARNESS_RUN', 'harness-plan/run.py')
    spec = importlib.util.spec_from_file_location('bench_run', harness)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    result = json.load(open(os.path.join(case, 'result.json')))
    tasks = json.load(open(run_root_file(case, 'tasks.json')))
    task = next(t for t in (tasks['tasks'] if isinstance(tasks, dict) else tasks) if t['instance_id'] == result['instance_id'])
    return 'sha256:' + hashlib.sha256(module.prompt_for(task, result['arm']).encode()).hexdigest()


def export(case, commit):
    document = json.load(open(MODELS))
    prices = {m['id']: m['price'] for m in document['models'] if m.get('price')}
    jev_prices = document.get('jev', {})
    result = json.load(open(os.path.join(case, 'result.json')))
    evaluation = json.load(open(os.path.join(case, 'evaluation.json'))) if os.path.exists(os.path.join(case, 'evaluation.json')) else {}
    raw = json.load(open(os.path.join(case, 'requests.json')))
    roles = report.child_roles(case)
    calls = [r for r in raw if r.get('kind') != 'jev' and r.get('inputTokens') is not None]
    calls.sort(key=lambda r: r.get('startedUnix') or 0)
    # Primary basis: same model + identical serialized content (tools + system + messages); effort is recorded
    # separately and not assumed to split the cache. The effort-split figure is kept as a provider assumption.
    reused = tc.exact_method(calls, None, space='content')
    split = tc.exact_method(calls, None, space='config') or {}
    method = 'exact'
    if reused is None:
        reused, method = tc.log_method(calls, None), 'log'
    rows = collections.defaultdict(lambda: collections.Counter())
    used_prices, choices = {}, collections.Counter()
    for r in calls:
        role = r.get('role') if r.get('role') in ('main', 'compaction') else 'child'
        model = r.get('actualModel') or r.get('model')
        key = (role, model)
        hit = reused[id(r)]
        rows[key].update(requests=1, inputTokens=r['inputTokens'], reusedTokens=hit,
                         reusedTokensIfEffortSplitsCache=split.get(id(r), hit),
                         observedProviderCachedTokens=r.get('cachedTokens') or 0,
                         outputTokens=r.get('outputTokens') or 0)
        p = prices.get(model)
        if p:
            used_prices[model] = {k: p[k] for k in ('input', 'cacheRead', 'cacheWrite', 'output') if k in p}
            rows[key]['usd'] += ((r['inputTokens'] - hit) * p.get('cacheWrite', p['input']) + hit * p['cacheRead']
                                 + (r.get('outputTokens') or 0) * p['output']) / 1e6
        else:
            rows[key]['unpricedRequests'] += 1
        choices[(report.role_of(r, roles), model, r.get('effort') or 'none-sent')] += 1
    for r in raw:
        if r.get('kind') != 'jev':
            continue
        model = r.get('actualModel') or r.get('model')
        p = jev_prices.get(model) or tc.JEV_FALLBACK
        used_prices[model] = {'input': p['input'], 'output': p.get('output', 0)}
        rows[('jev', model)].update(requests=1, inputTokens=r.get('inputTokens') or 0, outputTokens=r.get('outputTokens') or 0)
        rows[('jev', model)]['usd'] += ((r.get('inputTokens') or 0) * p['input'] + (r.get('outputTokens') or 0) * p.get('output', 0)) / 1e6
        choices[('jev', model, 'none-sent')] += 1
    by_role = [{'role': role, 'model': model, **{k: (round(v, 6) if k == 'usd' else v) for k, v in c.items()}}
               for (role, model), c in sorted(rows.items())]
    total = sum(c['usd'] for c in rows.values())
    try:
        run_config_path = run_root_file(case, 'run-config.json')
    except FileNotFoundError:
        run_config_path = ''
    run_config = json.load(open(run_config_path)) if os.path.exists(run_config_path) else {}
    status, code = result.get('executionStatus'), result.get('agentExitCode')
    termination = ({'finished': 'agent exited normally (exit 0)',
                    'timeout': f"killed by the harness at the {run_config.get('taskTimeoutSeconds')} s task timeout",
                    'agent_error': f'agent exited with code {code}'}.get(status, status))
    return {
        'arm': result.get('arm'), 'instance': result.get('instance_id'), 'executor': result.get('model'),
        'testedCommit': commit, 'runtime': 'DSH 0.2.1-rc.2 (node-dsh-021) in the task container; WorkBuddy via bench relay',
        'promptHash': prompt_hash(case), 'promptHashBasis': 'sha256 of harness-plan prompt_for(task, arm) output',
        'official': {'resolved': evaluation.get('resolved', result.get('resolved')), 'status': evaluation.get('status'),
                     'harnessVersion': evaluation.get('harnessVersion')},
        'executionStatus': status, 'agentExitCode': code, 'terminationReason': termination,
        'executionRequestLimitExcludingJev': run_config.get('executionRequestLimitExcludingJev'),
        'jevRequestLimit': run_config.get('jevRequestLimit'), 'taskTimeoutSeconds': run_config.get('taskTimeoutSeconds'),
        'agentWallSeconds': result.get('executionSeconds'), 'gradingSeconds': evaluation.get('evaluationSeconds'),
        'environmentPreparationSeconds': result.get('taskEnvironmentPreparationSeconds'),
        'childrenStarted': result.get('childrenStarted'), 'executionRequests': result.get('executionCalls'),
        'jevRequests': result.get('jevCalls'),
        'modelEffortByRole': [{'role': role, 'model': model, 'effort': effort, 'requests': n}
                              for (role, model, effort), n in sorted(choices.items())],
        'tokensAndCostByRole': by_role, 'prices': used_prices, 'reuseMethod': method,
        'reuseBasis': 'same model and identical serialized content (tools block + system + messages), message-level exact '
                      'hashes; effort/thinking not assumed to split the cache. reusedTokensIfEffortSplitsCache is the '
                      'provider-specific assumption that they do. observedProviderCachedTokens is what the provider reported.',
        'theoreticalTotalUSD': round(total, 6),
        'costLabel': 'theoretical estimate at catalog list prices, not billed cost',
    }


def main():
    out = sys.argv[1]
    cases, separate = [], []
    target = cases
    mechanism, title = False, 'pytest-10051 single-case cost and time (anonymous metadata)'
    argv = iter(sys.argv[2:])
    for arg in argv:
        if arg == '--mechanism':
            mechanism = True
            continue
        if arg == '--title':
            title = next(argv)
            continue
        if arg == '--separate':
            target = separate
            continue
        target.append(arg)
    os.makedirs(out, exist_ok=True)
    summary = {'formula': __doc__.split('\n\n')[1], 'cases': [], 'separateAttempts': []}
    for arg in cases:
        label, rest = arg.split('=', 1)
        case, _, commit = rest.partition('@')
        entry = {'label': label, **export(case, commit or None)}
        if mechanism:
            import mechanism_check
            m = mechanism_check.check(case)
            entry.update(reuseByAgent=m['reuseByAgent'], reuseTotals=m['reuseTotals'], children=m['children'],
                         exploration=m['exploration'], parentWork=m['parentWork'], mechanismReuseBasis=m['reuseBasis'], mechanismLabel=m['label'])
        summary['cases'].append(entry)
    for arg in separate:
        label, rest = arg.split('=', 1)
        case, _, reason = rest.partition(':')
        entry = {'label': label, 'reason': reason}
        if os.path.exists(os.path.join(case, 'result.json')):
            r = json.load(open(os.path.join(case, 'result.json')))
            entry.update(executionStatus=r.get('executionStatus'), childrenStarted=r.get('childrenStarted'),
                         executionRequests=r.get('executionCalls'), jevRequests=r.get('jevCalls'))
        elif os.path.exists(os.path.join(case, 'infra-error.json')):
            r = json.load(open(os.path.join(case, 'infra-error.json')))
            entry.update(executionStatus=r.get('executionStatus'), infraErrors=r.get('infraErrors'))
        else:
            entry.update(executionStatus='no record (directory absent)')
        summary['separateAttempts'].append(entry)
    json.dump(summary, open(os.path.join(out, 'summary.json'), 'w'), indent=1)
    lines = ['# ' + title, '',
             'Theoretical estimates at catalog list prices, not billed cost. ' + summary['formula'].replace('\n', ' '), '',
             '| Arm | Commit | Prompt hash | Resolved | Status | Agent wall s | Grading s | Children | Exec req | Jev req | Theoretical USD |',
             '|---|---|---|---|---|---:|---:|---:|---:|---:|---:|']
    for c in summary['cases']:
        lines.append(f"| {c['label']} | {c['testedCommit'] or '-'} | {(c['promptHash'] or '-')[:19]}… | {c['official']['resolved']} | "
                     f"{c['executionStatus']} | {c['agentWallSeconds']} | {c['gradingSeconds']} | {c['childrenStarted']} | "
                     f"{c['executionRequests']} | {c['jevRequests']} | {c['theoreticalTotalUSD']:.5f} |")
    lines += ['', '## Run conditions and termination', '',
              '| Arm | Exec request limit (excl. Jev) | Jev limit | Task timeout s | Exit code | Termination |', '|---|---:|---:|---:|---:|---|']
    for c in summary['cases']:
        lines.append(f"| {c['label']} | {c['executionRequestLimitExcludingJev']} | {c['jevRequestLimit']} | {c['taskTimeoutSeconds']} | "
                     f"{c['agentExitCode'] if c['agentExitCode'] is not None else '-'} | {c['terminationReason']} |")
    if mechanism:
        lines += ['', '## Theoretical prefix reuse: within-session vs cross-agent', '',
                  'Basis: same model and identical serialized content (tools block + system + messages), message-level exact hashes; '
                  'effort/thinking settings are not assumed to split the cache. Within-session: longest prefix shared with an earlier '
                  'request of the same session. Cross-agent: extra prefix available only from another session (parent, child or sibling). '
                  'Token counts are lower bounds. "If effort splits" repeats the split under the provider-specific assumption that '
                  'effort/thinking settings separate caches. "Observed" is the provider-reported cached tokens (not used for pricing).', '',
                  '| Arm | Agent | Requests | Input | Within-session | Cross-agent | Within / cross if effort splits | Observed provider cached |',
                  '|---|---|---:|---:|---:|---:|---|---:|']
        for c in summary['cases']:
            rows = list(c['reuseByAgent'].items()) + [('**all**', c['reuseTotals'])]
            for who, r in rows:
                lines.append(f"| {c['label']} | {who} | {r['requests']} | {r['inputTokens']} | {r.get('withinSession', 0)} | {r.get('crossAgent', 0)} | "
                             f"{r.get('withinSessionIfEffortSplitsCache', 0)} / {r.get('crossAgentIfEffortSplitsCache', 0)} | {r.get('observedProviderCachedTokens', 0)} |")
        lines += ['', '## Children', '',
                  '| Arm | Child | Provider | Model | Effort (child / parent at start) | Seeded with parent history | Tools match parent | Requests | First request: messages shared with another session / total | First request: shared tokens / input / observed cached | Inspection calls | On parent-known files |',
                  '|---|---|---|---|---|---|---|---:|---|---|---:|---:|']
        for c in summary['cases']:
            for ch in c['children']:
                lines.append(f"| {c['label']} | {ch['child']} | {ch['provider']} | {ch['model']} | {ch['effort']} / {ch['parentEffortAtStart']} | "
                             f"{ch['seededWithParentHistory']} | {ch['toolsMatchParent']} | {ch['requests']} | "
                             f"{ch['firstRequestSharedPrefixWithOtherSession']} / {ch['firstRequestMessages']} | "
                             f"{ch['firstRequestSharedPrefixTokens']} / {ch['firstRequestInputTokens']} / {ch['firstRequestObservedProviderCachedTokens']} | "
                             f"{ch['inspectionCalls']} | {ch['inspectionCallsOnParentKnownFiles']} |")
        lines += ['', '## Child redundancy (own calls only; inherited seed calls excluded)', '',
                  'A seeded child session begins with copies of the parent\'s events; those tool calls are the parent\'s work and are '
                  'not counted for the child. Covered = child line-range reads already inside a parent read made before the child '
                  'started (and not edited since). Repeated = exact repeats of the parent\'s pre-start grep/bash inspection commands.', '',
                  '| Arm | Child | Inherited seed tool calls | Own tool calls | Ranged reads | Covered by inherited parent reads | Repeated parent inspection commands |',
                  '|---|---|---:|---:|---:|---:|---:|']
        for c in summary['cases']:
            for ch in c['children']:
                lines.append(f"| {c['label']} | {ch['child']} | {ch.get('inheritedSeedToolCalls', 0)} | {ch['toolCalls']} | {ch.get('childRangedReads', '-')} | "
                             f"{ch.get('childReadsCoveredByInheritedReads', '-')} | {ch.get('childInspectionCommandsRepeatingParent', '-')} |")
        lines += ['', '## Child edits and tests', '',
                  'Edits: edit/write tools and bash in-place edits/redirections into repository-style paths (scratch files included). '
                  'Test outcome from the last pytest summary line, else a reported exit code; deliberate pre-fix failure checks count as failed.', '',
                  '| Arm | Child | Edit calls | Files edited | Of those in final patch | Test runs | Outcomes | Last test |',
                  '|---|---|---:|---|---|---:|---|---|']
        for c in summary['cases']:
            for ch in c['children']:
                outcomes = ', '.join(f"{k} {v}" for k, v in sorted(ch.get('childTestOutcomes', {}).items())) or '-'
                lines.append(f"| {c['label']} | {ch['child']} | {ch.get('childEditCalls', 0)} | {', '.join(ch.get('childFilesEdited', [])) or '-'} | "
                             f"{', '.join(ch.get('childEditedFilesInFinalPatch', [])) or '-'} | {ch.get('childTestRuns', 0)} | {outcomes} | {ch.get('childLastTestOutcome') or '-'} |")
        lines += ['', '## Ownership until settlement and parent waits', '',
                  'Outstanding window: child start until its settlement notice enters the parent\'s inbox (not its first message). '
                  'Child files = files the child inspected or edited. Worktree resets = git stash/checkout --/restore/reset --hard/clean in '
                  'the shared checkout (whole = no paths). Idle = window time outside the parent\'s model/tool steps.', '',
                  '| Arm | Child | First message / settled s after start | Parent calls in window | Parent inspections on child files (window / before first message) | '
                  'Parent edits on child files (window / before first message) | Parent edits on child-edited files | Parent test runs | '
                  'Worktree resets (whole / covering child edits) | Native waits on child | Other waits (job_output) | Sleeps | Messages to child | '
                  'Turn ends before settlement (wait s) | Idle s |',
                  '|---|---|---|---:|---|---|---:|---:|---|---:|---:|---:|---:|---|---:|']
        for c in summary['cases']:
            for ch in c['children']:
                if 'childSettledSecondsAfterStart' not in ch:
                    continue
                ends = ', '.join(ch['parentTurnEndsBeforeSettlement']) or 'none'
                lines.append(f"| {c['label']} | {ch['child']} | {ch['resultDeliveredSecondsAfterStart']} / {ch['childSettledSecondsAfterStart']} | "
                             f"{ch['parentCallsWhileOutstanding']} | {ch['parentInspectionsOnChildFilesWhileOutstanding']} / {ch['parentInspectionsOnChildFilesBeforeFirstMessage']} | "
                             f"{ch['parentEditsOnChildFilesWhileOutstanding']} / {ch['parentEditsOnChildFilesBeforeFirstMessage']} | {ch['parentEditsOnChildEditedFilesWhileOutstanding']} | "
                             f"{ch['parentTestRunsWhileOutstanding']} | {ch['parentWorktreeResetsWhileOutstanding']} ({ch['parentWholeWorktreeResetsWhileOutstanding']} / "
                             f"{ch['parentWorktreeResetsCoveringChildEditedFiles']}) | {ch['parentNativeWaitCallsOnChild']} | {ch['parentWaitCallsOnOtherJobs']} | "
                             f"{ch['parentSleepCallsWhileOutstanding']} | {ch['parentMessagesToChildWhileOutstanding']} | {ends} ({ch['parentWaitAfterTurnEndSeconds']}) | "
                             f"{ch['parentIdleSecondsWhileOutstanding']} |")
        lines += ['', '## Parent edits and tests', '', '| Arm | Edit calls | Files edited | Test runs | Outcomes | Worktree resets | Final patch files |',
                  '|---|---:|---|---:|---|---:|---|']
        for c in summary['cases']:
            w = c.get('parentWork') or {}
            outcomes = ', '.join(f"{k} {v}" for k, v in sorted(w.get('testOutcomes', {}).items())) or '-'
            lines.append(f"| {c['label']} | {w.get('editCalls', 0)} | {', '.join(w.get('filesEdited', [])) or '-'} | {w.get('testRuns', 0)} | {outcomes} | "
                         f"{w.get('worktreeResets', 0)} | {', '.join(w.get('finalPatchFiles', [])) or '-'} |")
        lines += ['', '## Exploration counts (heuristic: read-only inspection calls and repository files they touch)', '',
                  '| Arm | Tool calls | Inspection calls | Distinct files | Revisits same session | Revisits cross session | Parent inspections before / after first child | Files inspected by >1 child |',
                  '|---|---:|---:|---:|---:|---:|---|---:|']
        for c in summary['cases']:
            e = c['exploration']
            lines.append(f"| {c['label']} | {e['toolCallsAll']} | {e['inspectionCallsAll']} | {e['distinctFilesInspected']} | {e['fileRevisitsSameSession']} | "
                         f"{e['fileRevisitsCrossSession']} | {e['parentInspectionCallsBeforeFirstChild']} / {e['parentInspectionCallsAfterFirstChild']} | {e['filesInspectedByMoreThanOneChild']} |")
    lines += ['', '## Tokens and theoretical cost by role', '',
              'Reused (theoretical): same model + identical serialized content, effort not assumed to split the cache (priced). '
              'If effort splits: provider-specific assumption, not priced. Observed: provider-reported cached tokens, not priced.', '',
              '| Arm | Role | Model | Requests | Input | Reused (theoretical) | If effort splits cache | Observed provider cached | Output | USD |',
              '|---|---|---|---:|---:|---:|---:|---:|---:|---:|']
    for c in summary['cases']:
        for row in c['tokensAndCostByRole']:
            lines.append(f"| {c['label']} | {row['role']} | {row['model']} | {row.get('requests', 0)} | {row.get('inputTokens', 0)} | "
                         f"{row.get('reusedTokens', '-') if row['role'] != 'jev' else '-'} | {row.get('reusedTokensIfEffortSplitsCache', '-') if row['role'] != 'jev' else '-'} | "
                         f"{row.get('observedProviderCachedTokens', '-') if row['role'] != 'jev' else '-'} | {row.get('outputTokens', 0)} | {row.get('usd', 0):.6f} |")
    lines += ['', '## Model and effort by role', '', '| Arm | Role | Model | Effort | Requests |', '|---|---|---|---|---:|']
    for c in summary['cases']:
        for row in c['modelEffortByRole']:
            lines.append(f"| {c['label']} | {row['role']} | {row['model']} | {row['effort']} | {row['requests']} |")
    lines += ['', '## Prices used (USD per 1M tokens)', '']
    prices = {}
    for c in summary['cases']:
        prices.update(c['prices'])
    for model, p in sorted(prices.items()):
        lines.append(f"- {model}: " + ', '.join(f"{k} {v}" for k, v in p.items()))
    lines += ['', '## Separate attempts (not part of the comparison)', '']
    for s in summary['separateAttempts']:
        lines.append(f"- {s['label']}: {s['reason']} — status {s.get('executionStatus')}"
                     + (f", children {s['childrenStarted']}" if s.get('childrenStarted') is not None else ''))
    open(os.path.join(out, 'README.md'), 'w').write('\n'.join(lines) + '\n')


if __name__ == '__main__':
    main()
