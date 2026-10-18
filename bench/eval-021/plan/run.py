"""Run A/B/C cases in isolated CPU containers and export patches and usage."""
import argparse
import concurrent.futures
import json
import math
import os
import shutil
import subprocess
import threading
import time
import urllib.request
import uuid
from contextlib import ExitStack
from pathlib import Path

import yaml

from common import case_paths, catalog, child_counts, events, write_json
from local_relay import LocalRelay
from observer import JEV_UPSTREAM, CaseObserver

NODE = Path(os.environ.get('DSH_BENCH_NODE', '/opt/node'))
DSH = NODE / 'lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
# WorkBuddy serves these ids directly; every other catalog model goes through OpenCode Go.
# GPT-family models configured on the DSH openai-codex route; eligible in plan pools once the relay can carry them.
CODEX_MODELS = ('gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')
WORKBUDDY_MODELS = ('deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'glm-5.3')
MODEL_IDS = ('deepseek-v4.1-flash', 'deepseek-v4-flash', 'glm-5.3-flash')
ROUTE_ORDER = ('workbuddy', 'opencode-go', 'opencode-go-anthropic')
TASK_SECONDS = 600
REQUEST_LIMIT = 64
JEV_REQUEST_LIMIT = 32  # diagnostic: separate bounded Jev allowance; REQUEST_LIMIT counts execution requests only
MAX_OUTPUT_TOKENS = 16384
PRESSURE_TOKENS = 24000
RETAIN_TOKENS = 8000
MAX_CHILDREN = 2
MAX_CONCURRENT = 2
COMPACTION_THRESHOLD_RATIO = 0.1875
ARMS = ('A', 'B', 'C', 'H')
# Jev model for arm A, set from --jev-model; jev-1.13 is billed to the key's workspace, jev-1.13-free is rate limited.
JEV_MODEL = 'jev-1.13'
# Plugin learning mode for arm A, set from --learning. frozen: every case starts from the same (empty)
# ledger and nothing is applied. auto: the ledger is carried across the run's cases in completion order;
# each case starts from the carried ledger and its applied steps are replayed onto it afterwards.
LEARNING = 'frozen'
# Plan-mode variant (1.2.6-dev): None keeps arm A as 1.2.x; 'jev' or 'fixed' runs the plugin's plan mode.
PLAN_ROUTING = None
# Review is an independent optional feature: off in the core plan arms, on only in the review arm.
REVIEW_ON = False
# Removed from use: forced delegation (planMinDelegated) was reverted in the plugin; keep 0.
SMOKE_MIN_DELEGATED = 0
DELEGATION_INSTRUCTION = ('Split the task into subtasks and delegate suitable subtasks to subagents with the subagent or '
                          'subagent_fork tools, then integrate their results and verify the final change yourself. ')
CARRY_LOCK = threading.Lock()
# Arm A stops scheduling cases once this many Jev calls failed: its results would measure Auto without Jev.
JEV_FAILURE_LIMIT = 2
# dsh effort level -> wire value; WorkBuddy honors reasoning_effort (no field = no thinking).
EFFORTS = {'low': 'low', 'high': 'high', 'xhigh': 'max'}
# Wire compatibility copied from pi-ai's opencode-go catalog for the same models.
COMPAT = {'deepseek': {'thinkingFormat': 'deepseek', 'requiresReasoningContentOnAssistantMessages': True,
                       'supportsDeveloperRole': False, 'supportsStore': False},
          'glm': {'supportsDeveloperRole': False, 'supportsStore': False}}


def workbuddy_model(model):
    entry = {'id': model, 'contextWindow': 128000, 'maxTokens': MAX_OUTPUT_TOKENS, 'reasoningEfforts': dict(EFFORTS)}
    compat = COMPAT.get(model.split('-')[0])
    return {**entry, 'compat': compat} if compat else entry


def docker(*args):
    return subprocess.run(['docker', *map(str, args)], check=True, stdout=subprocess.PIPE).stdout


def route_for(model):
    entry = next((item for item in catalog() if item.get('id') == model), None)
    routes = entry.get('routes') if isinstance(entry, dict) else None
    routes = routes if isinstance(routes, list) else []
    for route in ROUTE_ORDER:
        if route in routes and (route != 'workbuddy' or model in WORKBUDDY_MODELS):
            return route
    return None


def configure_home(home, model, arm, plugin, relay, extra_models, routes, reviewer='same',
                   advisor='off'):
    home.mkdir(parents=True)
    shutil.copyfile(Path(__file__).with_name('runtime.mjs'), home / 'runtime.mjs')
    patch = [{'id': item, 'disabled': True} for item in
             ('session-title-llm', 'tool-workflow', 'tool-ralph', 'tool-web', 'web-search-deepseek',
              'repeat-tool-reminder', 'llm-retry')]
    workbuddy = [workbuddy_model(model)]
    workbuddy += [workbuddy_model(extra) for extra in extra_models if routes.get(extra) == 'workbuddy']
    pool = [model] + [extra for extra in extra_models if extra != model]
    providers = {'workbuddy': {
        'api': 'openai-completions', 'baseURL': relay + '/v1', 'apiKeyEnv': 'BENCH_RELAY_KEY',
        'compat': {'maxTokensField': 'max_tokens', 'supportsUsageInStreaming': True},
        'models': workbuddy}}
    if any(extra not in WORKBUDDY_MODELS for extra in extra_models):
        # Native pi-ai catalog route: only the endpoint is redirected to the relay.
        providers['opencode-go'] = {'apiKeyEnv': 'BENCH_RELAY_KEY', 'baseURL': relay + '/go/v1'}
    anthropic = [extra for extra in extra_models if routes.get(extra) == 'opencode-go-anthropic']
    if anthropic:
        providers['opencode-go-anthropic'] = {
            'api': 'anthropic-messages', 'baseURL': relay + '/go', 'apiKeyEnv': 'BENCH_RELAY_KEY',
            'models': [{'id': extra, 'contextWindow': 128000, 'maxTokens': MAX_OUTPUT_TOKENS}
                       for extra in anthropic]}
    patch += [
        {'id': 'agent-default-model', 'config': {'provider': 'workbuddy', 'model': model}},
        {'id': 'llm-pi-ai', 'config': {'providers': providers}},
        {'id': 'subagent', 'config': {'maxDepth': 1, 'maxActiveSubagents': MAX_CONCURRENT}},
        {'insert': [{'id': 'bench-observation', 'name': str(home / 'runtime.mjs'), 'config': {
            'arm': arm, 'relay': relay, 'recordFile': str(home / 'native-events.jsonl'),
            'maxChildren': MAX_CHILDREN, 'maxConcurrent': MAX_CONCURRENT}}]},
    ]
    plan = arm == 'A' and PLAN_ROUTING is not None
    if arm == 'A':
        patch += [
            {'id': 'compaction-basic', 'disabled': True},
            {'insert': [{'id': 'dsh-autoctx', 'name': str(plugin / 'index.js'), 'config': {
                # The same heterogeneous pool native arm H offers, as Jev-ranked delegation routes.
                'routes': [{'id': m, 'label': m, 'model': m, 'provider': routes[m],
                            'description': (next((c for c in catalog() if c.get('id') == m), {}).get('prior')
                                            or m),
                            'efforts': list(EFFORTS) if routes[m] == 'workbuddy' else []} for m in pool],
                'mode': 'auto', 'apiKey': 'bench-observer', 'jevEndpoint': relay + '/jev', 'jevModel': JEV_MODEL,
                'maxChildren': MAX_CHILDREN, 'maxConcurrent': MAX_CONCURRENT, 'maxDecisions': 12,
                'maxChildRequests': REQUEST_LIMIT, 'maxChildTurnRequests': REQUEST_LIMIT,
                'pressureTokens': PRESSURE_TOKENS, 'retainTokens': RETAIN_TOKENS,
                'nativeThresholdRatio': COMPACTION_THRESHOLD_RATIO,
                'modelRoutes': routes,
                'reviewerModel': reviewer,
                'advisorModel': advisor,
                # Auto's context policy under pressure (jev or summary); recorded in run-config.json.
                'contextSelection': os.environ.get('BENCH_CONTEXT_SELECTION', 'jev'),
                # Controlled runs: a fixed (empty) ledger per case and no learning from graded answers.
                'learning': LEARNING,
                'allowPaidModels': any(route.startswith('opencode') for route in routes.values()),
                'recordFile': str(home / 'auto-events.jsonl'),
                'reviewBeforeFinish': REVIEW_ON,
                **({'mode': 'plan', 'planRouting': PLAN_ROUTING,
                    'reviewerModel': 'same', 'preferredProviders': ['workbuddy'],
                    'allowedProviders': ['openai-codex'],
                    'planMinDelegated': SMOKE_MIN_DELEGATED}
                   if plan else {})}}]},
        ]
    else:
        patch.append({'id': 'compaction-basic', 'disabled': False, 'config': {
            'thresholdRatio': COMPACTION_THRESHOLD_RATIO, 'retainTokens': RETAIN_TOKENS,
            'maxTokens': MAX_OUTPUT_TOKENS, 'compactionRetries': 0, 'maxOverflowRetries': 0}})
    for pid, provider, tool in [('tool-subagent', 'spawn', 'subagent'),
                                ('tool-subagent-fork', 'fork', 'subagent_fork')]:
        patch.append({'id': pid, 'disabled': arm == 'B' or plan, 'config': {
            'provider': provider, 'toolName': tool, 'backgroundMode': 'one-shot', 'maxDepth': 1,
            'agentOptions': {'provider': 'workbuddy', 'model': model, 'maxTokens': MAX_OUTPUT_TOKENS}}})
    if arm == 'H':
        # Native heterogeneous scheduling: one dsh subagent tool per (model, effort) of the pool
        # arm A gives Auto, so the main model chooses the route by tool name.
        tools = []
        for m in pool:
            for effort in (list(EFFORTS) if routes[m] == 'workbuddy' else [None]):
                name = 'subagent_' + m.replace('-', '_').replace('.', '_') + ('_' + effort if effort else '')
                options = {'provider': routes[m], 'model': m, 'maxTokens': MAX_OUTPUT_TOKENS}
                if effort:
                    options['reasoningEffort'] = effort
                tools.append({'id': 'tool-' + name.replace('_', '-'), 'name': '@deepseek-ai/dsh-tool-subagent',
                              'config': {'provider': 'spawn', 'toolName': name, 'backgroundMode': 'one-shot',
                                         'maxDepth': 1, 'agentOptions': options}})
        patch.append({'insert': tools})
    (home / 'cordis.patch.yml').write_text(yaml.safe_dump(patch, sort_keys=False))


def stage_plugin(source, target):
    manifest = json.loads((source / 'package.json').read_text())
    temporary = target.with_name(target.name + '.tmp')
    if temporary.exists():
        shutil.rmtree(temporary)
    temporary.mkdir(parents=True)
    shutil.copyfile(source / 'package.json', temporary / 'package.json')
    for pattern in manifest['files']:
        for path in source.glob(pattern):
            destination = temporary / path.relative_to(source)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if path.is_dir():
                shutil.copytree(path, destination, dirs_exist_ok=True)
            else:
                shutil.copyfile(path, destination)
    (temporary / 'node_modules').symlink_to(DSH.parent.parent / 'node_modules', target_is_directory=True)
    # Resuming or rerunning into an existing output root replaces its previously staged copy.
    if target.is_symlink() or target.is_file():
        target.unlink()
    elif target.exists():
        shutil.rmtree(target)
    temporary.replace(target)


def prompt_for(task, arm):
    prompt = 'Resolve this issue in the repository. Use real tools to inspect and edit code, and run appropriate tests. '
    if arm == 'B':
        prompt += 'This run permits only the main agent; do not delegate. '
    else:
        # One natural-language delegation instruction for every multi-agent arm (plugin on or off).
        prompt += DELEGATION_INSTRUCTION
    return prompt + ('Do not read evaluation answers, later releases, fixed upstream tests or reference patches. '
                     'Only the initial commit and local model service are available. '
                     'Complete the code fix and report what was tested.\n\n' + task['problem_statement'])


def seed_ledger(home, carry_file):
    """Write the carried ledger into the case's plugin storage; returns the seed version (None: empty)."""
    if not carry_file or not carry_file.exists():
        return None
    carry = json.loads(carry_file.read_text())
    table = home / 'storages/dsh_auto/ledger'
    table.mkdir(parents=True, exist_ok=True)
    (table / carry['name']).write_text(json.dumps({'version': 1, 'record': carry['ledger']}))
    return carry['ledger']['version']


def carry_ledger(home, carry_file, seed_version):
    """Replay the case's auto-applied steps onto the carried ledger (serializes parallel cases)."""
    files = sorted((home / 'storages/dsh_auto/ledger').glob('*.json'))
    if not carry_file or not files:
        return 0
    case = json.loads(files[0].read_text())['record']
    new = [entry for entry in case.get('history', []) if entry['version'] > (seed_version or 0)
           and entry.get('via') == 'auto']
    with CARRY_LOCK:
        carry = json.loads(carry_file.read_text()) if carry_file.exists() else {
            'name': files[0].name, 'ledger': {**case, 'version': 0, 'weights': {}, 'history': [], 'consumed': [],
                                              'pending': None}}
        ledger = carry['ledger']
        for entry in new:
            changes = []
            for change in entry['changes']:
                if change.get('target') is None:
                    continue
                weight = ledger['weights'].get(change['key'], {})
                learned, n = weight.get('learned', 0.5), weight.get('n', 0)
                to = round(min(1, max(0, learned + (change['target'] - learned) / (n + 2))), 3)
                ledger['weights'][change['key']] = {**weight, 'learned': to, 'n': n + 1,
                                                    'summary': case['weights'].get(change['key'], {}).get('summary'),
                                                    'updatedAt': entry['at']}
                changes.append({**change, 'from': learned, 'to': to})
            ledger['version'] += 1
            ledger['history'] = (ledger['history'] + [{**entry, 'version': ledger['version'], 'changes': changes}])[-20:]
        ledger['consumed'] = list(dict.fromkeys(ledger.get('consumed', []) + case.get('consumed', [])))[-1000:]
        carry_file.write_text(json.dumps(carry, indent=1))
    return len(new)


def run_case(task, arm, repeat, case, model, plugin, extra_models, routes, reviewer='same',
             advisor='off', max_usd=0.50):
    case.mkdir(parents=True, exist_ok=True)
    home = case / 'trial'
    if home.exists():
        shutil.rmtree(home)
    for name in ('evaluation.json', 'official-report.json', 'official-summary.json'):
        (case / name).unlink(missing_ok=True)
    instance = task['instance_id']
    image = 'swebench/sweb.eval.x86_64.' + instance.replace('__', '_1776_') + ':latest'
    docker('image', 'inspect', image)
    outcome = {'instance_id': instance, 'arm': arm, 'repeat': repeat, 'model': model, 'image': image,
               'resolved': None}
    with ExitStack() as stack:
        network = 'dsh-bench-' + uuid.uuid4().hex
        docker('network', 'create', '--driver', 'bridge', '--internal', network)
        stack.callback(docker, 'network', 'rm', network)
        gateway = json.loads(docker('network', 'inspect', network))[0]['IPAM']['Config'][0]['Gateway']
        observer = CaseObserver(case / 'requests.json', REQUEST_LIMIT, max_usd=max_usd, jev_limit=JEV_REQUEST_LIMIT)
        port = observer.start()
        stack.callback(observer.close)
        relay = LocalRelay(gateway, port)
        stack.callback(relay.close)
        configure_home(home, model, arm, plugin, f'http://{gateway}:{port}', extra_models, routes,
                       reviewer, advisor)
        carry_file = case.parent.parent / 'ledger-carry.json' if arm == 'A' and LEARNING == 'auto' else None
        if carry_file:
            with CARRY_LOCK:
                seed_version = seed_ledger(home, carry_file)
            outcome['ledgerSeedVersion'] = seed_version
        volumes = ['--volume', f'{NODE}:{NODE}:ro', '--volume', f'{home}:{home}:rw']
        if arm == 'A':
            volumes += ['--volume', f'{plugin}:{plugin}:ro']
        container = docker('run', '--detach', '--network', network, '--runtime', 'runc',
                           '--cpus', '4', '--memory', '8g', '--workdir', '/testbed',
                           *volumes, image, 'sleep', 'infinity').decode().strip()
        stack.callback(docker, 'rm', '--force', container)
        stack.callback(docker, 'exec', container, 'chown', '-R', f'{os.getuid()}:{os.getgid()}', home)

        def execute(*command):
            return docker('exec', '--workdir', '/testbed', container, *command)

        prepared = time.perf_counter()
        execute('git', 'reset', '--hard', task['base_commit'])
        execute('git', 'clean', '-fd')
        execute('git', 'clone', '--no-local', '--no-tags', '--depth', '1', '--no-checkout',
                'file:///testbed', '/tmp/base')
        execute('python', '-c', "import shutil; shutil.rmtree('/testbed/.git'); "
                "shutil.move('/tmp/base/.git','/testbed/.git'); shutil.rmtree('/tmp/base')")
        execute('git', 'reset', '--mixed', task['base_commit'])
        outcome['taskEnvironmentPreparationSeconds'] = round(time.perf_counter() - prepared, 4)
        started = time.perf_counter()
        command = ['docker', 'exec', '--workdir', '/testbed', container, 'env',
                   f'DSH_HOME={home}', 'BENCH_RELAY_KEY=bench-observer',
                   'DSH_PERMISSION_MODE=danger-full-access', 'DSH_TELEMETRY_DISABLED=1', 'CUDA_VISIBLE_DEVICES=',
                   f'PATH={NODE}/bin:/opt/miniconda3/envs/testbed/bin:/opt/miniconda3/bin:/usr/local/sbin:'
                   '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                   str(NODE / 'bin/node'), str(DSH), '--profile', 'headless', prompt_for(task, arm)]
        with (home / 'agent-output.txt').open('w') as log:
            try:
                process = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=TASK_SECONDS)
                outcome['agentExitCode'] = process.returncode
                outcome['executionStatus'] = 'finished' if process.returncode == 0 else 'agent_error'
            except subprocess.TimeoutExpired:
                outcome.update(agentExitCode=None, executionStatus='timeout')
            finally:
                observer.stop_admitting()
                execute('python', '-c', 'import os, signal, contextlib\n'
                        'with contextlib.suppress(ProcessLookupError): os.kill(-1, signal.SIGKILL)')
        outcome['executionSeconds'] = round(time.perf_counter() - started, 4)
        execute('chown', '-R', f'{os.getuid()}:{os.getgid()}', home)
        execute('git', 'add', '-N', '.')
        patch = execute('git', 'diff', '--binary', task['base_commit'])
        (case / 'patch.diff').write_bytes(patch)
        outcome['patchBytes'] = len(patch)
        outcome['solveAndExportSeconds'] = round(time.perf_counter() - started, 4)
        lifecycle = events(home / 'native-events.jsonl') + events(home / 'auto-events.jsonl')
        if carry_file:
            outcome['ledgerStepsCarried'] = carry_ledger(home, carry_file, seed_version)
        write_json(case / 'decisions-and-children.json', lifecycle)
    calls = observer.calls
    infrastructure = sorted({f"{c['kind']}:{c.get('httpStatus') or c.get('transportError')}" for c in calls
                             if (c['kind'] == 'execution' and (c.get('transportError') or c.get('httpStatus') == 402
                                                              or (c.get('httpStatus') or 0) >= 500))
                             or (c['kind'] == 'jev' and c.get('httpStatus') == 403)})
    if arm == 'A' and not any(item.get('kind') == 'policy_snapshot' for item in lifecycle):
        infrastructure.append('plugin_inactive')
    if infrastructure:
        outcome.update(executionStatus='infra_error', infraErrors=infrastructure, upstreamCalls=len(calls))
        write_json(case / 'infra-error.json', outcome)
        print(json.dumps(outcome), flush=True)
        return
    (case / 'infra-error.json').unlink(missing_ok=True)
    outcome.update(upstreamCalls=len(calls), executionCalls=sum(c['kind'] == 'execution' for c in calls),
                   jevCalls=sum(c['kind'] == 'jev' for c in calls), **child_counts(lifecycle, calls))
    write_json(case / 'result.json', outcome)
    print(json.dumps(outcome), flush=True)


def jev_preflight(model):
    """One minimal decision against the real Jev endpoint; arm A must not start without a working Jev."""
    body = json.dumps({'model': model, 'state': json.dumps({'task': 'bench preflight'}),
                       'questions': {'ok': {'type': 'noul', 'instructions': 'Is this a preflight check?'}}}).encode()
    request = urllib.request.Request(JEV_UPSTREAM, data=body, method='POST', headers={
        # The relay forwards the plugin's Node user agent; urllib's default one is refused with HTTP 403.
        'Content-Type': 'application/json', 'Authorization': 'Bearer ' + os.environ['JEV_API_KEY'],
        'User-Agent': 'node'})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            answers = json.loads(response.read()).get('answers') or {}
    except Exception as error:  # the key never appears in urllib errors
        raise SystemExit(f'Jev preflight failed for {model}: {error}')
    if 'ok' not in answers:
        raise SystemExit(f'Jev preflight for {model} returned no answer')


def jev_failures(case):
    """(HTTP failures, transport failures, Jev calls) of one case."""
    try:
        calls = json.loads((case / 'requests.json').read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return 0, 0, 0
    jev = [call for call in calls if call.get('kind') == 'jev']
    failed = [call for call in jev if call.get('httpStatus') != 200]
    transport = sum(1 for call in failed if call.get('transportError'))
    return len(failed) - transport, transport, len(jev)


def main():
    global JEV_MODEL, LEARNING, PLAN_ROUTING, REVIEW_ON, SMOKE_MIN_DELEGATED, REQUEST_LIMIT
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True, choices=MODEL_IDS)
    parser.add_argument('--arms', default='A,B,C')
    parser.add_argument('--extra-models', default='')
    parser.add_argument('--reviewer', default='same')
    parser.add_argument('--advisor', default='off')
    parser.add_argument('--max-usd', type=float, default=0.50)
    parser.add_argument('--jev-model', default=JEV_MODEL,
                        help='Jev model for arm A: jev-1.13 (billed) or jev-1.13-free (free tier, rate limited)')
    parser.add_argument('--learning', default=LEARNING, choices=('frozen', 'auto'),
                        help='Plugin learning mode for arm A; auto carries the ledger across this run\'s cases')
    parser.add_argument('--plan-routing', choices=('jev', 'fixed'), default=None,
                        help='Arm A in plugin plan mode: jev (two-stage Jev routing) or fixed (D0, no Jev)')
    parser.add_argument('--smoke-min-delegated', type=int, default=0,
                        help='MECHANISM SMOKE ONLY: plans must delegate at least N subtasks (not the comparison contract)')
    parser.add_argument('--plan-review', action='store_true',
                        help='Plan arms only: turn the independent same-model review on (review arm)')
    parser.add_argument('--tasks', type=Path, default=Path(__file__).with_name('tasks.json'))
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--plugin', type=Path, required=True)
    parser.add_argument('--parallel', type=int, default=3)
    parser.add_argument('--repeat', type=int, default=1)
    parser.add_argument('--request-limit', type=int, default=REQUEST_LIMIT,
                        help='Per-case execution request limit excluding Jev, applied equally to every arm (default 64)')
    args = parser.parse_args()
    JEV_MODEL = args.jev_model
    LEARNING = args.learning
    PLAN_ROUTING = args.plan_routing
    REVIEW_ON = args.plan_review
    SMOKE_MIN_DELEGATED = args.smoke_min_delegated
    REQUEST_LIMIT = args.request_limit
    arms = [arm.strip().upper() for arm in args.arms.split(',') if arm.strip()]
    if not arms or len(set(arms)) != len(arms) or any(arm not in ARMS for arm in arms):
        parser.error('--arms must be a comma-separated subset of A,B,C,H')
    if args.request_limit < 1:
        parser.error('--request-limit must be positive')
    if args.parallel < 1 or args.repeat < 1:
        parser.error('--parallel and --repeat must be positive')
    if not math.isfinite(args.max_usd) or args.max_usd <= 0:
        parser.error('--max-usd must be finite and positive')
    extra_models = list(dict.fromkeys(extra.strip() for extra in args.extra_models.split(',') if extra.strip()))
    extra_models = [extra for extra in extra_models if extra != args.model]
    codex = [m for m in extra_models if m in CODEX_MODELS]
    if codex:
        # The DSH openai-codex route (ChatGPT subscription) has no upstream in this relay/observer yet.
        parser.error('openai-codex route is not available in the bench relay; cannot place in the pool: ' + ', '.join(codex))
    routes = {model: route_for(model) for model in (args.model, *extra_models)}
    for name, route in routes.items():
        if route is None:
            parser.error(f'model {name!r} has no usable route in models.json')
    if args.plan_routing:
        if any(route != 'workbuddy' for route in routes.values()):
            parser.error('plan arms use WorkBuddy or DSH openai-codex executor-side pools only; not eligible: '
                         + ', '.join(m for m, r in routes.items() if r != 'workbuddy'))
    root, plugin = args.out.resolve(), args.plugin.resolve()
    task_file = args.tasks.resolve()
    manifest = json.loads(task_file.read_text())
    dataset = Path(os.environ.get('DSH_BENCH_ROOT', '.')).resolve() / 'evaluator/verified-subset.json'
    statements = {row['instance_id']: row['problem_statement'] for row in json.loads(dataset.read_text())}
    tasks = [{**task, 'problem_statement': statements[task['instance_id']]} for task in manifest['tasks']]
    root.mkdir(parents=True, exist_ok=True)
    config = {'model': args.model, 'arms': arms, 'tasks': str(task_file), 'plugin': str(plugin),
              'planRouting': args.plan_routing, 'planReview': args.plan_review,
              'smokeMinDelegated': args.smoke_min_delegated,
              'delegationInstruction': DELEGATION_INSTRUCTION,
              'label': 'MECHANISM SMOKE (forced delegation)' if args.smoke_min_delegated else None,
              'executorSideProviders': {'preferred': ['workbuddy'], 'allowed': ['openai-codex']} if args.plan_routing else None,
              'parallel': args.parallel, 'repeat': args.repeat, 'taskTimeoutSeconds': TASK_SECONDS,
              'executionRequestLimitExcludingJev': REQUEST_LIMIT, 'jevRequestLimit': JEV_REQUEST_LIMIT, 'maxOutputTokens': MAX_OUTPUT_TOKENS,
              'pressureTokens': PRESSURE_TOKENS, 'retainTokens': RETAIN_TOKENS,
              'compactionThresholdRatio': COMPACTION_THRESHOLD_RATIO,
              'maxChildren': MAX_CHILDREN, 'maxConcurrentChildren': MAX_CONCURRENT,
              'extraModels': extra_models, 'modelRoutes': routes,
              'reviewer': args.reviewer, 'advisor': args.advisor, 'maxUsd': args.max_usd,
              'contextSelection': os.environ.get('BENCH_CONTEXT_SELECTION', 'jev'),
              'jevModel': JEV_MODEL, 'learning': LEARNING}
    config_file = root / 'run-config.json'
    write_json(root / 'tasks.json', manifest)
    write_json(config_file, config)
    pending = [item for item in case_paths(root, tasks, arms, args.repeat) if not (item[3] / 'result.json').exists()]
    if not pending:
        return
    if 'A' in arms and not os.environ.get('JEV_API_KEY'):
        parser.error('Set JEV_API_KEY in the observer environment')
    if any(route.startswith('opencode') for route in routes.values()) and not os.environ.get('OPENCODE_API_KEY'):
        parser.error('Set OPENCODE_API_KEY in the observer environment')
    staged = root / 'plugin'
    if 'A' in arms and not staged.exists():
        stage_plugin(plugin, staged)
    if any(item[1] == 'A' for item in pending):
        jev_preflight(JEV_MODEL)
    failed = transport_failed = jev_calls = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.parallel) as pool:
        futures = {pool.submit(run_case, *item, args.model, staged, extra_models, routes,
                               args.reviewer, args.advisor, args.max_usd): item for item in pending}
        for future in concurrent.futures.as_completed(futures):
            future.result()
            item = futures[future]
            if item[1] == 'A':
                http, transport, total = jev_failures(item[3])
                failed += http
                transport_failed += transport
                jev_calls += total
            # A Jev error answer means a broken configuration; a dropped connection only counts when it
            # persists (an outage that would leave the arm running on local fallbacks).
            if failed >= JEV_FAILURE_LIMIT or (transport_failed >= 4 and transport_failed > 0.1 * jev_calls):
                failed += transport_failed
                pool.shutdown(wait=True, cancel_futures=True)
                raise SystemExit(f'Jev failed {failed} times in arm A; stopped. Check {root} before rerunning.')


if __name__ == '__main__':
    main()
