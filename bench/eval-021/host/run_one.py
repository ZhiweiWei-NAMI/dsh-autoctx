#!/usr/bin/env python3
"""Host-native single-case entry: the authenticated host DSH runs the agent; task execution stays in the task
container through the tools.

- DSH runs on the host with a fresh per-case DSH_HOME. The `credentials` plugin reads the owner's existing
  credentials file in place (never copied), so the native `openai-codex` provider authenticates as usual.
- The task checkout is copied out of the task image to a host directory and bind-mounted into the task container
  at both /testbed and its own host path. DSH's file tools edit that shared checkout; a `bash` wrapper first on
  DSH's PATH runs every shell command inside the container (`docker exec`, same working directory).
- WorkBuddy child routes and Jev go through the existing observer on 127.0.0.1 (Jev key injected host-side).
- Every execution request (openai-codex and WorkBuddy) is recorded in-process by runtime.mjs (message/tool hashes,
  usage); the observer's own records are kept as relay-requests.json for reference.
Prompt, request limit (default 256 excl. Jev), timeout (600 s) and the plugin configuration come from ../plan (run.py).

Usage: run_one.py --model gpt-6.1-sol --arm A|B|C --out DIR --plugin DIR [--tasks FILE] [--extra-models a,b]
"""
import argparse
import importlib.util
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from contextlib import ExitStack
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
PLAN = HERE.parent / 'plan'
sys.path.insert(0, str(PLAN))
_spec = importlib.util.spec_from_file_location('plan_run', PLAN / 'run.py')
plan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(plan)

CODEX_PROFILE = Path.home() / '.dsh/profiles/codex_sol/cordis.patch.yml'
CREDENTIALS = Path.home() / '.dsh/.credentials.yaml'
CONTAINER_PATH = '/opt/miniconda3/envs/testbed/bin:/opt/miniconda3/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh']


def plugin_catalog(plugin):
    return {m['id']: m for m in json.loads((plugin / 'models.json').read_text())['models']}


def codex_provider():
    """The openai-codex provider block of the owner's codex profile: structure only (the token stays a credential ref)."""
    for entry in yaml.safe_load(CODEX_PROFILE.read_text()):
        if isinstance(entry, dict) and entry.get('id') == 'llm-pi-ai':
            block = entry['config']['providers']['openai-codex']
            return {'displayName': block['displayName'], 'apiKeyEnv': block['apiKeyEnv'], 'reasoning': block['reasoning'],
                    'models': [{**m, 'maxTokens': min(m.get('maxTokens', plan.MAX_OUTPUT_TOKENS), plan.MAX_OUTPUT_TOKENS)}
                               for m in block['models']]}
    raise SystemExit('openai-codex provider not found in ' + str(CODEX_PROFILE))


def configure(home, model, arm, plugin, relay, extra_models, routes, catalog, request_limit, max_usd):
    plan.configure_home(home, model, arm, plugin, relay, extra_models, routes)
    patch = yaml.safe_load((home / 'cordis.patch.yml').read_text())
    shutil.copyfile(HERE / 'runtime.mjs', home / 'runtime.mjs')
    codex = codex_provider()
    codex_ids = {m['id'] for m in codex['models']}
    for entry in patch:
        if entry.get('id') == 'agent-default-model':
            entry['config']['provider'] = routes[model]
        elif entry.get('id') == 'llm-pi-ai':
            providers = entry['config']['providers']
            wb = providers['workbuddy']
            wb['models'] = [m for m in wb['models'] if routes.get(m['id']) == 'workbuddy']
            if not wb['models']:
                del providers['workbuddy']
            providers['openai-codex'] = codex
        elif entry.get('id') in ('tool-subagent', 'tool-subagent-fork'):
            entry['config']['agentOptions']['provider'] = routes[model]
        for item in entry.get('insert', []):
            if item.get('id') == 'bench-observation':
                item['config'] = {
                    'arm': arm, 'recordFile': str(home / 'native-events.jsonl'),
                    'requestFile': str(home / 'execution-requests.jsonl'), 'startedFile': str(home / 'execution-started.jsonl'),
                    'stopFile': str(home / 'STOP'), 'requestLimit': request_limit, 'maxUsd': max_usd,
                    'prices': {k: v['price'] for k, v in catalog.items() if v.get('price')}, 'providerDefaults': {},
                    'workbuddyBaseURL': relay + '/v1', 'maxChildren': plan.MAX_CHILDREN, 'maxConcurrent': plan.MAX_CONCURRENT}
            elif item.get('id') == 'dsh-autoctx':
                for route in item['config']['routes']:
                    if route['provider'] == 'openai-codex':
                        route['efforts'] = [e for e in CODEX_EFFORTS if e in next(
                            (m.get('reasoningEfforts') or {} for m in codex['models'] if m['id'] == route['model']), {})]
                    route['description'] = (catalog.get(route['model']) or {}).get('prior') or route['description']
    for model_id in [model, *extra_models]:
        if routes.get(model_id) == 'openai-codex' and model_id not in codex_ids:
            raise SystemExit(f'{model_id} is not in the owner codex profile')
    # dsh-headless disables the interactive credentials store; re-enable the native store so it reads the owner's
    # existing document in place (no copy, no environment export of the token).
    patch.append({'id': 'credentials', 'disabled': False, 'config': {'path': str(CREDENTIALS)}})
    (home / 'cordis.patch.yml').write_text(yaml.safe_dump(patch, sort_keys=False))


