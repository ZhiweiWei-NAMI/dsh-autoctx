# dsh-autoctx

Context and subagent decision plugin for dsh, version **1.2.5**. Jev scores options and makes structured choices; the plugin implements them through native dsh sessions, tools, subagents and compaction. The executor model still does all the coding.

[中文](https://github.com/ZhiweiWei-NAMI/dsh-autoctx/blob/main/README.md) · [Source](https://github.com/ZhiweiWei-NAMI/dsh-autoctx) · MIT

## Environment and accounts

Unit tests pass on **dsh `0.2.0-rc.2` and `0.2.1-rc.2`**, using Node 22; the benchmark below ran on `0.2.0-rc.2`, and real smoke runs were verified on `0.2.1-rc.2`. Peer dependencies for the `@deepseek-ai/dsh-*` packages accept `^0.1.5-rc.1 || ^0.2.0-rc.1 || ^0.2.1-rc.1`. 1.2.5 decides thinking/effort at decision points per trigger, using evidence and a cost estimate per option, as detailed under “How it works”; compatibility with dsh 0.2.1's subagent start API (`startActivation`) and 0.2.0 is kept. The npm package is `dsh-autoctx`, its entry is `index.js`, and its web client is `./client.js`.

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
   dsh plugin --profile autoctx add github:ZhiweiWei-NAMI/dsh-autoctx#v1.2.5
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
dsh plugin --profile autoctx add dsh-autoctx@1.2.5
```

Before uninstalling, delete any `- id: dsh-autoctx` override you added to the profile's `cordis.patch.yml`, then run:

```sh
dsh plugin --profile autoctx remove dsh-autoctx
```

Removing the bundle layer restores native compaction.

## Settings and defaults

In the web UI, open bottom-left **Settings → DSH AutoCTX**, or **Plugins → dsh-autoctx → Configure**. The form covers every current Config key, including plan budgets, provider comma lists, effort/cache budgets, child limits, native threshold and record path. `routes` and `strategy` use JSON editors that refuse malformed or schema-invalid input. Settings remain in the host configuration form, with its revision and writability checks. `apiKey` remains a secret field; the client reads only its configured status.

The Settings page also lists catalog models and configured routes with catalog prior text and an editable user override. Overrides and their full edit history live in the deployment-wide `dsh_auto_priors` storage domain (`priors` table, `catalog` record), shared across workspaces because they describe model capabilities. Clearing an override restores the catalog prior. Workspace outcome weights remain in the existing per-workspace ledger. In the composer card's **Scheduling & learning** table, each weight has **Edit**, **Save** and **Clear override**, with an optional reason. Learned weights never overwrite user preferences. Change history pages every retained ledger change (the existing retention is 20 batches), plus prior edits, with source, reason/Jev basis and evidence ids when recorded; old missing fields show “–”.

The composer card lists the latest retained candidate pool per root-session role, with actual computation time, memoized flag, unavailable/filtered entries and the backend's verbatim basis. Before a pool exists it labels configured routes/catalog as **Not computed yet**. Refreshing the view reads records; it does not trigger candidate computation. The host has no generic per-message decoration slot: the additive `conversation.chat.turnTail` slot displays **Injected by AutoCTX** panels by turn, including native one-shot and embedded child conversations. Panels list recorded source label, kind, character count and time without changing messages. The first turn also includes injection records preceding its start. Session metadata is bounded in memory and disappears on restart; no message text is retained by the UI tap.

<details>
<summary>UI backend integration in index.js (owned by the main agent)</summary>

This UI worktree deliberately leaves `index.js` unchanged. Apply the fragments below at the indicated existing locations (under 20 executable lines). Rename the imported `knowledge` to `catalogKnowledge`; the local wrapper then covers all four existing knowledge-builder call sites. Make `apply` async and await the prior domain before registering model-facing handlers. `openPriors` owns its disposal. Append `tap.push` at the **start** of `record(value)` so capture is independent of record-file logging. Register the UI routes immediately after `updateLedger` is declared. Replace the existing user-action handler and its validation condition, retaining its following 400 response. Replace `ledgerView`'s eight-entry history slice with the full retained history.

```js
import { registerUiRoutes, createRecordTap } from "./uiapi.js";
import { openPriors, priorTextOf } from "./priors.js";
// models.js import: replace `knowledge,` with:
  knowledge as catalogKnowledge,
export async function apply(ctx, options) { // replace existing signature
  // after the existing config declaration:
  const tap = createRecordTap(1000), priors = await openPriors(ctx);
  const knowledge = list => catalogKnowledge(list.map(entry => ({ ...entry,
    prior: priorTextOf(entry.id) ?? entry.prior })));
  // first line of record(value):
  tap.push({ at: Date.now(), ...value });
  // after updateLedger:
  registerUiRoutes(ctx, { config, readLedger, updateLedger, statsRoot,
    cwdOf: id => ctx.agents.get(id)?.session.header.cwd, catalog: CATALOG.models, tap, priors });
  // replace actions.user:
  user: ledger => ({ ledger: setUser(ledger, body.key, body.value, now, body.reason) }),
  // replace the existing user validation `if` condition:
  if (body.action === "user" && (typeof body.key !== "string" || !body.key.trim() || (body.value !== null && (typeof body.value !== "number" || !Number.isFinite(body.value) || body.value < 0 || body.value > 1)) || (body.reason !== undefined && typeof body.reason !== "string")))
  // replace ledgerView.history:
  history: ledger.history,
```

The snippets are placement instructions, not one contiguous function. For configured-only models that never enter `knowledge(...)`, also apply `priorTextOf(route.model)` when assembling their capability/route description; do not overwrite catalog measurements. The main agent owns that model-routing decision. If changing the `apply` signature is undesirable, await `openPriors(ctx)` in the existing startup lifecycle before any `priorTextOf` call; the synchronous getter refuses use before initialization.

`registerUiRoutes(ctx, deps)` consumes `config`, `readLedger(cwd)`, `statsRoot(sessionId)`, `cwdOf(rootSessionId)`, `catalog` (the `models[]` array), `tap`, and `priors` (`snapshot()` and durable `set(model, valueOrNull, reason)`). It does not register a second ledger route. `createRecordTap(limit)` returns synchronous `push(record)`, `injections(sessionIds)` and `candidates(sessionIds)`; arrays of session ids are accepted, injections match **to**, candidates match **session** and select the latest timestamp per role. Only whitelisted metadata from the two agreed record kinds is copied. The limit is a combined FIFO count across both kinds. Supply `at` from the producer; the shown wiring stamps records lacking it.

Additional endpoints, all with `cache-control: no-store`:

- `GET /api/dsh-autoctx/injections?session=<viewed-id>` returns `{session, injections}` for that recipient, without root remapping.
- `GET /api/dsh-autoctx/candidates?session=<id>` maps to the root and returns `{session, computed, pools}`. With no retained pool it adds `status: "not computed yet"` and `configured: {routes, modelRoutes, catalog}`; these are configuration facts, not availability claims.
- `GET /api/dsh-autoctx/priors` returns `{scope: "deployment", models: [{id, catalog?, override?, routes}]}`. `POST` accepts `{model, value: string|null, reason?}`; an unknown model or invalid edit returns 400.
- `GET /api/dsh-autoctx/history?session=<id>&offset=0&limit=25&kind=ledger|prior&via=auto|approved|rejected|revert|user|prior&q=<text>` returns `{cwd?, entries, total, offset, limit, nextOffset}`. Filters are optional; limit is 1–100. `kind=prior` needs no session. All other history reads require a known session workspace, never an invented empty workspace. Prior entries are deployment-wide; ledger entries belong to that workspace.

New test sources cover these contracts and ledger compatibility. They were written without running tests, Node, builds, typechecks, browsers, servers or models. Runtime verification and the above integration remain with the main agent.

</details>

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

Thinking policies are `off`, `decision_points`, or `always`; decision points are turn start, test failure, review/advisor report and stall. In 1.2.5, each trigger supplies evidence such as a failing-test output excerpt, diff hunk, review/advisor report text or task head, with an estimated cost per option at catalog prices: `skip` stays in the current cache space; `pulse` makes one high-effort request; `phase` keeps high effort until the trigger is resolved (test passes, report acted on, progress) or `effortPhaseRequests` requests. Cheap switches (estimated uncached re-read ≤ `effortSwitchFreeTokens`) and switches right after a context replacement proceed without asking Jev. Effort questions use their own `maxEffortDecisions` budget and never spend the 12 routing/context decisions in `maxDecisions`. Cache reuse is estimated from exact request prefixes, with no rewriting, reordering or dropping of context for cache; these runtime estimates are theoretical, not actual bills.

A transient Jev gateway/network failure is retried once, then Jev pauses for 60 seconds. Authentication, billing or HTTP 429 stops Jev for the task, and local fallbacks take over: native compaction and no delegation.

**Context selection.** With `contextSelection: jev`, when context passes `pressureTokens`, the old region is split into evidence pieces—test-failure sections, diff hunks, code by function/class and paragraphs—rather than whole outputs. Jev scores how much each piece adds given the stated open problem, such as which test still fails, and the content kept regardless. Locally, duplicates keep one copy; a kept report pulls in the definition it refers to; pieces that add little are archived as one line each. At `pressureTokens × ceilingRatio`, the session must shrink, using native compaction if needed. `summary` lets the executor summarize instead.

**Reviewer.** Before a root turn that changed files finishes, one review child checks the actual change. Its brief starts with the workspace git diff and code around each changed hunk, then the issue and an evidence ledger. `DEFECTS` reports go back to the executor; `LGTM` ends the turn.

**Advisor.** Off by default. After repeated failing edit-and-rerun attempts on the same test, or a stall, a model with no tools receives a specific question, the raw failure excerpt, the diff, surrounding code and previous attempts.

**Learning.** The ledger is keyed by workspace path and stored in dsh storage `dsh_auto`. After each completed root turn, Jev first judges whether each used (model, role)'s specific claims can be checked against the later edits/test runs they name, then judges their quality. Overall success or the executor ignoring advice is not evidence. Unassessable claims change neither weight nor sample count. Native thumbs up/down on answers is also evidence.

- `frozen` (default): records evidence only; weights never change.
- `auto` (BETA, off by default): applies bounded updates automatically.
- `manual`: collects proposals into one approval card.

Automatic learning is expected to maintain quality while lowering cost over time, but that has not been demonstrated; auto did not outperform frozen in this benchmark.

## Extra calls and cost

Jev calls, reviewer/advisor children and their executor-model calls, and the turn-end learning call all cost money on your own API accounts. These are not free services. The model table in `models.json` lists catalog prices for `jev-1.13` at **$0.042 per 1 million input tokens, $0 for output tokens**; `jev-1.13-free` is rate limited. Benchmark costs below are theoretical estimates at catalog prices, not actual bills (defined in the benchmark section). Over the 72 cases, 1.2.5 makes 368 Jev calls versus 233 for 1.2.3 frozen; these calls also count toward a task's request limit.

## Benchmark results and limitations

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

**Theoretical cost basis.** All cost and cache figures below are **theoretical estimates at catalog prices, not actual bills**. Provider-reported cache hits vary with routing, accounts and eviction, so all arms are compared on the prompt cache they could reuse given exactly what they sent, with identical assumptions and prices: a request reuses the longest prefix it shares with an earlier request of the same task in the same cache space (model + thinking/effort config [+ tools]); no expiry within a task. Uncached input uses the catalog input price (cache-write price where listed), reused input the cache-read price, and output the output price; Jev is $0.042/M input, output free; executor, child and Jev costs are all included. This benchmark's no-expiry-within-task assumption differs from the runtime lifetime assumption in `cacheTtlSeconds`.

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

1.2.5 effort decisions across 72 cases: 201 cheap (no Jev call), 86 skip, 51 phase, 9 pulse, 11 after context replacement, and 11 fell back after the effort budget was spent; 19 cases reached the 64-request limit (1.2.3: 18). The limit counts Jev calls, so AutoCTX reaches it with fewer executor requests than the baselines: 10 of those 19 cases were unresolved, and Jev made 77 of their 640 requests (12%). B/C/H also hit the limit (17/20/16 cases), with executor requests only. This benchmark keeps the shared limit; a rerun excluding Jev from it has not been done.

| Executor (24 cases per model per arm; resolved / 24) | AutoCTX 1.2.5 frozen | AutoCTX 1.2.3 frozen | AutoCTX 1.2.3 auto | B | C | H |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| deepseek-v4.1-flash | 18/24 | 17/24 | 16/24 | 11/24 | 15/24 | 14/24 |
| glm-5.3-flash | 17/24 | 18/24 | 18/24 | 17/24 | 18/24 | 18/24 |
| deepseek-v4-flash | 18/24 | 17/24 | 15/24 | 11/24 | 11/24 | 10/24 |

In the auto run, 49 completed turns reached learning: 35/49 were judged unassessable and left weights unchanged; 14/49 applied small updates. Auto did not outperform frozen here.

Only these 12 pytest tasks and 3 flash executors were measured; between repeats, resolved counts vary by about ±2 cases per 12-task run. AutoCTX costs more than the baselines here on the theoretical cost basis; auto learning remains beta and off by default. There is also a host limitation: a fork created mid-turn is seeded only with completed turns, so the review brief must carry the current turn's evidence itself.

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
python3 bench/theoretical_cost.py "A=<dir>/*/A" "B=<dir>/*/B" "C=<dir>/*/C"
```

Replace `<dir>` with an output directory. A is AutoCTX; use separate directories for frozen and auto. Run for all 3 executor models, with 2 runs per model and separate directories for independent runs. For `glm-5.3-flash`, change `--extra-models` to `deepseek-v4.1-flash,deepseek-v4-pro,claude-haiku-5-5`; `deepseek-v4-flash` uses the extra models shown above. Re-running the same command resumes unfinished cases. `--max-usd 0.10` is the bench observer's $0.10 per-case spend cap. `bench/theoretical_cost.py` estimates cost and cache reuse with the method above; its outputs are theoretical estimates, not actual bills.

## Upgrading from older versions

Install 1.2.5 using the upgrade steps above and check profile overrides against the current configuration table. Do not carry over the old README's default model or installation tag: the current default is billed `jev-1.13`, and the release tag is `v1.2.5`.
