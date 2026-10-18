#!/usr/bin/env python3
"""Single-case delegation mechanism check (metadata only; no prompts, tool arguments or file contents are written).

Per case directory (result.json, requests.json, decisions-and-children.json, trial/sessions/*):
- Child context: was each child seeded with parent history (session header `isSeeded`), its provider, model, its
  effort and the parent's effort (recorded separately), and whether its tool block matches the parent's.
- Theoretical prefix reuse, exact message hashes, same model + identical serialized content (tools block + system +
  messages); effort is not assumed to split the cache. Split per request: within-session = longest prefix shared with
  an earlier request of the same session; cross-agent = the extra prefix available only from an earlier request of
  another session (parent, child or sibling). Separately: the same split if effort/thinking split the cache (a
  provider-specific assumption) and the provider-reported cached tokens (observed).
- Exploration: read-only inspection actions (read/grep/glob tools; bash commands made only of inspection programs)
  and the repository files they touch. Child re-exploration = child inspections of files the parent had already
  inspected before the child started; sibling overlap = files inspected by more than one child.
Theoretical estimates, not billed cost.

Usage: mechanism_check.py LABEL=CASE_DIR [...] [--json OUT]
"""
import collections
import glob
import io
import json
import os
import re
import shlex
import sys

import zstandard

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import singlecase_export  # noqa: E402

INSPECT = {'grep', 'rg', 'cat', 'head', 'tail', 'sed', 'ls', 'find', 'wc', 'nl', 'awk', 'tree', 'file', 'stat', 'less'}
INSPECT_GIT = {'log', 'show', 'diff', 'blame', 'grep', 'status', 'ls-files'}
NEUTRAL = {'cd', 'echo', 'true', 'sort', 'uniq', 'cut', 'tr', 'xargs'}
INSPECT_TOOLS = {'read', 'grep', 'glob', 'ls', 'find'}
PATH = re.compile(r'(?:/testbed/)?((?:src|testing|doc|tests?|changelog|scripts)/[\w./-]*\w|[\w-]+\.(?:py|cfg|toml|ini|rst|txt))')


def load_session(path):
    data = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(open(path, 'rb').read()), read_across_frames=True).read()
    return [json.loads(line) for line in data.splitlines() if line.strip()]


def arguments(call):
    value = call.get('arguments')
    for _ in range(2):
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                break
    return value if isinstance(value, dict) else {}


def inspection(name, args):
    """(is_inspection, files) for one tool call."""
    if name in INSPECT_TOOLS:
        text = ' '.join(str(v) for v in args.values() if isinstance(v, str))
        return True, {m.group(1) for m in PATH.finditer(text)}
    if name != 'bash':
        return False, set()
    command = args.get('command') or ''
    try:
        segments = [s for s in re.split(r'&&|\|\||;|\|', command) if s.strip()]
        programs = []
        for s in segments:
            words = shlex.split(s, posix=True)
            if words:
                programs.append(words)
    except ValueError:
        return False, set()
    seen_inspect = False
    for words in programs:
        prog = os.path.basename(words[0])
        if prog in NEUTRAL:
            continue
        if prog == 'sed' and any(w.startswith('-i') for w in words[1:]):
            return False, set()
        if prog == 'git' and len(words) > 1 and words[1] in INSPECT_GIT:
            seen_inspect = True
            continue
        if prog in INSPECT:
            seen_inspect = True
            continue
        return False, set()
    return seen_inspect, ({m.group(1) for m in PATH.finditer(command)} if seen_inspect else set())


EDIT_TOOLS = {'edit', 'write', 'apply_patch', 'multi_edit'}
FULL = 10 ** 9