def normalize_usage(rows):
    """DSH TokenUsage is disjoint (input excludes cache reads/writes). The analysis tools expect total input, so
    inputTokens becomes the total; the disjoint parts stay as uncachedInputTokens / cachedTokens / cacheWriteTokens."""
    for row in rows:
        if row.get('usageBasis') == 'total-input':
            continue
        parts = [row.get('inputTokens'), row.get('cacheReadTokens'), row.get('cacheWriteTokens')]
        row['uncachedInputTokens'] = row.get('inputTokens')
        row['cachedTokens'] = row.get('cacheReadTokens')
        row['inputTokens'] = sum(parts) if all(p is not None for p in parts) else None
        row['usageBasis'] = 'total-input'
    return rows


def bash_wrapper(directory, container, checkout):
    directory.mkdir(parents=True, exist_ok=True)
    docker = shutil.which('docker')
    forward = ' '.join(f'-e {name}' for name in ('LANG', 'LC_ALL', 'PAGER', 'GIT_PAGER', 'NO_COLOR', 'CI', 'TERM'))
    (directory / 'bash').write_text(f'''#!/bin/sh
# Agent shell commands run inside the task container (shared checkout, same path); DSH itself stays on the host.
d=$(pwd)
case "$d" in "{checkout}"|"{checkout}"/*) ;; *) d="{checkout}" ;; esac
exec {docker} exec -i -u {os.getuid()}:{os.getgid()} -w "$d" -e HOME=/tmp -e PATH={CONTAINER_PATH} {forward} {container} /bin/bash "$@"
''')
    (directory / 'bash').chmod(0o755)


