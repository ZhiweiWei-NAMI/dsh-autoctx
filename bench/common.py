"""Shared case layout, usage readers and API-price cost."""
import json
import math
from pathlib import Path

_CATALOG = None


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


def catalog():
    global _CATALOG
    if _CATALOG is None:
        document = json.loads((Path(__file__).resolve().parent.parent / 'models.json').read_text())
        _CATALOG = records(document['models'])
    return _CATALOG


def usage_of(call):
    usage = call.get('usage')
    usage = usage if isinstance(usage, dict) else {}

    def first(*values):
        return next((numeric(value) for value in values if numeric(value) is not None), None)

    inp = first(usage.get('prompt_tokens'), usage.get('input_tokens'))
    anthropic = (call.get('usageProtocol') == 'anthropic-messages' or call.get('type') == 'message'
                 or (numeric(usage.get('prompt_tokens')) is None
                     and any(numeric(usage.get(key)) is not None for key in
                             ('cache_read_input_tokens', 'cache_creation_input_tokens'))))
    if anthropic:
        cached = numeric(usage.get('cache_read_input_tokens'))
        cache_write = numeric(usage.get('cache_creation_input_tokens'))
        uncached = numeric(usage.get('input_tokens'))
        components = (uncached, cached, cache_write)
        inp = sum(components) if all(value is not None for value in components) else None
    else:
        cached = numeric(usage.get('prompt_cache_hit_tokens'))
        for key in ('prompt_tokens_details', 'input_tokens_details'):
            details = usage.get(key)
            if cached is None and isinstance(details, dict):
                cached = numeric(details.get('cached_tokens'))
        uncached = numeric(usage.get('prompt_cache_miss_tokens'))
        cache_write = 0 if inp is not None else None  # OpenAI usage has no cache-write category.
    out = first(usage.get('completion_tokens'), usage.get('output_tokens'))
    result = {'input': inp, 'cached': cached, 'uncached': uncached, 'cacheWrite': cache_write, 'output': out}
    for key in result:
        measured = numeric(call.get(key + 'Tokens'))
        if measured is not None:
            result[key] = measured
    if not anthropic and result['uncached'] is None and result['input'] is not None and result['cached'] is not None:
        result['uncached'] = result['input'] - result['cached']
    if not anthropic and result['cached'] is None and result['input'] is not None and result['uncached'] is not None:
        result['cached'] = result['input'] - result['uncached']
    return result


def model_price(model):
    if not isinstance(model, str):
        return None
    entry = None
    for candidate in (model, model.rsplit('/', 1)[-1]):
        entry = next((item for item in catalog() if item.get('id') == candidate), None)
        if entry is not None:
            break
    price = entry.get('price') if isinstance(entry, dict) else None
    return price if isinstance(price, dict) else None


def cost_usd(model, usage):
    price = model_price(model)
    if price is None:
        return None
    usage = usage if isinstance(usage, dict) else {}
    # Providers omit cache fields when nothing was cached, so absent cache counts are zero;
    # only the prompt and output totals are required to price a call.
    cached = numeric(usage.get('cached')) or 0
    cache_write = numeric(usage.get('cacheWrite')) or 0
    uncached = numeric(usage.get('uncached'))
    if uncached is None and numeric(usage.get('input')) is not None:
        uncached = numeric(usage.get('input')) - cached - cache_write
    output = numeric(usage.get('output'))
    if uncached is None or output is None:
        return None
    rates = {key: numeric(price.get(key)) for key in ('input', 'cacheRead', 'cacheWrite', 'output')}
    if rates['input'] is None or rates['output'] is None:
        return None
    return (uncached * rates['input'] + cached * (rates['cacheRead'] or rates['input'])
            + cache_write * (rates['cacheWrite'] or rates['input']) + output * rates['output']) / 1e6


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
