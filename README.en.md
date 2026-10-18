# dsh-autoctx

Context and subagent decision plugin for dsh, version **1.2.3**. Jev scores options and makes structured choices; the plugin implements them through native dsh sessions, tools, subagents and compaction. The executor model still does all the coding.

[中文](https://github.com/ZhiweiWei-NAMI/dsh-autoctx/blob/main/README.md) · [Source](https://github.com/ZhiweiWei-NAMI/dsh-autoctx) · MIT

## Environment and accounts

The verified host is **dsh `0.2.0-rc.2`**, using Node 22. Peer dependencies for the `@deepseek-ai/dsh-*` packages accept `^0.1.5-rc.1 || ^0.2.0-rc.1`. The npm package is `dsh-autoctx`, its entry is `index.js`, and its web client is `./client.js`.

You must provide:

- **An executor model connection** in the dsh profile's settings/provider. The plugin does not provide model access.
- **A Jev API key**: obtain a workspace key from [opencode.ai](https://opencode.ai) and set `apiKey`. This key is sent to `jevEndpoint`, which defaults to `https://opencode.ai/inference/v1/systemone`.
- **Optional extra model routes**: if reviewer/advisor roles use other models, configure `modelRoutes` as model id → dsh provider name. Paid routes also require `allowPaidModels: true`.

Without `apiKey`, the plugin makes no network call, the session runs in native mode, and it records `reason: 'no-api-key'`.

## Install and configure

1. Create the profile on first use. This command boots it; stop it with Ctrl+C before installing.

   ```sh
   dsh --profile autoctx --from-default-profile web
   ```

   For a headless profile, replace the template with `headless` in the initial creation command. Start your custom profile with `dsh --profile autoctx ...`.

2. Install from npm, or choose the GitHub release tag source.

   ```sh
   dsh plugin --profile autoctx add dsh-autoctx
   # Or use the release tag
   dsh plugin --profile autoctx add github:ZhiweiWei-NAMI/dsh-autoctx#v1.2.3
   ```

   `dsh plugin --profile <name> <pnpm-args...>` passes arguments to pnpm. Profiles live in `$DSH_HOME/profiles/<name>`. The package's declared dsh bundle patch (`cordis.patch.yml`) mounts the plugin and disables native `compaction-basic`; no duplicate manual mount is needed.

3. Configure the executor model connection in dsh itself, and add this minimal configuration to **the profile's own** `$DSH_HOME/profiles/autoctx/cordis.patch.yml`, not the home-level patch.

   ```yaml
   - id: dsh-autoctx
     config:
       apiKey: <your opencode workspace key>
   ```

4. Start the web app.

   ```sh
   dsh --profile autoctx
   ```

Disable the plugin and restore native compaction for one launch:

```sh
dsh --profile autoctx --patch "$DSH_HOME/profiles/autoctx/node_modules/dsh-autoctx/off.patch.yml"
```

Upgrade to the latest version, or pin this version:

```sh
dsh plugin --profile autoctx add dsh-autoctx@latest
# Or pin the version
dsh plugin --profile autoctx add dsh-autoctx@1.2.3
```

Before uninstalling, delete any `- id: dsh-autoctx` override you added to the profile's `cordis.patch.yml`, then run:

```sh
dsh plugin --profile autoctx remove dsh-autoctx
```

Removing the bundle layer restores native compaction.

## Settings and defaults

In the web UI, open bottom-left **Settings → DSH AutoCTX**, or **Plugins → dsh-autoctx → Configure**. Fields include mode, learning, context selection, adaptive thinking effort, Jev endpoint, model routes and ceiling ratio. A composer chip shows context pressure and decisions; its card shows the schedule, thinking policy and learning ledger, including pending proposals in manual mode. `apiKey` is a secret field and is not written to logs or record files.

| Key | Default and meaning |
| --- | --- |
| `mode` | `auto`; choices: `auto`, `single`, `native` |
| `apiKey` | Unset; native mode when unset |
| `jevModel` | `jev-1.13`, billed; `jev-1.13-free` is available but rate limited |
| `jevEndpoint` | `https://opencode.ai/inference/v1/systemone` |
| `modelRoutes` | `{}`; model id → dsh provider name |
| `allowPaidModels` | `false`; whether to allow paid routes |
| `reviewerModel` | `same`; fork review with the executor's model; `auto` lets Jev choose, or specify a model id |
| `reviewBeforeFinish` | `true`; one independent review child before a root turn that changed files finishes |
| `reviewMaxRequests` | `6`; review request cap |
| `advisorModel` | `off`; choices: `off`, `auto`, or a model id |
| `advisorMaxConsults` | `1`; advisor consultation cap |
| `advisorStallSteps` | `6`; stall step threshold |
| `adaptiveEffort` | `high`; effort used when Jev's thinking policy calls for it; `off` keeps the default effort |
| `learning` | `frozen`; choices: `auto`, `manual`, `frozen` |
| `contextSelection` | `jev`; choices: `jev`, `summary` |
| `maxDecisions` | `12`; Jev decision calls per root task |
| `maxChildren` | `2`; child count cap |
| `maxConcurrent` | `2`; concurrent child count cap |
| `maxChildRequests` | `16`; child request cap |
| `maxChildTurnRequests` | `8`; child request cap per turn |
| `pressureTokens` | `64000` tokens; context pressure threshold |
| `ceilingRatio` | `1.5`; context must shrink at `pressureTokens × ceilingRatio` |
| `retainTokens` | `8000` tokens; retained-token setting |

## How it works

**Decisions.** A plain single agent keeps one growing context; native subagents are chosen by the executor through spawn/fork, and native compaction summarizes old context. AutoCTX asks Jev for structured decisions at specific points. Jev is a scoring/choice model; it does not write plans or code. It decides whether a proposed delegation is worth a child and which route to use; gives a task tag and thinking policy at turn start; selects evidence under context pressure and chooses whether to replace context now or later, weighing the cost of re-reading uncached content against smaller later requests; and selects reviewer/advisor models when those roles are set to `auto`.

Thinking policies are `off`, `decision_points`, or `always`; decision points are turn start, test failure, review/advisor report and stall. Calls per task are capped by `maxDecisions`. A transient Jev gateway/network failure is retried once, then Jev pauses for 60 seconds. Authentication, billing or HTTP 429 stops Jev for the task, and local fallbacks take over: native compaction and no delegation.

**Context selection.** With `contextSelection: jev`, when context passes `pressureTokens`, the old region is split into evidence pieces—test-failure sections, diff hunks, code by function/class and paragraphs—rather than whole outputs. Jev scores how much each piece adds given the stated open problem, such as which test still fails, and the content kept regardless. Locally, duplicates keep one copy; a kept report pulls in the definition it refers to; pieces that add little are archived as one line each. At `pressureTokens × ceilingRatio`, the session must shrink, using native compaction if needed. `summary` lets the executor summarize instead.

**Reviewer.** Before a root turn that changed files finishes, one review child checks the actual change. Its brief starts with the workspace git diff and code around each changed hunk, then the issue and an evidence ledger. `DEFECTS` reports go back to the executor; `LGTM` ends the turn.

**Advisor.** Off by default. After repeated failing edit-and-rerun attempts on the same test, or a stall, a model with no tools receives a specific question, the raw failure excerpt, the diff, surrounding code and previous attempts.

**Learning.** The ledger is keyed by workspace path and stored in dsh storage `dsh_auto`. After each completed root turn, Jev first judges whether each used (model, role)'s specific claims can be checked against the later edits/test runs they name, then judges their quality. Overall success or the executor ignoring advice is not evidence. Unassessable claims change neither weight nor sample count. Native thumbs up/down on answers is also evidence.

- `frozen` (default): records evidence only; weights never change.
- `auto` (BETA, off by default): applies bounded updates automatically.
- `manual`: collects proposals into one approval card.

Automatic learning is expected to maintain quality while lowering cost over time, but that has not been demonstrated; auto did not outperform frozen in this benchmark.

## Extra calls and cost

Jev calls, reviewer/advisor children and their executor-model calls, and the turn-end learning call all cost money on your own API accounts. These are not free services. The model table in `models.json` lists `jev-1.13` at **$0.042 per 1 million input tokens, $0 for output tokens**; `jev-1.13-free` is rate limited. Benchmark costs below are estimates at API catalog prices.

## Benchmark results and limitations

These results describe this run, not general superiority. Every arm uses the same **72 graded cases = 12 fixed SWE-bench Verified pytest tasks (`bench/tasks.json`) × 3 executor models × 2 runs per model**. Executors are `deepseek-v4.1-flash`, `glm-5.3-flash` and `deepseek-v4-flash`. The official SWE-bench harness **v4.1.0** decides resolved; a finished run or HTTP 200 is not a pass.

Limits are identical for every arm: **600 seconds per task, 64 model requests per task (including Jev calls for AutoCTX), case parallelism 3, at most 2 children / 2 concurrent children**.

| Arm | Configuration |
| --- | --- |
| B | Single agent; no subagent tools, native compaction |
| C | Native spawn/fork with the executor model only; native compaction, no reviewer/advisor/extra models |
| H | Native heterogeneous subagents; one native subagent tool per (model, effort) over the executor plus 3 extra models, chosen by the executor |
| AutoCTX frozen / auto | 1.2.3; reviewer `auto`, advisor `auto`, the same 3 extra models, `jev-1.13`; frozen and auto learning respectively; auto carries the ledger across cases within a run |

The 3 extra models are `glm-5.3-flash` (use `deepseek-v4.1-flash` when the executor is glm), `deepseek-v4-pro` and `claude-haiku-5-5`. B/C/H do not load the plugin and were run before 1.2.3. B/C used the same harness entry as 1.2.3; H run 1 used an earlier harness snapshot (its `run.py` differs) with the same tasks and the limits above.

| Metric (72 cases per arm) | AutoCTX frozen | AutoCTX auto | B | C | H |
| --- | ---: | ---: | ---: | ---: | ---: |
| Resolved / 72 | 52/72 | 49/72 | 39/72 | 44/72 | 42/72 |
| Estimated API catalog cost, executor + children + Jev (USD) | $1.514 | $1.374* | $0.876 | $0.933 | $1.018 |
| Jev portion of the above cost (USD) | $0.076 | $0.068* | N/A | N/A | N/A |
| Wall time sum (seconds) | 18060 | 17670 | 17454 | 16520 | 17076 |
| Prompt cache hit rate | 87.5% | 88.4% | 94.3% | 94.6% | 93.9% |

\* Auto had 1 request without usage, which is unpriced.

| Executor (24 cases per model per arm; resolved / 24) | Frozen | Auto | B | C | H |
| --- | ---: | ---: | ---: | ---: | ---: |
| deepseek-v4.1-flash | 17/24 | 16/24 | 11/24 | 15/24 | 14/24 |
| glm-5.3-flash | 18/24 | 18/24 | 17/24 | 18/24 | 18/24 |
| deepseek-v4-flash | 17/24 | 15/24 | 11/24 | 11/24 | 10/24 |

In the auto run, 49 completed turns reached learning: 35/49 were judged unassessable and left weights unchanged; 14/49 applied small updates. Auto did not outperform frozen here. Possible explanations for the lower cache rate include context replacement rewriting part of the prompt, review/advisor briefs, and Jev-switched thinking modes adding new uncached input. These are hypotheses, not proven causes.

Only these 12 pytest tasks and 3 flash executors were measured; between repeats, resolved counts vary by about ±2 cases per 12-task run. AutoCTX costs more than the baselines here; auto learning remains beta. There is also a host limitation: a fork created mid-turn is seeded only with completed turns, so the review brief must carry the current turn's evidence itself.

## Reproduce

From the repository, prepare the prerequisites in [bench/README.md](https://github.com/ZhiweiWei-NAMI/dsh-autoctx/blob/main/bench/README.md), including Docker and SWE-bench images, a model gateway and `JEV_API_KEY`, then run:

```sh
python3 bench/run.py --model deepseek-v4.1-flash --arms A --tasks bench/tasks.json --out <dir> --plugin . --parallel 3 \
  --extra-models glm-5.3-flash,deepseek-v4-pro,claude-haiku-5-5 --reviewer auto --advisor auto --max-usd 0.10 \
  --jev-model jev-1.13 --learning frozen        # or --learning auto
python3 bench/run.py --model deepseek-v4.1-flash --arms B,C --tasks bench/tasks.json --out <dir> --plugin . --parallel 3
python3 bench/run.py --model deepseek-v4.1-flash --arms H --tasks bench/tasks.json --out <dir> --plugin . --parallel 3 \
  --extra-models glm-5.3-flash,deepseek-v4-pro,claude-haiku-5-5 --max-usd 0.10
python3 bench/grade.py <dir> --parallel 3
```

Replace `<dir>` with an output directory. A is AutoCTX; use separate directories for frozen and auto. Run for all 3 executor models, with 2 runs per model and separate directories for independent runs. For `glm-5.3-flash`, change `--extra-models` to `deepseek-v4.1-flash,deepseek-v4-pro,claude-haiku-5-5`; `deepseek-v4-flash` uses the extra models shown above. Re-running the same command resumes unfinished cases. `--max-usd 0.10` is the bench observer's $0.10 per-case spend cap.

## Upgrading from older versions

Install 1.2.3 using the upgrade steps above and check profile overrides against the current configuration table. Do not carry over the old README's default model or installation tag: the current default is billed `jev-1.13`, and the release tag is `v1.2.3`.