def run(task, arm, case, model, plugin, extra_models, routes, catalog, request_limit, timeout, max_usd):
    case.mkdir(parents=True, exist_ok=True)
    home, checkout, bindir = case / 'trial', case / 'testbed', case / 'bin'
    for path in (home, checkout, bindir):
        if path.exists():
            shutil.rmtree(path)
    instance = task['instance_id']
    image = 'swebench/sweb.eval.x86_64.' + instance.replace('__', '_1776_') + ':latest'
    outcome = {'instance_id': instance, 'arm': arm, 'repeat': 0, 'model': model, 'image': image, 'resolved': None,
               'layout': 'host-dsh+container-tools'}
    with ExitStack() as stack:
        seed = plan.docker('create', image).decode().strip()
        try:
            plan.docker('cp', f'{seed}:/testbed', str(checkout))
        finally:
            plan.docker('rm', seed)
        observer = plan.CaseObserver(case / 'relay-requests.json', request_limit, max_usd=max_usd, jev_limit=plan.JEV_REQUEST_LIMIT)
        relay = f'http://127.0.0.1:{observer.start()}'
        stack.callback(observer.close)
        configure(home, model, arm, plugin, relay, extra_models, routes, catalog, request_limit, max_usd)
        container = plan.docker('run', '--detach', '--network', 'none', '--runtime', 'runc', '--cpus', '4', '--memory', '8g',
                                '--volume', f'{checkout}:/testbed:rw', '--volume', f'{checkout}:{checkout}:rw',
                                '--workdir', '/testbed', image, 'sleep', 'infinity').decode().strip()
        stack.callback(plan.docker, 'rm', '--force', container)
        user = f'{os.getuid()}:{os.getgid()}'

        def execute(*command, root=False):
            return plan.docker('exec', *([] if root else ['-u', user, '-e', 'HOME=/tmp']), '--workdir', '/testbed',
                               container, *command)

        prepared = time.perf_counter()
        execute('git', 'config', '--global', '--add', 'safe.directory', '*')
        execute('git', 'reset', '--hard', task['base_commit'])
        execute('git', 'clean', '-fd')
        execute('git', 'clone', '--no-local', '--no-tags', '--depth', '1', '--no-checkout', 'file:///testbed', '/tmp/base')
        execute('python', '-c', "import shutil; shutil.rmtree('/testbed/.git'); "
                "shutil.move('/tmp/base/.git','/testbed/.git'); shutil.rmtree('/tmp/base')")
        execute('git', 'reset', '--mixed', task['base_commit'])
        outcome['taskEnvironmentPreparationSeconds'] = round(time.perf_counter() - prepared, 4)
        bash_wrapper(bindir, container, checkout)
        # HOME and the shared agents root are empty per-case directories, so no user-global AGENTS.md, skills or
        # tool state enter the agent context (as in the container layout); credentials come only via the explicit path.
        (home / 'agents-home').mkdir()
        env = {'PATH': f'{bindir}:{plan.NODE}/bin:/usr/local/bin:/usr/bin:/bin', 'HOME': str(home),
               'DSH_HOME': str(home), 'DSH_AGENTS_HOME': str(home / 'agents-home'), 'DSH_PERMISSION_MODE': 'danger-full-access', 'DSH_TELEMETRY_DISABLED': '1',
               'BENCH_RELAY_KEY': 'bench-observer', 'LANG': os.environ.get('LANG', 'C.UTF-8')}
        for name in ('HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'):
            if os.environ.get(name):
                env[name] = os.environ[name]
        if any(k.lower() in ('https_proxy', 'http_proxy') for k in env):
            env['NO_PROXY'] = env['no_proxy'] = ','.join(filter(None, [env.get('NO_PROXY'), '127.0.0.1', 'localhost']))
            env['NODE_USE_ENV_PROXY'] = '1'
        started = time.perf_counter()
        command = [str(plan.NODE / 'bin/node'), str(plan.DSH), '--profile', 'headless', plan.prompt_for(task, arm)]
        with (home / 'agent-output.txt').open('w') as log:
            process = subprocess.Popen(command, cwd=checkout, env=env, stdout=log, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            try:
                code = process.wait(timeout=timeout)
                outcome.update(agentExitCode=code, executionStatus='finished' if code == 0 else 'agent_error')
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                outcome.update(agentExitCode=None, executionStatus='timeout')
            finally:
                (home / 'STOP').touch()
                observer.stop_admitting()
                execute('python', '-c', 'import os, signal, contextlib\n'
                        'with contextlib.suppress(ProcessLookupError): os.kill(-1, signal.SIGKILL)', root=True)
        outcome['executionSeconds'] = round(time.perf_counter() - started, 4)
        execute('git', 'add', '-N', '.')
        patch = execute('git', 'diff', '--binary', task['base_commit'])
        (case / 'patch.diff').write_bytes(patch)
        outcome['patchBytes'] = len(patch)
        outcome['solveAndExportSeconds'] = round(time.perf_counter() - started, 4)
        lifecycle = plan.events(home / 'native-events.jsonl') + plan.events(home / 'auto-events.jsonl')
        plan.write_json(case / 'decisions-and-children.json', lifecycle)
    execution = normalize_usage(plan.events(home / 'execution-requests.jsonl'))
    jev = [c for c in observer.calls if c.get('kind') == 'jev']
    plan.write_json(case / 'requests.json', execution + jev)
    infrastructure = sorted({f"execution:{r.get('httpStatus') or r.get('transportError') or r.get('error')}" for r in execution
                             if r.get('transportError') or (r.get('httpStatus') or 0) >= 500 or r.get('httpStatus') in (401, 402, 403)})
    if arm == 'A' and not any(item.get('kind') == 'policy_snapshot' for item in lifecycle):
        infrastructure.append('plugin_inactive')
    outcome.update(executionCalls=len(execution), jevCalls=len(jev), relayCalls=len(observer.calls),
                   **plan.child_counts(lifecycle, execution))
    if infrastructure:
        outcome.update(executionStatus='infra_error', infraErrors=infrastructure)
        plan.write_json(case / 'infra-error.json', outcome)
    plan.write_json(case / 'result.json', outcome)
    print(json.dumps(outcome), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--model', required=True)
    parser.add_argument('--arm', required=True, choices=('A', 'B', 'C'))
    parser.add_argument('--tasks', type=Path, default=PLAN / 'tasks.json')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--plugin', type=Path, required=True)
    parser.add_argument('--extra-models', default='')
    parser.add_argument('--request-limit', type=int, default=256)
    parser.add_argument('--max-usd', type=float, default=10.0, help='theoretical API USD guard (catalog list prices)')
    parser.add_argument('--jev-model', default=plan.JEV_MODEL)
    args = parser.parse_args()
    plan.REQUEST_LIMIT = args.request_limit
    plan.JEV_MODEL = args.jev_model
    plan.LEARNING = 'frozen'
    catalog = plugin_catalog(args.plugin)
    extra = [m.strip() for m in args.extra_models.split(',') if m.strip() and m.strip() != args.model]
    routes = {}
    for m in [args.model, *extra]:
        entry_routes = (catalog.get(m) or {}).get('routes') or []
        routes[m] = 'openai-codex' if 'openai-codex' in entry_routes else 'workbuddy' if m in plan.WORKBUDDY_MODELS else None
        if routes[m] is None:
            parser.error(f'no host route for {m}')
    tasks = json.loads(args.tasks.read_text())
    tasks = tasks['tasks'] if isinstance(tasks, dict) else tasks
    if any('problem_statement' not in task for task in tasks):
        # Published manifests omit the statements; fill them from the local SWE-bench subset as run.py does.
        dataset = Path(os.environ.get('DSH_BENCH_ROOT', '.')).resolve() / 'evaluator/verified-subset.json'
        statements = {row['instance_id']: row['problem_statement'] for row in json.loads(dataset.read_text())}
        tasks = [{**task, 'problem_statement': statements[task['instance_id']]} for task in tasks]
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    plugin = out / 'plugin'
    plan.stage_plugin(args.plugin.resolve(), plugin)
    plan.write_json(out / 'tasks.json', {'tasks': tasks})
    plan.write_json(out / 'run-config.json', {
        'layout': 'host DSH (owner runtime, credentials read in place) + task container tools via bash wrapper',
        'node': str(plan.NODE), 'model': args.model, 'arm': args.arm, 'arms': [args.arm], 'repeat': 1, 'routes': routes, 'pool': [args.model, *extra],
        'plugin': str(args.plugin), 'observation': 'in-process (runtime.mjs llm/stream)',
        'executionRequestLimitExcludingJev': args.request_limit, 'jevRequestLimit': plan.JEV_REQUEST_LIMIT,
        'taskTimeoutSeconds': plan.TASK_SECONDS, 'maxOutputTokens': plan.MAX_OUTPUT_TOKENS, 'maxUsdTheoretical': args.max_usd,
        'jevModel': args.jev_model, 'learning': 'frozen', 'delegationInstruction': plan.DELEGATION_INSTRUCTION,
        'mainEffort': 'not sent (provider default)', 'label': 'single-case development tuning'})
    for task in tasks:
        run(task, args.arm, out / task['instance_id'] / args.arm, args.model, plugin, extra, routes, catalog,
            args.request_limit, plan.TASK_SECONDS, args.max_usd)


if __name__ == '__main__':
    main()