def read_ranges(name, args):
    """[(file, first, last)] line ranges a read-only call returns: `read` (offset/limit), `sed -n 'a,bp' f`,
    `head -n N f`, `cat f` (whole file). Other inspections have no range."""
    norm = lambda path: re.sub(r'^/testbed/', '', path)
    if name == 'read' and isinstance(args.get('file_path'), str):
        first = int(args.get('offset') or 1)
        return [(norm(args['file_path']), first, first + int(args['limit']) - 1 if args.get('limit') else FULL)]
    if name != 'bash':
        return []
    command, out = args.get('command') or '', []
    for a, b, f in re.findall(r"sed\s+-n\s+['\"]?(\d+),(\d+)p['\"]?\s+(\S+)", command):
        out.append((norm(f), int(a), int(b)))
    for n, f in re.findall(r"head\s+-n\s*(\d+)\s+(\S+)", command):
        out.append((norm(f), 1, int(n)))
    for f in re.findall(r"(?:^|[;&|]\s*)cat\s+([\w./-]+\.\w+)\s*(?:$|[;&|])", command):
        out.append((norm(f), 1, FULL))
    return out


def covered(rng, earlier):
    """True if line range rng=(file, a, b) lies inside the union of earlier ranges of the same file."""
    f, a, b = rng
    spans = sorted((x, y) for g, x, y in earlier if g == f)
    pos = a
    for x, y in spans:
        if x > pos:
            break
        pos = max(pos, y + 1)
        if pos > b:
            return True
    return pos > b


def editing(name, args):
    """(is_edit, files) for one tool call: file-editing tools, or bash with in-place edits / redirections into repo files."""
    if name in EDIT_TOOLS:
        text = ' '.join(str(v) for v in args.values() if isinstance(v, str))
        return True, {m.group(1) for m in PATH.finditer(text)}
    if name == 'bash':
        command = args.get('command') or ''
        if re.search(r'sed\s+-i|>\s*\S+\.(py|rst|txt|cfg|toml)|apply_patch|git\s+apply|patch\s+-p', command):
            return True, {m.group(1) for m in PATH.finditer(command)}
    return False, set()


def sessions(case):
    out = {}
    for path in glob.glob(os.path.join(case, 'trial', 'sessions', '*', '*', 'session.v4.jsonl.zstd')):
        events = load_session(path)
        header = events[0] if events and events[0].get('type') == 'session' else {}
        descriptor = next((e['data'] for e in events if e.get('type') == 'subagent/descriptor'), {})
        calls, deliveries, assistant_times = [], [], []
        for e in events:
            d = e.get('data') or {}
            if e.get('type') == 'tool/call':
                args = arguments(d)
                is_inspect, files = inspection(d.get('name'), args)
                edit, edit_files = editing(d.get('name'), args)
                calls.append({'time': e.get('time'), 'name': d.get('name'), 'inspect': is_inspect, 'files': files,
                              'edit': edit, 'editFiles': edit_files, 'text': json.dumps(args),
                              'ranges': read_ranges(d.get('name'), args),
                              'key': (d.get('name'), json.dumps(args, sort_keys=True)) if is_inspect and d.get('name') != 'read' else None})
            elif e.get('type') == 'user/message' and isinstance(d.get('source'), dict) and d['source'].get('senderSessionId'):
                deliveries.append({'time': e.get('time'), 'from': d['source']['senderSessionId'], 'kind': d['source'].get('kind')})
            elif e.get('type') == 'assistant/message':
                assistant_times.append(e.get('time'))
        out[header.get('id') or os.path.basename(os.path.dirname(path))] = {
            'parent': header.get('parentSession'), 'seeded': header.get('isSeeded'), 'created': header.get('createdAt'),
            'provider': descriptor.get('provider'), 'model': descriptor.get('agentModel'),
            'effort': descriptor.get('agentReasoningEffort'), 'calls': calls, 'deliveries': deliveries,
            'lastAssistant': max(assistant_times, default=None), 'lastEvent': max((e.get('time') or 0 for e in events), default=None),
            'seedEvents': sum(1 for e in events if e.get('type') == 'session/end-seed')}
    return out


