# A/B/C SWE-bench harness v2

Runs the fixed 12 pytest instances in `tasks.json` (identifiers and base commits only) with native dsh. Issue texts are read at run time from the local evaluator dataset; solvers receive only `problem_statement`. A loads
`dsh-autoctx` in auto mode with native compaction disabled; B disables delegation
and uses native compaction; C enables native spawn/fork with native compaction.
B/C never load the plugin under test.

## Prerequisites

- Linux, Docker CLI/daemon, and the cached official
  `swebench/sweb.eval.x86_64.pytest-dev_1776_pytest-*:latest` images.
- Python 3.10+ and PyYAML. Grading additionally needs the official SWE-bench harness
  (the previous setup used v4.1.0); its installed version is recorded in each evaluation.
- `DSH_BENCH_NODE`: a Node 22 installation directory whose global `@deepseek-ai/dsh` is the dsh under
  test (mounted read-only into every case), with `dsh-llm-pi-ai` supporting
  `openai-completions`, native in-process subagents and `compaction-basic`.
- WorkBuddy pool already listening at `http://127.0.0.1:8788/v1/chat/completions`.
- Private evaluator dataset at `$DSH_BENCH_ROOT/evaluator/verified-subset.json`
  (`DSH_BENCH_ROOT` defaults to the current directory), and the official SWE-bench
  harness installed in the Python that runs `grade.py` (`$DSH_BENCH_ROOT/venv`).
  Only grading reads it; it is never mounted into solver containers.
- Set `JEV_API_KEY` in the host environment through your existing secret mechanism.
  Set `HTTPS_PROXY` if required to reach OpenCode. Neither value is copied into
  configuration or solver containers. The observer substitutes the real Jev key
  for the plugin's non-secret local placeholder and never logs Authorization headers.

The specified old harness and original task manifest were unavailable during this
revision. The checked-in public 12-task manifest is retained; old-run parity has
not been verified.

## Reproduce

From this plugin repository, with the prerequisites and environment ready:

```sh
python bench/run.py --model deepseek-v4.1-flash --arms A,B,C --tasks bench/tasks.json --out bench/results/deepseek-v41 --plugin . --parallel 3
python bench/run.py --model deepseek-v4-flash --arms A,B,C --tasks bench/tasks.json --out bench/results/deepseek-v4 --plugin . --parallel 3
python bench/run.py --model glm-5.3-flash --arms A,B,C --tasks bench/tasks.json --out bench/results/glm-53 --plugin . --parallel 3

python bench/grade.py bench/results/deepseek-v41 bench/results/deepseek-v4 bench/results/glm-53
python bench/summarize.py bench/results/deepseek-v41 bench/results/deepseek-v4 bench/results/glm-53
```

`--plugin` accepts another local plugin checkout. Its `package.json` and declared
`files` are snapshotted once into the run and mounted read-only for A; repository
history, evaluator outputs and credentials are not included. Use a new output
folder for a changed plugin, model or task selection.

`--parallel N` runs at most N cases (default 3). Arms rotate ABC/BCA/CAB by task.
`--repeat K` uses `repeat-0/<instance>/<arm>/`, `repeat-1/<instance>/<arm>/`, etc.;
a single repeat uses `<instance>/<arm>/`. All commands use this same layout.
Re-run the same command to resume: only cases with `result.json` are skipped.
Incomplete cases get a fresh solver home. An empty pending queue exits immediately.
Worker failures propagate; they leave no completion marker. Grading errors remain
ungraded and are retried by the next grading command.

## Outputs and accounting

Each completed case contains `patch.diff`, `requests.json`, `result.json`,
`decisions-and-children.json` and its solver logs under `trial/`. Grading adds
`evaluation.json`, the official report when available, and isolated work under
`grading/<attempt>/`; it updates `result.json.resolved` from official outcomes.
Harness errors are not classified as failed patches. A case whose execution upstream fails at the transport level or answers 402 or 5xx (pool quota or availability), whose Jev request is refused with 403, or in which the plugin under test did not activate is recorded in `infra-error.json` without a completion marker, so the next run retries it.

Execution calls go dsh → local relay → observer → WorkBuddy. Jev calls go plugin
→ observer `/jev` → OpenCode through the host proxy. Every admitted upstream
attempt, including HTTP errors, retries, compaction and Jev, consumes the shared
64-call budget. Requests rejected at the budget boundary are not upstream calls.
Request records include main/child/compaction/jev role, model, reported token usage,
latency, HTTP status when received, and an anonymized account label when returned.
Usage is read from JSON or SSE for both upstreams. Missing usage stays unmeasured.

`runtime.mjs` records native lifecycle events for every arm, enforces C's child
limits, and attaches role/session metadata to execution requests. Child counts
use actual lifecycle events and observed child requests; completion requires a
native completed event. Malformed optional records are skipped individually.

Each run gets `summary.json` and `summary.md`, including a per-task/repeat matrix.
Multiple runs of the same model remain separate entries in `bench-summary.json`
in the first run's parent directory. The denominator is the fixed task count
(12 per arm per repeat), including missing cases. Token sums cover all reported
execution and Jev usage; the table shows coverage so partial sums are explicit.
Wall time covers solving, stopping residual solver processes and exporting the
patch; environment preparation and official grading are reported separately.

## Fairness

All arms use a 600-second solver deadline, 64 shared upstream calls, at most two
children and two concurrent children, depth 1, pressure 24k / retain 8k, and a
16384-token output cap. The configured context window is 128000; B/C's native
compaction threshold ratio is 0.1875. Each case has 4 CPUs, 8 GB RAM, runc, no GPU,
an internal Docker network and an independent observer budget. The selected
execution model and provider are shared by main agents, children and compaction.
Only the initial Git commit is retained. All solver processes are killed before
patch export, including after timeout. Private reference patches remain outside
solver mounts; grading writes only under the case output directory.
