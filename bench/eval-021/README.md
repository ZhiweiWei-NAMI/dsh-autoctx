# Full evaluation harness (dsh 0.2.1, AutoCTX 1.2.6)

The harness used for the 1.2.6 evaluation in the top-level README, kept as run. Only path wiring changed: `host/` finds
`plan/` next to it, `plan/common.py` reads the repository `models.json`, the supervisor takes its paths from the
environment, and published task manifests omit the problem statements (both entry points fill them from the local
SWE-bench subset).

- `plan/run.py`: container harness (DSH and tools in the task container, model calls through the bench observer). Used
  for `deepseek-v4.1-flash`. `--request-limit` counts execution requests only; Jev has its own allowance of 32.
- `host/run_one.py`: host-native harness for executors on DSH's `openai-codex` route (`gpt-6.1-sol`). DSH runs on the
  host with a fresh per-case `DSH_HOME` and reads the owner's existing credentials in place; every shell command runs in
  the task container. It expects a DSH profile named `codex_sol` that configures that route.
- `plan/grade.py`: official SWE-bench harness v4.1.0 (CPU), per case.
- `affected.py`: lists and archives (never deletes) infra-affected cases so they can be rerun fresh: an execution
  transport error (`infra-error.json`), or for AutoCTX a Jev call that still failed after the plugin's own retry
  (`jev_unavailable`).
- `run-full-eval.sh`: the supervisor (B, C and A; two repeats; reruns of affected cases, at most three rounds).
- `../full_report.py ROOT [--json OUT] [--md OUT]`: per executor × arm table, paired comparisons with bootstrap
  intervals, per-arm rerun counts and a sensitivity table without rerun pairs. Costs are theoretical (catalog prices,
  exact-prefix reuse), not billed.

Prerequisites are those of [../README.md](../README.md) (Docker, SWE-bench images under `evaluator/`, the model
gateway, `JEV_API_KEY`), plus DSH 0.2.1 (`DSH_BENCH_NODE`).