def reuse_split(calls, space_kind='content'):
    """Per-request theoretical reuse split into within-session and cross-agent (tokens), exact message hashes.
    space_kind 'content': same model + identical serialized content (tools block + system + messages); effort is not
    assumed to split the cache. 'config': additionally requires the same configHash (effort/thinking), a
    provider-specific assumption reported separately."""
    prefix_tokens = collections.defaultdict(dict)
    for r in calls:
        prefix_tokens[(r.get('actualModel') or r.get('model'), r.get('toolsHash'))][r['messageHashes'][-1]] = r['inputTokens']
    seen = collections.defaultdict(lambda: collections.defaultdict(set))  # space -> hash -> sessions
    full = collections.defaultdict(list)  # space -> [(session, hashes)] of earlier requests
    rows = []
    for r in calls:
        model = r.get('actualModel') or r.get('model')
        space = (model, r.get('toolsHash')) + ((r.get('configHash'),) if space_kind == 'config' else ())
        hashes, session = r['messageHashes'], r.get('session')
        k_any = k_own = 0
        for i in range(len(hashes) - 1, -1, -1):
            owners = seen[space].get(hashes[i])
            if owners:
                k_any = max(k_any, i + 1)
                if session in owners:
                    k_own = i + 1
                    break
        k_other = 0
        for i in range(len(hashes) - 1, -1, -1):
            if seen[space].get(hashes[i], set()) - {session}:
                k_other = i + 1
                break
        table = prefix_tokens[(model, r.get('toolsHash'))]

        def tokens(k):
            for i in range(k - 1, -1, -1):
                if hashes[i] in table:
                    return min(table[hashes[i]], r['inputTokens'])
            return 0
        own, total = tokens(k_own), tokens(k_any)
        # Longest earlier request of another session whose whole message sequence is a prefix of this one
        # (i.e. this request contains that session's full serialized history at that point).
        contained = max((len(h) for other, h in full[space] if other != session and len(h) <= len(hashes)
                         and hashes[len(h) - 1] == h[-1]), default=0)
        rows.append({'request': r, 'within': own, 'cross': max(total - own, 0), 'messages': len(hashes),
                     'sharedOther': k_other, 'sharedOtherTokens': tokens(k_other), 'containsOtherRequestMessages': contained})
        full[space].append((session, hashes))
        for h in hashes:
            seen[space][h].add(session)
    return rows


def ownership(sess, root, child, child_files, rows):
    """Delivery/consumption of one child's result in the parent, and parent work overlapping the child's files while
    the child's result was outstanding. Times are session event times (ms)."""
    if not root:
        return {}
    parent, v = sess[root], sess[child]
    start = v['created'] or 0
    mine = [d for d in parent['deliveries'] if d['from'] == child]
    first = min((d['time'] for d in mine), default=None)
    settled = min((d['time'] for d in mine if d['kind'] == 'subagent-settled'), default=None)
    parent_requests = [row['request'] for row in rows if row['request'].get('session') == root and row['request'].get('role') == 'main']
    after = [r for r in parent_requests if first is not None and (r.get('startedUnix') or 0) * 1000 > first]
    end = first if first is not None else (parent['lastAssistant'] or 0)
    window = [x for x in parent['calls'] if start <= (x['time'] or 0) <= end]
    return {
        'resultDeliveries': [d['kind'] for d in mine],
        'resultDeliveredSecondsAfterStart': round((first - start) / 1000, 1) if first is not None else None,
        'resultDeliveredBeforeParentFinalAnswer': first is not None and parent['lastAssistant'] is not None and first < parent['lastAssistant'],
        'parentRequestsAfterDelivery': len(after),
        'childSettledSecondsAfterStart': round((settled - start) / 1000, 1) if settled is not None else None,
        'parentCallsWhileOutstanding': len(window),
        'parentInspectionsOnChildFilesWhileOutstanding': sum(1 for x in window if x['inspect'] and x['files'] & child_files),
        'parentEditsWhileOutstanding': sum(1 for x in window if x['edit']),
        'parentEditsOnChildFilesWhileOutstanding': sum(1 for x in window if x['edit'] and x['editFiles'] & child_files),
        'parentCallsNamingChild': sorted({x['name'] for x in parent['calls'] if child in x['text']}),
    }


