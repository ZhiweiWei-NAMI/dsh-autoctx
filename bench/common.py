"""Shared case layout and optional measurement readers."""
import json
import math


def case_paths(root, tasks, arms, repeat):
    for index, task in enumerate(tasks):
        rotation = arms[index % len(arms):] + arms[:index % len(arms)]
        for k in range(repeat):
            base = root / f'repeat-{k}' if repeat > 1 else root
            for arm in rotation:
                yield task, arm, k, base / task['instance_id'] / arm


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return None


def records(value):
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def events(path):
    if not path.exists():
        return []
    result = []
    for line in path.read_text(errors='replace').splitlines():
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if isinstance(item, dict):
            result.append(item)
    return result


def numeric(value):
    return value if type(value) in (int, float) and math.isfinite(value) else None


def usage_of(call):
    usage = call.get('usage')
    usage = usage if isinstance(usage, dict) else {}
    inp = numeric(usage.get('prompt_tokens', usage.get('input_tokens')))
    out = numeric(usage.get('completion_tokens', usage.get('output_tokens')))
    cached = numeric(usage.get('prompt_cache_hit_tokens'))
    details = usage.get('prompt_tokens_details', usage.get('input_tokens_details'))
    if cached is None and isinstance(details, dict):
        cached = numeric(details.get('cached_tokens'))
    uncached = numeric(usage.get('prompt_cache_miss_tokens'))
    result = {'input': inp, 'cached': cached, 'uncached': uncached, 'output': out}
    for key in result:
        measured = numeric(call.get(key + 'Tokens'))
        if measured is not None:
            result[key] = measured
    if result['uncached'] is None and result['input'] is not None and result['cached'] is not None:
        result['uncached'] = result['input'] - result['cached']
    return result


def child_counts(lifecycle, calls):
    started = {r['id'] for r in lifecycle if r.get('kind') == 'child_start' and isinstance(r.get('id'), str)}
    started.update(r['session'] for r in calls if r.get('role') == 'child' and isinstance(r.get('session'), str))
    completed = {r['id'] for r in lifecycle if r.get('kind') == 'child_end'
                 and r.get('stopReason') == 'completed' and isinstance(r.get('id'), str)}
    observed = any(r.get('kind') == 'observer_start' for r in lifecycle)
    return {'childrenStarted': len(started) if observed or started else None,
            'childrenCompleted': len(completed) if observed or completed else None}


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)
