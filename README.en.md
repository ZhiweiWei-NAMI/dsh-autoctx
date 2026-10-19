# dsh-autoctx

Context and subagent decision plugin for dsh, version **1.2.6**. Jev scores options and makes structured choices; the plugin implements them through native dsh sessions, tools, subagents and compaction. The executor model still does all the coding.

[中文](https://github.com/ZhiweiWei-NAMI/dsh-autoctx/blob/main/README.md) · [Source](https://github.com/ZhiweiWei-NAMI/dsh-autoctx) · MIT

1.2.6 adds explicit plan dispatch (`mode: plan`) with separately stored route learning; DSH GPT-family models on `openai-codex` as allowed alternatives with theoretical list-price cost; closed-step seeds from the parent's current turn and an inherited-context note for newly routed delegation children in `auto` mode; routed delegation ownership and parent result-consumption tracking; and prior overrides for configured-route capability text.

**1.2.6 evaluation takeaway:** On this fixed sample, `deepseek-v4.1-flash` with AutoCTX passed official grading on **18/24 cases (75.0%)**, versus **14/24 (58.3%)** for a single agent and **13/24 (54.2%)** for native subagents: **4 and 5 more resolved cases**, respectively. All three `gpt-6.1-sol` arms resolved the same 18 cases; AutoCTX had about 37% lower theoretical cost than native subagents, but still cost more than a single agent. The DeepSeek paired differences were not statistically significant, and infra reruns occurred; this is not proof of general superiority or savings. See the benchmark and limitations below.

## Environment and accounts

Unit tests pass on **dsh `0.2.0-rc.2` and `0.2.1-rc.2`**, using Node 22; the new 1.2.6 benchmark below ran on **dsh `0.2.1-rc.2`**, the earlier 1.2.5 benchmark on `0.2.0-rc.2`, and real smoke runs were verified on `0.2.1-rc.2`. Peer dependencies for the `@deepseek-ai/dsh-*` packages accept `^0.1.5-rc.1 || ^0.2.0-rc.1 || ^0.2.1-rc.1`. The plugin decides thinking/effort at decision points per trigger, using evidence and a cost estimate per option, as detailed under “How it works”; compatibility with dsh 0.2.1's subagent start API (`startActivation`) and 0.2.0 is kept. The npm package is `dsh-autoctx`, its entry is `index.js`, and its web client is `./client.js`.

You must provide:

- **An executor model connection** in the dsh profile's settings/provider. The plugin does not provide model access.
- **A Jev API key**: obtain a workspace key from [opencode.ai](https://opencode.ai) and set `apiKey`. This key is sent to `jevEndpoint`, which defaults to `https://opencode.ai/inference/v1/systemone`.
- **Optional extra model routes**: if reviewer/advisor roles use other models, configure `modelRoutes` as model id → dsh provider name. Paid routes also require `allowPaidModels: true`.

Without `apiKey`, the plugin makes no Jev call; `auto` sessions run in native mode and record `reason: 'no-api-key'`, while `plan` uses fixed routing.

## Install and configure

1. Create the profile on first use. This command boots it; stop it with Ctrl+C before installing.

   ```sh
   dsh --profile autoctx --from-default-profile web
   ```

   For a headless profile, replace the template with `headless` in the initial creation command. Start your custom profile with `dsh --profile autoctx ...`.

2. Install from npm, or choose the GitHub release tag source.

   ```sh
   dsh plugin --profile autoctx add dsh-autoctx@1.2.6
   # Or use the release tag
   dsh plugin --profile autoctx add github:ZhiweiWei-NAMI/dsh-autoctx#v1.2.6
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
dsh plugin --profile autoctx add dsh-autoctx@1.2.6
```

Before uninstalling, delete any `- id: dsh-autoctx` override you added to the profile's `cordis.patch.yml`, then run:

```sh
dsh plugin --profile autoctx remove dsh-autoctx
```

Removing the bundle layer restores native compaction.

## Settings and defaults

In the web UI, open bottom-left **More → Settings → DSH AutoCTX**. The form covers every current Config key, including plan budgets, provider comma lists, effort/cache budgets, child limits, native threshold and record path. `routes` and `strategy` use JSON editors that refuse malformed or schema-invalid input. Settings remain in the host configuration form, with its revision and writability checks. `apiKey` remains a secret field; the client reads only its configured status.

The Settings page also lists catalog models and configured routes with the catalog prior text and an editable user override (optional reason). Overrides and their full edit history are stored deployment-wide in the `dsh_auto_priors` storage domain, because they describe model capabilities; clearing an override restores the catalog prior. Workspace outcome weights stay in the per-workspace ledger. In the composer card's **Scheduling & learning** table every weight has **Edit**, **Save** and **Clear override** with an optional reason; learning never overwrites a user weight.

**Change history** keeps every ledger change (auto, approved, rejected, revert, user) and every prior edit, with no count limit. Entries are stored one record each, so the workspace ledger record stays small; ledgers from older versions are imported once without duplicates, and any retained applied version can be reverted. The history view filters by kind/source, searches text and pages through the full history with the true total, showing time, key or model, before → after, source, reason or Jev basis and evidence ids (older entries without a field show “–”).

The composer card also lists the latest stored candidate pool per root-session role, with its computation time, memoized flag, unavailable/filtered entries and the backend's verbatim basis. Before a pool exists it labels configured routes and catalog models **Not computed yet**; refreshing the view only reads records and never triggers a recomputation. The host has no per-message decoration slot, so the `conversation.chat.turnTail` slot shows an **Injected by AutoCTX** panel per turn, including native one-shot and embedded child conversations. It lists the source label, kind, character count and time of each injected message without changing messages or storing their text.

**Sessions that are not loaded** (finished or aborted children, sessions from before a restart) work in every AutoCTX view: the session's workspace and root are resolved through the native `sessionQuery` service, and injection labels, candidate pools and the per-root stats card are stored as metadata in the `dsh_auto_ui` storage domain. An unknown session returns an error instead of falling back to another workspace. Sessions run with plugin versions before 1.2.6 have no stored injection or candidate records.

| Key | Default and meaning |
| --- | --- |
| `mode` | `auto`; choices: `auto`, `single`, `native`, `plan` |
| `apiKey` | Unset; native mode in `auto` when unset, fixed routing in `plan` |
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
| `effortSwitchFreeTokens` | `4096`; a decision-point thinking switch whose estimated uncached re-read is at most this proceeds without asking Jev |
| `maxEffortDecisions` | `6`; separate Jev effort-decision calls per root task; never spends `maxDecisions` |
| `effortPhaseRequests` | `4`; maximum high-effort requests in a thinking phase; a new trigger renews the window |
| `cacheTtlSeconds` | `300`; assumed cache-reuse lifetime used in runtime estimates; the provider TTL is unverified |
| `learning` | `frozen`; choices: `auto`, `manual`, `frozen` |
| `contextSelection` | `jev`; choices: `jev`, `summary` |
| `maxDecisions` | `12`; Jev routing/context decision calls per root task |
| `maxChildren` | `2`; child count cap |
| `maxConcurrent` | `2`; concurrent child count cap |
| `maxChildRequests` | `16`; child request cap |
| `maxChildTurnRequests` | `8`; child request cap per turn |
| `pressureTokens` | `64000` tokens; context pressure threshold |
| `ceilingRatio` | `1.5`; context must shrink at `pressureTokens × ceilingRatio` |
| `retainTokens` | `8000` tokens; retained-token setting |

## How it works

**Decisions.** A plain single agent keeps one growing context; native subagents are chosen by the executor through spawn/fork, and native compaction summarizes old context. AutoCTX asks Jev for structured decisions at specific points. Jev is a scoring/choice model; it does not write plans or code. It decides whether a proposed delegation is worth a child and which route to use; gives a task tag and thinking policy at turn start; selects evidence under context pressure and chooses whether to replace context now or later, weighing the cost of re-reading uncached content against smaller later requests; and selects reviewer/advisor models when those roles are set to `auto`.

Thinking policies are `off`, `decision_points`, or `always`; decision points are turn start, test failure, review/advisor report and stall. Since 1.2.5, each trigger supplies evidence such as a failing-test output excerpt, diff hunk, review/advisor report text or task head, with an estimated cost per option at catalog prices: `skip` stays in the current cache space; `pulse` makes one high-effort request; `phase` keeps high effort until the trigger is resolved (test passes, report acted on, progress) or `effortPhaseRequests` requests. Cheap switches (estimated uncached re-read ≤ `effortSwitchFreeTokens`) and switches right after a context replacement proceed without asking Jev. Effort questions use their own `maxEffortDecisions` budget and never spend the 12 routing/context decisions in `maxDecisions`. Cache reuse is estimated from exact request prefixes, with no rewriting, reordering or dropping of context for cache; these runtime estimates are theoretical, not actual bills.

A transient Jev gateway/network failure is retried once, then Jev pauses for 60 seconds. Authentication, billing or HTTP 429 stops Jev for the task, and local fallbacks take over: native compaction and no delegation.

**Context selection.** With `contextSelection: jev`, when context passes `pressureTokens`, the old region is split into evidence pieces—test-failure sections, diff hunks, code by function/class and paragraphs—rather than whole outputs. Jev scores how much each piece adds given the stated open problem, such as which test still fails, and the content kept regardless. Locally, duplicates keep one copy; a kept report pulls in the definition it refers to; pieces that add little are archived as one line each. At `pressureTokens × ceilingRatio`, the session must shrink, using native compaction if needed. `summary` lets the executor summarize instead.

**Reviewer.** Before a root turn that changed files finishes, one review child checks the actual change. Its brief starts with the workspace git diff and code around each changed hunk, then the issue and an evidence ledger. `DEFECTS` reports go back to the executor; `LGTM` ends the turn.

**Advisor.** Off by default. After repeated failing edit-and-rerun attempts on the same test, or a stall, a model with no tools receives a specific question, the raw failure excerpt, the diff, surrounding code and previous attempts.

**Learning.** The ledger is keyed by workspace path and stored in dsh storage `dsh_auto`. After each completed root turn, Jev first judges whether each used (model, role)'s specific claims can be checked against the later edits/test runs they name, then judges their quality. Overall success or the executor ignoring advice is not evidence. Unassessable claims change neither weight nor sample count. Native thumbs up/down on answers is also evidence.

- `frozen` (default): records evidence only; weights never change.
- `auto` (BETA, off by default): applies bounded updates automatically.
- `manual`: collects proposals into one approval card.

Automatic learning is expected to maintain quality while lowering cost over time, but that has not been demonstrated. The **1.2.6 evaluation below used `frozen` learning**: the additional DeepSeek cases resolved reflect the AutoCTX decision mechanism on that sample, not gains from automatic learning. Auto did not outperform frozen in the earlier 1.2.5 evaluation.

## Extra calls and cost

Jev calls, reviewer/advisor children and their executor-model calls, and the turn-end learning call all cost money on your own API accounts. These are not free services. The model table in `models.json` lists catalog prices for `jev-1.13` at **$0.042 per 1 million input tokens, $0 for output tokens**; `jev-1.13-free` is rate limited. Benchmark costs below are theoretical estimates at catalog prices, not actual bills (defined in the benchmark section). In the new 1.2.6 evaluation, DeepSeek A averages 12.1 Jev requests per case and GPT A 5.9; Jev is excluded from the 256 execution-request cap and has its own allowance of 32. In the earlier 1.2.5 evaluation, 72 cases made 368 Jev calls versus 233 for 1.2.3 frozen; those calls counted toward the old 64-request cap.

## Benchmark results and limitations

**Theoretical cost basis.** All cost and cache figures below are **theoretical estimates at catalog prices, not actual bills**. Provider-reported cache hits vary with routing, accounts and eviction, so all arms are compared on the prompt cache they could reuse given exactly what they sent, with identical assumptions and prices: a request reuses the longest prefix it shares with an earlier request of the same task in the same cache space (model + thinking/effort config [+ tools]); no expiry within a task. Uncached input uses the catalog input price (cache-write price where listed), reused input the cache-read price, and output the output price; Jev is $0.042/M input, output free; executor, child and Jev costs are all included. This benchmark's no-expiry-within-task assumption differs from the runtime lifetime assumption in `cacheTtlSeconds`.

### 1.2.6 on dsh 0.2.1-rc.2, execution request cap 256 excluding Jev

The same **12 fixed SWE-bench Verified pytest tasks × 2 executors × 2 repeats** give 24 cases per executor per arm, **144 graded cases** in total. The official SWE-bench harness **v4.1.0** decides resolved; a finished run or HTTP 200 is not a pass. See [bench/eval-021/README.md](https://github.com/ZhiweiWei-NAMI/dsh-autoctx/blob/main/bench/eval-021/README.md) for the harness and `bench/full_report.py` for the report.

| Arm | Configuration |
| --- | --- |
| B | Single agent, plugin off; explicitly told not to delegate |
| C | Native spawn/fork subagents with the executor model, plugin off |
| A | AutoCTX 1.2.6 (the release differs from the evaluated build, commit `f1d6c49`, only in two UI hint strings and the version number), `mode: auto`, learning frozen, reviewer before finish off, advisor off |

C and A receive the same one-sentence delegation instruction: “Split the task into subtasks and delegate suitable subtasks to subagents with the subagent or subagent_fork tools, then integrate their results and verify the final change yourself.”

| Executor | Harness | AutoCTX extra models |
| --- | --- | --- |
| `deepseek-v4.1-flash` | Container harness, 3 cases in parallel | `deepseek-v4-flash`, `glm-5.3-flash`, `deepseek-v4-pro`, `glm-5.3` |
| `gpt-6.1-sol` | DSH `openai-codex` route, host-native harness; shell commands run in the task container | `gpt-6-sol`, `gpt-5.6-luna`, `gpt-6-luna`, `deepseek-v4.1-flash`, `glm-5.3-flash` |

Jev is `jev-1.13`. Common limits for every arm: **600 seconds per case, 256 execution requests (Jev excluded; its separate allowance is 32), at most 2 children / 2 concurrent children**. Only 3 cases, all DeepSeek C, reached the 256 cap. Every arm uses `exact` theoretical cost with the catalog prices, exact-prefix reuse and identical assumptions above, not actual bills.

Transport errors through the network proxy, provider 402 quota responses, and arm-A Jev calls that failed again after the plugin's own retry (`jev_unavailable`) make a case infra-affected. Such attempts were archived, never deleted, and rerun fresh, up to 3 rounds plus a final sweep. Final: **144/144 valid**. Cases rerun (archived attempts): DeepSeek A **11 (16)**, GPT C **3 (8)**, GPT A **5 (9)**, all others 0; early DeepSeek A used a stricter rule that archived any failed Jev attempt. Longer runs are more likely to hit a transient error, so a sensitivity table also excludes any pair where either arm was rerun.

All costs below are theoretical estimates. Non-finished counts solver timeouts/errors; resolved is decided independently by the harness from the exported patch, so the two counts can overlap.

| Executor | Arm | Resolved /24 | Non-finished (timeouts etc.) | Mean wall s | Mean USD/case | Total USD | USD per resolved | Mean exec req | Mean children |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| deepseek-v4.1-flash | B | 14 | 12 | 367 | 0.034 | 0.83 | 0.059 | 78 | 0 |
| deepseek-v4.1-flash | C | 13 | 13 (10 timeouts, 3 agent errors at the request cap) | 452 | 0.076 | 1.83 | 0.141 | 139 | 1.46 |
| deepseek-v4.1-flash | A | 18 | 9 | 416 | 0.095 | 2.27 | 0.126 | 107 (+12.1 Jev) | 1.38 |
| gpt-6.1-sol | B | 18 | 1 | 460 | 0.163 | 3.91 | 0.217 | 25 | 0 |
| gpt-6.1-sol | C | 18 | 4 | 492 | 0.363 | 8.71 | 0.484 | 57 | 1.58 |
| gpt-6.1-sol | A | 18 | 3 | 490 | 0.229 | 5.50 | 0.306 | 77 (+5.9 Jev) | 1.29 |

Pairs match the same task and repeat; differences are **A minus the other arm**. The 95% intervals are percentile bootstrap intervals over the 12 task means; p is exact McNemar on discordant pairs. Resolved differences are proportions.

| Executor / comparison | A-only / other-only / both / neither | Resolved diff [95% CI] | McNemar p | Wall diff s [95% CI] | USD/case diff [95% CI] | A cheaper |
| --- | --- | --- | --- | --- | --- | --- |
| DeepSeek A vs B | 5 / 1 / 13 / 5 | +0.17 [0.00, 0.33] | 0.22 | +48 [−45, +141] | +0.060 [+0.037, +0.086] | 3/24 |
| DeepSeek A vs C | 5 / 0 / 13 / 6 | +0.21 [0.08, 0.33] | 0.063 | −36 [−133, +51] | +0.019 [+0.001, +0.037] | 9/24 |
| GPT A vs B | 0 / 0 / 18 / 6 | 0 (identical outcomes) | — | +30 [+1, +56] | +0.066 [+0.024, +0.126] | 3/24 |
| GPT A vs C | 0 / 0 / 18 / 6 | 0 (identical outcomes) | — | −2 [−23, +18] | −0.134 [−0.175, −0.098] | 24/24 |

GPT A was faster than B in 5/24 pairs. Sensitivity excluding any pair where either arm was rerun:

| Comparison | Resolved diff [95% CI] | USD/case diff [95% CI] | Pair detail |
| --- | --- | --- | --- |
| DeepSeek A vs B | +0.11 [−0.11, 0.39] | +0.069 [+0.026, +0.121] | 13 pairs; A-only / B-only 2/1 |
| DeepSeek A vs C | +0.22 [0.06, 0.44] | +0.032 [+0.005, +0.059] | 13 pairs; A-only / C-only 3/0, p=0.25 |
| GPT A vs B | 0 | +0.037 [+0.014, +0.064] | Resolved outcomes remain identical |
| GPT A vs C | 0 | −0.135 [−0.182, −0.093] | A cheaper in 16/16 pairs |

#### 1.2.6 conclusions

**DeepSeek: more resolved cases on this sample, not generally lower cost.** With `deepseek-v4.1-flash`, AutoCTX achieved **18/24 officially resolved cases (75.0%)**, versus **14/24 (58.3%)** for single-agent B and **13/24 (54.2%)** for native-subagent C: net gains of **4 and 5 cases**, or **16.7 and 20.8 percentage points**. Resolved means passing official tests, not finishing the solver run normally; even a timed-out run can leave a passing patch. The paired differences at 24 cases are not statistically significant (p=0.22 and 0.063). Without rerun pairs, the difference against B shrinks (13 pairs, task-mean difference +0.11), while the one against C stays similar (+0.22, p=0.25). Theoretical cost per case is about 2.8× B and 1.25× C; per resolved case it is about 10% cheaper than C but about 2.1× B. Many DeepSeek cases hit the 600-second timeout in every arm.

**GPT: identical resolved outcomes, lower cost than native subagents.** With `gpt-6.1-sol`, all three arms resolved the same **18/24 cases (75.0%)**; no resolved-rate gain was observed. AutoCTX costs about 37% less than native subagents C (cheaper in 24/24 pairs) at similar wall time; it costs about 40% more than single-agent B and is about 30 seconds slower on average.

**Scope:** These are 1.2.6 observations on 12 fixed pytest tasks, 2 executors and 2 repeats, including the infra reruns above. Costs are theoretical, with the additional missing-usage limitation for GPT A. They do not generalize to all DeepSeek/GPT models. Nor can a direct subtraction from the earlier 1.2.5 results establish a version gain: the host, executor mix, request budget and cost accounting differ.

### 1.2.5 on dsh 0.2.0-rc.2, request cap 64 including Jev (earlier evaluation)

These results describe this run, not general superiority. Every arm uses the same **72 graded cases = 12 fixed SWE-bench Verified pytest tasks (`bench/tasks.json`) × 3 executor models × 2 runs per model**. Executors are `deepseek-v4.1-flash`, `glm-5.3-flash` and `deepseek-v4-flash`. The official SWE-bench harness **v4.1.0** decides resolved; a finished run or HTTP 200 is not a pass.

Shared limits are **600 seconds per task, 64 model requests per task (Jev included), case parallelism 3, at most 2 children / 2 concurrent children**. AutoCTX and H used a $0.10 per-case spend cap; B and C used the harness default $0.50. No case in any arm exceeded $0.066 (theoretical, at catalog prices), so the spend cap never bound.

| Arm | Configuration |
| --- | --- |
| B | Single agent; no subagent tools, native compaction |
| C | Native spawn/fork with the executor model only; native compaction, no reviewer/advisor/extra models |
| H | Native heterogeneous subagents; one native subagent tool per (model, effort) over the executor plus 3 extra models, chosen by the executor |
| AutoCTX 1.2.5 frozen | New release; reviewer `auto`, advisor `auto`, the same 3 extra models, `jev-1.13`; frozen learning |
| AutoCTX 1.2.3 frozen / auto | Previous release, same harness; reviewer `auto`, advisor `auto`, the same 3 extra models, `jev-1.13`; frozen and auto learning respectively; auto carries the ledger across cases within a run |

The 3 extra models are `glm-5.3-flash` (use `deepseek-v4.1-flash` when the executor is glm), `deepseek-v4-pro` and `claude-haiku-5-5`. 1.2.5 ran on dsh `0.2.0-rc.2`, the same host version as 1.2.3/B/C/H. B/C/H do not load the plugin and were run before 1.2.3. B/C used the same harness entry as AutoCTX; H run 1 used an earlier harness snapshot (its `run.py` differs) with the same tasks and shared limits above.

Two measurement methods: `exact` uses per-message prefix hashes recorded by the bench observer (AutoCTX 1.2.x runs). B/C/H were recorded before prefix hashes existed, so they use a `log` reconstruction (append-only growth per session; an input drop marks a context rewrite). Validation by re-running B and C on 12 tasks with `deepseek-v4.1-flash` and prefix hashes (24 cases): `log` gave 2.4% (B) and 3.1% (C) lower cost than `exact`; on AutoCTX it gives about 11% lower cost, because context replacement changes earlier prompt content without necessarily shrinking it. The baseline theoretical figures below are therefore probably ~3% low, and the AutoCTX premium is slightly overstated rather than understated.

Costs and cache rates in this table are theoretical estimates, not actual bills.

| Metric (72 cases per arm) | AutoCTX 1.2.5 frozen | AutoCTX 1.2.3 frozen | AutoCTX 1.2.3 auto | B | C | H |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Resolved / 72 | 53/72 | 52/72 | 49/72 | 39/72 | 44/72 | 42/72 |
| Paired wins/losses of 1.2.5 frozen vs this arm (exact McNemar p) | — | 6/5 (p=1.0) | — | 15/1 (p=0.001) | 12/3 (p=0.035) | 13/2 (p=0.007) |
| Theoretical cost, total USD (method) | $1.738 (exact) | $1.810 (exact) | $1.603 (exact) | $0.908 (log) | $0.975 (log) | $1.027 (log) |
| Of which theoretical cost: executor / children / Jev (USD) | 1.383 / 0.273 / 0.082 | 1.451 / 0.284 / 0.076 | 1.321 / 0.214 / 0.068 | 0.805 / 0.102 / 0 | 0.844 / 0.131 / 0 | 0.867 / 0.160 / 0 |
| Theoretical cost per resolved case | $0.0328 | $0.0348 | $0.0327 | $0.0233 | $0.0222 | $0.0244 |
| Theoretical executor cache rate | 87.0% | 85.4% | 86.5% | 94.8% | 95.1% | 95.1% |
| Wall time sum (seconds) | 17580 | 18060 | 17670 | 17454 | 16520 | 17076 |
| Jev calls ok/all | 367/368 | 233/233 | 260/260 | — | — | — |

With the `log` method applied to every arm, the theoretical total is $1.547 for AutoCTX 1.2.5 frozen versus B $0.908, C $0.975 and H $1.027.

AutoCTX resolves more cases than B, C and H on this sample and costs more; on theoretical cost, 1.2.5 frozen is about 70–80% more than C overall and ~48% more per resolved case. Comparing 1.2.5 with 1.2.3 frozen, lane-matched and `exact`: 53 vs 52 resolved (6 wins / 5 losses, no quality difference); theoretical total cost is down 4.0% ($1.738 vs $1.810), theoretical executor cache rate is 87.0% vs 85.4%, and theoretical Jev cost is up $0.006.

1.2.5 effort decisions across 72 cases: 201 cheap (no Jev call), 86 skip, 51 phase, 9 pulse, 11 after context replacement, and 11 fell back after the effort budget was spent; 19 cases reached the 64-request limit (1.2.3: 18). The limit counts Jev calls, so AutoCTX reaches it with fewer executor requests than the baselines: 10 of those 19 cases were unresolved, and Jev made 77 of their 640 requests (12%). B/C/H also hit the limit (17/20/16 cases), with executor requests only. This historical evaluation retains that shared limit; it was not rerun under the original configuration with only Jev accounting changed. The 1.2.6 evaluation above uses a 256 execution-request cap excluding Jev, but is not that single-variable comparison.

| Executor (24 cases per model per arm; resolved / 24) | AutoCTX 1.2.5 frozen | AutoCTX 1.2.3 frozen | AutoCTX 1.2.3 auto | B | C | H |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| deepseek-v4.1-flash | 18/24 | 17/24 | 16/24 | 11/24 | 15/24 | 14/24 |
| glm-5.3-flash | 17/24 | 18/24 | 18/24 | 17/24 | 18/24 | 18/24 |
| deepseek-v4-flash | 18/24 | 17/24 | 15/24 | 11/24 | 11/24 | 10/24 |

In the auto run, 49 completed turns reached learning: 35/49 were judged unassessable and left weights unchanged; 14/49 applied small updates. Auto did not outperform frozen here.

Only these 12 pytest tasks and 3 flash executors were measured; between repeats, resolved counts vary by about ±2 cases per 12-task run. AutoCTX costs more than the baselines here on the theoretical cost basis; auto learning remains beta and off by default. The host's native fork still seeds only completed turns. In `mode: auto`, newly created delegation children intercepted and routed by AutoCTX also receive the parent's closed steps of the current turn via closed-step seed (excluding the delegating step), plus an inherited-context note. Reviewer/helper and plan children keep their existing seed paths; review briefs still carry current-turn evidence.

## Reproduce

### 1.2.6

Prepare dsh `0.2.1-rc.2`, containers and dataset, model connections and native host `openai-codex` authentication as described in [bench/eval-021/README.md](https://github.com/ZhiweiWei-NAMI/dsh-autoctx/blob/main/bench/eval-021/README.md). Set `DSH_BENCH_NODE` to the corresponding Node installation and `DSH_BENCH_ROOT` to the bench directory containing `evaluator/`. `$WITH_KEYS` is your own wrapper that supplies `JEV_API_KEY` to its command. Run from the repository root, without `--plan-routing` or `--plan-review`:

```sh
R=results/eval-1.2.6
$WITH_KEYS sh -c 'OPENCODE_API_KEY=$JEV_API_KEY exec python3 bench/eval-021/plan/run.py "$@"' sh \
  --model deepseek-v4.1-flash --arms A --tasks bench/eval-021/plan/tasks.json \
  --out "$R/deepseek-v4.1-flash/A" --plugin . --parallel 3 --repeat 2 --request-limit 256 \
  --extra-models deepseek-v4-flash,glm-5.3-flash,deepseek-v4-pro,glm-5.3 \
  --max-usd 0.50 --jev-model jev-1.13 --learning frozen
for arm in B C; do
  $WITH_KEYS python3 bench/eval-021/plan/run.py --model deepseek-v4.1-flash --arms "$arm" \
    --tasks bench/eval-021/plan/tasks.json --out "$R/deepseek-v4.1-flash/$arm" --plugin . \
    --parallel 3 --repeat 2 --request-limit 256 --max-usd 0.50
done
for arm in B C A; do
  for repeat in 1 2; do
    for lane in 1 2; do
      $WITH_KEYS python3 bench/eval-021/host/run_one.py --model gpt-6.1-sol --arm "$arm" \
        --tasks "bench/eval-021/plan/task-full-lane$lane.json" --out "$R/gpt-6.1-sol/$arm-r$repeat-lane$lane" \
        --plugin . --request-limit 256 --jev-model jev-1.13 \
        --extra-models gpt-6-sol,gpt-5.6-luna,gpt-6-luna,deepseek-v4.1-flash,glm-5.3-flash
    done
  done
done
```

Use `affected.py` on each output root to check and archive infra-affected cases; for example:

```sh
RUN="$R/gpt-6.1-sol/A-r1-lane1"
python3 bench/eval-021/affected.py "$RUN" \
  --archive "$R/_infra-archive/gpt-6.1-sol/A-r1-lane1" --tasks-out "$RUN/affected-tasks.json"
```

Rerun only when the printed affected-task count is nonzero. For DeepSeek, resume the original command after archiving. For GPT, use `--tasks "$RUN/affected-tasks.json"` and a fresh sibling `--out` directory such as `A-r1-lane1-retry1`, retaining the arm, repeat and lane markers. Recheck each round, up to 3 rounds plus a final sweep. Keep archives under `$R/_infra-archive/<executor>/...` so the report can count reruns. Then grade the original and rerun directories and generate the report:

```sh
for run in "$R/deepseek-v4.1-flash/"* "$R/gpt-6.1-sol/"*; do
  python3 bench/eval-021/plan/grade.py "$run" --parallel 3
done
python3 bench/full_report.py "$R" --json "$R/report.json" --md "$R/report.md"
```

`bench/full_report.py` (i.e. `bench/eval-021/../full_report.py`) recursively collects results, excludes archives and reports task-paired comparisons and sensitivity without rerun pairs. Costs are theoretical estimates, not actual bills.

### 1.2.5

The earlier evaluation commands are retained below; use a 1.2.5 checkout.

From the repository, prepare the prerequisites in [bench/README.md](https://github.com/ZhiweiWei-NAMI/dsh-autoctx/blob/main/bench/README.md), including Docker and SWE-bench images, a model gateway and `JEV_API_KEY`, then run:

```sh
python3 bench/run.py --model deepseek-v4.1-flash --arms A --tasks bench/tasks.json --out <dir> --plugin . --parallel 3 \
  --extra-models glm-5.3-flash,deepseek-v4-pro,claude-haiku-5-5 --reviewer auto --advisor auto --max-usd 0.10 \
  --jev-model jev-1.13 --learning frozen        # or --learning auto
python3 bench/run.py --model deepseek-v4.1-flash --arms B,C --tasks bench/tasks.json --out <dir> --plugin . --parallel 3
python3 bench/run.py --model deepseek-v4.1-flash --arms H --tasks bench/tasks.json --out <dir> --plugin . --parallel 3 \
  --extra-models glm-5.3-flash,deepseek-v4-pro,claude-haiku-5-5 --max-usd 0.10
python3 bench/grade.py <dir> --parallel 3
python3 bench/theoretical_cost.py "A=<dir>/*/A" "B=<dir>/*/B" "C=<dir>/*/C"
```

Replace `<dir>` with an output directory. A is AutoCTX; use separate directories for frozen and auto. Run for all 3 executor models, with 2 runs per model and separate directories for independent runs. For `glm-5.3-flash`, change `--extra-models` to `deepseek-v4.1-flash,deepseek-v4-pro,claude-haiku-5-5`; `deepseek-v4-flash` uses the extra models shown above. Re-running the same command resumes unfinished cases. `--max-usd 0.10` is the bench observer's $0.10 per-case spend cap. `bench/theoretical_cost.py` estimates cost and cache reuse with the method above; its outputs are theoretical estimates, not actual bills.

## Upgrading from older versions

Install 1.2.6 using the upgrade steps above and check profile overrides against the current configuration table. Do not carry over the old README's default model or installation tag: the current default is billed `jev-1.13`, and the release tag is `v1.2.6`.