def redundancy(sess, root, child):
    """Child re-reads of line ranges the parent had read before the child started (inherited in its seed), excluding
    files edited by anyone after the parent's read and before the child's read; and exact repeats of the parent's
    pre-start grep/bash inspection commands."""
    if not root:
        return {}
    start = sess[child]['created'] or 0
    parent_calls = [x for x in sess[root]['calls'] if (x['time'] or 0) < start]
    inherited = [(r, x['time']) for x in parent_calls for r in x['ranges']]
    keys = {x['key'] for x in parent_calls if x['key']}
    edits = [(re.sub(r'^/testbed/', '', f), x['time']) for v in sess.values() for x in v['calls'] if x['edit'] for f in x['editFiles']]
    reads = redundant = 0
    for x in sess[child]['calls']:
        for rng in x['ranges']:
            reads += 1
            valid = [r for r, t in inherited if not any(f == r[0] and t < te < (x['time'] or 0) for f, te in edits)]
            redundant += covered(rng, valid)
    repeats = sum(1 for x in sess[child]['calls'] if x['key'] and x['key'] in keys)
    return {'childRangedReads': reads, 'childReadsCoveredByInheritedReads': redundant,
            'childInspectionCommandsRepeatingParent': repeats, 'parentRangedReadsBeforeStart': len(inherited)}


