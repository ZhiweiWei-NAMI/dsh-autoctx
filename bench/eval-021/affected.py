#!/usr/bin/env python3
"""List (and optionally archive) infra-affected cases under one output root.

A case is infra-affected when it has infra-error.json (e.g. an execution TRANSPORT failure through the proxy) or,
for arm A, the plugin recorded `jev_unavailable`: a Jev call failed again after the plugin's own retry, so the plugin
paused Jev and used local fallbacks. Failed attempts recovered by that retry (`jev_retry` only) are normal product
behaviour and leave the case valid. (Before 08:15 on 2026-10-18 the rule flagged any failed Jev attempt; cases
archived under that rule were rerun regardless of outcome.) Affected case directories are moved, never deleted, to ARCHIVE/<relative path>-<n> so
the case can be rerun fresh. Prints a JSON task file body ({"tasks": [...]}) for the affected tasks.

Usage: affected.py ROOT [--archive ARCHIVE] [--tasks-out FILE]
"""
import json
import shutil
import sys
from pathlib import Path


def jev_transport_failures(case):
    try:
        records = json.loads((case / 'decisions-and-children.json').read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return 0
    return sum(1 for record in records if record.get('kind') == 'jev_unavailable')


def main():
    root = Path(sys.argv[1]).resolve()
    args = sys.argv[2:]
    archive = Path(args[args.index('--archive') + 1]).resolve() if '--archive' in args else None
    tasks_out = Path(args[args.index('--tasks-out') + 1]) if '--tasks-out' in args else None
    tasks = {t['instance_id']: t for t in json.loads((root / 'tasks.json').read_text())['tasks']}
    affected = []
    for arm in ('A', 'B', 'C'):
        for case in sorted(root.glob(f'**/{arm}')):
            if not case.is_dir() or case.parent.name not in tasks or 'plugin' in case.parts:
                continue
            reasons = []
            if (case / 'infra-error.json').exists():
                reasons.append('infra-error')
            if arm == 'A' and jev_transport_failures(case):
                reasons.append('jev-unavailable')
            if not reasons:
                continue
            affected.append((case, reasons))
    seen = []
    for case, reasons in affected:
        print(f'{case.relative_to(root)}: {",".join(reasons)}', file=sys.stderr)
        if case.parent.name not in seen:
            seen.append(case.parent.name)
        if archive:
            target = archive / case.relative_to(root)
            n = 1
            while target.with_name(f'{target.name}-{n}').exists():
                n += 1
            target = target.with_name(f'{target.name}-{n}')
            target.parent.mkdir(parents=True, exist_ok=True)
            (case / 'infra-reasons.json').write_text(json.dumps({'reasons': reasons}) + '\n')
            shutil.move(str(case), str(target))
    body = {'tasks': [tasks[i] for i in seen]}
    if tasks_out:
        tasks_out.write_text(json.dumps(body, indent=1) + '\n')
    print(len(seen))


if __name__ == '__main__':
    main()
