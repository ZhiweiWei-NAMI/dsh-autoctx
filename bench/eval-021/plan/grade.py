"""Grade exported patches with the official CPU SWE-bench harness, per case."""
import argparse
import concurrent.futures
import importlib.metadata
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

from common import case_paths, read_json, write_json

PRIVATE = Path(os.environ.get('DSH_BENCH_ROOT', '.')).resolve() / 'evaluator'


def evaluate(directory):
    result = json.loads((directory / 'result.json').read_text())
    instance, arm, model = result['instance_id'], result['arm'], result['model']
    existing = read_json(directory / 'evaluation.json')
    if isinstance(existing, dict) and type(existing.get('resolved')) is bool:
        result['resolved'] = existing['resolved']
        write_json(directory / 'result.json', result)
        return existing
    run_id = 'benchv2-' + uuid.uuid4().hex
    work = directory / 'grading' / run_id
    work.mkdir(parents=True)
    prediction = work / 'prediction.jsonl'
    prediction.write_text(json.dumps({'instance_id': instance, 'model_name_or_path': model,
                                      'model_patch': (directory / 'patch.diff').read_text()}) + '\n')
    for name in ('official-report.json', 'official-summary.json'):
        (directory / name).unlink(missing_ok=True)
    env = os.environ.copy()
    env.update(CUDA_VISIBLE_DEVICES='', USE_TF='0')
    started = time.perf_counter()
    with (work / 'harness.log').open('w') as log:
        process = subprocess.run([sys.executable, '-m', 'swebench.harness.run_evaluation',
            '--dataset_name', str(PRIVATE / 'verified-subset.json'), '--predictions_path', str(prediction),
            '--instance_ids', instance, '--run_id', run_id, '--max_workers', '1', '--namespace', 'swebench',
            '--cache_level', 'instance', '--timeout', '600'], cwd=work, env=env, stdout=log,
            stderr=subprocess.STDOUT)
    report = work / 'logs/run_evaluation' / run_id / model / instance / 'report.json'
    summary = read_json(work / f'{model}.{run_id}.json')
    metadata = {'harnessVersion': importlib.metadata.version('swebench'), 'runId': run_id,
                'exitCode': process.returncode, 'evaluationSeconds': round(time.perf_counter() - started, 4),
                'resolved': None, 'status': 'harness_error'}
    official = read_json(report)
    verdict = official.get(instance) if isinstance(official, dict) else None
    if isinstance(verdict, dict) and type(verdict.get('resolved')) is bool:
        shutil.copyfile(report, directory / 'official-report.json')
        metadata.update(resolved=verdict['resolved'], status='official_report')
    elif isinstance(summary, dict):
        for field, resolved in [('empty_patch_ids', False), ('unresolved_ids', False), ('resolved_ids', True)]:
            ids = summary.get(field)
            if isinstance(ids, list) and instance in ids:
                metadata.update(resolved=resolved, status='official_' + field.removesuffix('_ids'))
                break
        write_json(directory / 'official-summary.json', summary)
    write_json(directory / 'evaluation.json', metadata)
    result['resolved'] = metadata['resolved']
    write_json(directory / 'result.json', result)
    print(json.dumps({'instance_id': instance, 'arm': arm, **metadata}), flush=True)
    return metadata


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('roots', type=Path, nargs='+')
    parser.add_argument('--parallel', type=int, default=2)
    args = parser.parse_args()
    directories = []
    for root in dict.fromkeys(path.resolve() for path in args.roots):
        tasks = json.loads((root / 'tasks.json').read_text())['tasks']
        config = json.loads((root / 'run-config.json').read_text())
        directories.extend(case for _, _, _, case in case_paths(root, tasks, config['arms'], config['repeat'])
                           if (case / 'result.json').exists())
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.parallel) as pool:
        for _ in pool.map(evaluate, directories):
            pass


if __name__ == '__main__':
    main()