def check(case):
    base = singlecase_export.export(case, None)
    raw = json.load(open(os.path.join(case, 'requests.json')))
    calls = sorted((r for r in raw if r.get('kind') != 'jev' and r.get('inputTokens') is not None and r.get('messageHashes')),
                   key=lambda r: r.get('startedUnix') or 0)
    rows = reuse_split(calls, 'content')
    rows_split = {id(row['request']): row for row in reuse_split(calls, 'config')}
    sess = sessions(case)
    root = next((s for s, v in sess.items() if not v['parent']), None)
    children = sorted((s for s, v in sess.items() if v['parent']), key=lambda s: sess[s]['created'] or 0)
    tag = {root: 'parent', **{c: f'child{i + 1}' for i, c in enumerate(children)}}

    reuse = collections.defaultdict(collections.Counter)
    for row in rows:
        r = row['request']
        who = 'compaction' if r.get('role') == 'compaction' else tag.get(r.get('session'), 'other')
        alt = rows_split[id(r)]
        reuse[who].update(requests=1, inputTokens=r['inputTokens'], withinSession=row['within'], crossAgent=row['cross'],
                          withinSessionIfEffortSplitsCache=alt['within'], crossAgentIfEffortSplitsCache=alt['cross'],
                          observedProviderCachedTokens=r.get('cachedTokens') or 0)

    root_calls = [r for r in calls if r.get('session') == root and r.get('role') == 'main']
    root_space = {(r.get('configHash'), r.get('toolsHash')) for r in root_calls}
    root_inspected_before = lambda t: {f for c in sess[root]['calls'] if c['inspect'] and c['time'] < t for f in c['files']} if root else set()
    child_rows = []
    child_files = {}
    for c in children:
        v = sess[c]
        mine = [row for row in rows if row['request'].get('session') == c]
        first = mine[0] if mine else None
        known = root_inspected_before(v['created'])
        inspects = [x for x in v['calls'] if x['inspect']]
        files = {f for x in inspects for f in x['files']}
        child_files[c] = files
        before = [r for r in root_calls if first and (r.get('startedUnix') or 0) <= (first['request'].get('startedUnix') or 0)]
        parent_effort = (before[-1].get('effort') if before else None) or 'none-sent'
        child_rows.append({
            'child': tag[c], 'provider': v['provider'], 'model': v['model'], 'effort': v['effort'] or 'none-sent',
            'parentEffortAtStart': parent_effort, 'effortDiffersFromParent': (v['effort'] or 'none-sent') != parent_effort,
            'sameModelAsParent': bool(first) and any((r.get('actualModel') or r.get('model')) == (first['request'].get('actualModel') or first['request'].get('model')) for r in root_calls),
            'seededWithParentHistory': v['seeded'], 'seedEndEvents': v['seedEvents'],
            'requests': len(mine),
            'toolsMatchParent': bool(first) and first['request'].get('toolsHash') in {s[1] for s in root_space},
            'configHashMatchesParent': bool(first) and first['request'].get('configHash') in {s[0] for s in root_space},
            'firstRequestMessages': first['messages'] if first else None,
            'firstRequestSharedPrefixWithOtherSession': first['sharedOther'] if first else None,
            'firstRequestSharedPrefixTokens': first['sharedOtherTokens'] if first else None,
            'firstRequestContainsWholeEarlierRequestOfMessages': first['containsOtherRequestMessages'] if first else None,
            'firstRequestInputTokens': first['request']['inputTokens'] if first else None,
            'firstRequestObservedProviderCachedTokens': (first['request'].get('cachedTokens') or 0) if first else None,
            **ownership(sess, root, c, files, rows),
            **redundancy(sess, root, c),
            'toolCalls': len(v['calls']), 'inspectionCalls': len(inspects), 'filesInspected': len(files),
            'parentFilesKnownAtStart': len(known),
            'filesReInspectedFromParent': len(files & known),
            'inspectionCallsOnParentKnownFiles': sum(1 for x in inspects if x['files'] & known),
        })
    sibling = collections.Counter(f for fs in child_files.values() for f in fs)
    all_calls = [(s, x) for s, v in sess.items() for x in v['calls']]
    first_seen, repeats_same, repeats_cross = {}, 0, 0
    for s, x in sorted(all_calls, key=lambda t: t[1]['time'] or 0):
        if not x['inspect']:
            continue
        for f in x['files']:
            if f in first_seen:
                if s in first_seen[f]:
                    repeats_same += 1
                else:
                    repeats_cross += 1
                first_seen[f].add(s)
            else:
                first_seen[f] = {s}
    parent_calls = sess[root]['calls'] if root else []
    first_child = min((sess[c]['created'] for c in children), default=None)
    return {
        'arm': base['arm'], 'executor': base['executor'], 'officialResolved': base['official']['resolved'],
        'executionStatus': base['executionStatus'], 'agentWallSeconds': base['agentWallSeconds'],
        'gradingSeconds': base['gradingSeconds'], 'executionRequests': base['executionRequests'],
        'jevRequests': base['jevRequests'], 'theoreticalTotalUSD': base['theoreticalTotalUSD'],
        'costByRole': base['tokensAndCostByRole'], 'promptHash': base['promptHash'],
        'reuseByAgent': {k: dict(v) for k, v in sorted(reuse.items())},
        'reuseTotals': dict(sum(reuse.values(), collections.Counter())),
        'children': child_rows,
        'exploration': {
            'inspectionCallsAll': sum(1 for _, x in all_calls if x['inspect']),
            'toolCallsAll': len(all_calls),
            'distinctFilesInspected': len(first_seen),
            'fileRevisitsSameSession': repeats_same, 'fileRevisitsCrossSession': repeats_cross,
            'parentInspectionCallsBeforeFirstChild': sum(1 for x in parent_calls if x['inspect'] and first_child and x['time'] < first_child),
            'parentInspectionCallsAfterFirstChild': sum(1 for x in parent_calls if x['inspect'] and first_child and x['time'] >= first_child),
            'filesInspectedByMoreThanOneChild': sum(1 for n in sibling.values() if n > 1),
        },
        'reuseBasis': 'theoretical: same model + identical serialized content (tools block + system + messages), exact message hashes; '
                      'effort not assumed to split the cache (the IfEffortSplitsCache fields are that provider-specific assumption); '
                      'observedProviderCachedTokens is provider-reported',
        'label': 'theoretical estimates, not billed cost; exploration counts are heuristic (inspection programs and repository paths)',
    }


def main():
    args, out = [], None
    it = iter(sys.argv[1:])
    for a in it:
        if a == '--json':
            out = next(it)
        else:
            args.append(a)
    result = {}
    for spec in args:
        label, case = spec.split('=', 1)
        result[label] = check(case)
    text = json.dumps(result, indent=1)
    if out:
        open(out, 'w').write(text + '\n')
    print(text)


if __name__ == '__main__':
    main()
