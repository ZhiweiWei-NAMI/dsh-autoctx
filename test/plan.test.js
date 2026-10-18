import test from "node:test";
import assert from "node:assert/strict";
import { validatePlan, planGuard, contextOptions, sourceLabel, childPrompt, changedPaths, changesPlanFiles, suitabilityQuestions } from "../plan.js";
import { emptyRouteLedger, routeKey, routePrior, applyRouteFacts, verifiedRouteFacts } from "../routeledger.js";
import { emptyLedger, weightKey, setUser } from "../ledger.js";
import { costUSD } from "../models.js";
import { fingerprint } from "../cachespace.js";
import { fakePlan, task } from "./plan-fixture.js";

test("plans require complete unique subtasks, known acyclic dependencies and available slots", () => {
  assert.equal(validatePlan({ subtasks: [task("read"), task("fix", { dependsOn: ["read"] })] }, 2), null);
  assert.equal(validatePlan({ subtasks: [task("main", { owner: "main" })] }, 0), null);
  for (const input of [null, {}, { subtasks: [] }]) assert.match(validatePlan(input, 3), /at least one/);
  assert.match(validatePlan({ subtasks: [task(), task()] }, 3), /Duplicate/);
  assert.match(validatePlan({ subtasks: [task("fix", { dependsOn: ["missing"] })] }, 3), /Unknown dependency/);
  assert.match(validatePlan({ subtasks: [task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["a"] })] }, 3), /cycle/);
  assert.match(validatePlan({ subtasks: [task("self", { dependsOn: ["self"] })] }, 3), /cycle/);
  assert.match(validatePlan({ subtasks: [task()] }, 0), /planMaxChildren/);
  for (const extra of [{ context: undefined }, { context: [null] }, { files: "a.js" }, { dependsOn: [1] }, { goal: " " }, { owner: "unknown" }])
    assert.ok(validatePlan({ subtasks: [task("bad", extra)] }, 3));
});

test("the plan guard permits reads and requires a plan before changing files", () => {
  const base = { child: false, planned: false, cwd: "/repo" };
  assert.equal(planGuard({ ...base, name: "read", args: { file_path: "a.js" }, changesFiles: false }), undefined);
  assert.match(planGuard({ ...base, name: "edit", args: { file_path: "a.js" }, changesFiles: true }), /Call plan/);
  assert.equal(planGuard({ ...base, planned: true, name: "edit", args: { file_path: "a.js" }, changesFiles: true }), undefined);
  for (const name of ["plan", "subagent", "subagent_fork"])
    assert.match(planGuard({ ...base, child: true, name }), /cannot plan or delegate/);
});

test("children stay within assigned files and root edits name the running owner", () => {
  const base = { cwd: "/repo", planned: true, name: "edit", changesFiles: true };
  assert.equal(planGuard({ ...base, child: true, files: ["a.js"], args: { file_path: "/repo/./a.js" } }), undefined);
  assert.match(planGuard({ ...base, child: true, files: ["a.js"], args: { file_path: "b.js" } }), /outside.*b.js/);
  assert.match(planGuard({ ...base, child: true, files: ["a.js"], args: { file_path: "../a.js" } }), /outside/);
  assert.equal(planGuard({ ...base, child: true, files: [], args: { file_path: "b.js" } }), undefined);
  assert.match(planGuard({ ...base, child: false, owners: [{ child: "owner-7", files: ["a.js"] }],
    args: { file_path: "a.js" } }), /owner-7/);
  assert.equal(planGuard({ ...base, child: false, owners: [{ child: "owner-7", files: ["a.js"] }],
    args: { file_path: "b.js" } }), undefined);
  const patch = "*** Begin Patch\n*** Update File: a.js\n@@\n-a\n+b\n*** Move to: b.js\n*** End Patch";
  assert.deepEqual(changedPaths("apply_patch", { patch }), ["a.js", "b.js"]);
  assert.match(planGuard({ ...base, name: "apply_patch", child: true, files: ["a.js"], args: { patch } }), /outside.*b.js/);
  const shell = { command: "sed -i 's/old/new/' b.js" };
  assert.equal(changesPlanFiles("bash", shell, () => false), true);
  assert.match(planGuard({ ...base, name: "bash", child: true, files: ["a.js"], args: shell }), /outside.*b.js/);
  assert.equal(changesPlanFiles("bash", { command: "cat a.js && pytest tests/test_a.py >/dev/null" }, () => false), false);
});

test("context estimates distinguish parent cache spaces, sibling reuse and all-new briefs", () => {
  const parent = { provider: "native", model: "deepseek-v4.1-flash", reasoningEffort: "high" };
  const sibling = { child: "idle-child", route: parent, status: "settled", prefixTokens: 1800, prefixEnd: 10, at: 1000 };
  const request = { parent, route: parent, prefixTokens: 1000, briefTokens: 100, siblings: [sibling],
    needs: ["src/a.js"], prefixEnd: 9, now: 1100, ttlMs: 1000 };
  const options = contextOptions(request);
  const prefix = options.find((option) => option.option === "parent-prefix");
  assert.equal(prefix.sameSpace, true);
  assert.equal(prefix.estCachedTokens, 1000);
  assert.equal(prefix.uncachedTokens, 100);
  assert.equal(prefix.usd, costUSD(parent.model, { inputTokens: 100, cacheReadTokens: 1000, outputTokens: 0 }));
  const reuse = options.find((option) => option.option === "sibling-reuse:idle-child");
  assert.equal(reuse.estCachedTokens, 1800);
  assert.equal(reuse.uncachedTokens, 100);
  const brief = options.find((option) => option.option === "brief");
  assert.equal(brief.estPrefixTokens, 0);
  assert.equal(brief.estCachedTokens, 0);
  assert.equal(brief.uncachedTokens, 100);
  for (const route of [{ ...parent, model: "glm-5.3-flash" }, { ...parent, reasoningEffort: "low" }, { ...parent, provider: "other" }]) {
    const changed = contextOptions({ ...request, route })[0];
    assert.equal(changed.sameSpace, false);
    assert.equal(changed.estCachedTokens, 0);
    assert.equal(changed.uncachedTokens, 1100);
    assert.match(changed.cache, /entire prefix re-read uncached/);
  }
  assert.equal(contextOptions({ ...request, needs: ["parent-history"], prefixEnd: 11 })
    .find((option) => option.provider === "reuse").carriesNeeded, false);
  assert.equal(contextOptions({ ...request, needs: ["parent-history"] }).at(-1).carriesNeeded, false);
  assert.equal(contextOptions({ ...request, now: 3000 }).find((option) => option.provider === "reuse").estCachedTokens, 0);
});

test("sibling fingerprint reuse respects its actual cached prefix and TTL", () => {
  const route = { provider: "native", model: "deepseek-v4.1-flash" };
  const latest = fingerprint({ ...route, tools: [], messages: [{ role: "user", content: "prior" }] }, () => 700);
  const options = contextOptions({ route, parent: route, prefixTokens: 1000, briefTokens: 100,
    needs: [], prefixEnd: 3, now: 1100, ttlMs: 1000,
    siblings: [{ route, child: "child", status: "settled", latest, prefixTokens: 750, prefixEnd: 3, at: 1000 }] });
  assert.equal(options[1].estCachedTokens, 700);
  assert.equal(options[1].uncachedTokens, 150);
});

test("relay and brief labels preserve their origin on the first line", () => {
  assert.equal(sourceLabel("c1", { model: "m1", reasoningEffort: "high" }, "fix"),
    "[from child c1 · m1/high · subtask fix · via dsh-autoctx]");
  const prompt = childPrompt({ session: "root", task: task(), brief: "Observed evidence", dependencies: [] });
  assert.equal(prompt.split("\n")[0], "[from parent root · brief · via dsh-autoctx]");
  assert.match(prompt, /only this subtask/);
});

test("the route ledger is isolated from reviewer weights and frozen snapshots", () => {
  const reviewer = setUser(emptyLedger("frozen"), weightKey("implement", "m", "reviewer"), 1, 0);
  const before = structuredClone(reviewer);
  const key = routeKey("implement", "m", "high");
  const ledger = emptyRouteLedger();
  const facts = [{ id: "child:stop", type: "stop", value: "completed" }, { id: "child:file", type: "file", value: "a.js" }];
  assert.equal(applyRouteFacts(ledger, key, facts, "frozen").applied, false);
  assert.deepEqual(ledger, emptyRouteLedger());
  const learned = applyRouteFacts(ledger, key, facts, "auto");
  assert.equal(learned.ledger.rows[key].filesSurvived, 1);
  assert.equal(learned.ledger.rows[key].stops.completed, 1);
  assert.equal(applyRouteFacts(learned.ledger, key, facts, "auto").facts, 0);
  assert.deepEqual(reviewer, before);
  const prior = routePrior(learned.ledger, key);
  prior.filesSurvived = 99;
  assert.equal(learned.ledger.rows[key].filesSurvived, 1);
  const questions = suitabilityQuestions([task()], [{ options: { model: "m", reasoningEffort: "high" } }], learned.ledger);
  assert.match(questions.route_0.instructions, /do not consider caching/);
  assert.match(questions.route_0.criteria.p0, /filesSurvived/);
  assert.doesNotMatch(questions.route_0.criteria.p0, /reviewer/);
});

test("route facts require surviving content and a later root rerun with pass", () => {
  const entry = { id: "child:1", stopReason: "completed", at: 5,
    files: new Map([["kept.js", "hash"], ["reverted.js", "old"], ["overwritten.js", "old"]]), tests: ["pytest kept.py", "pytest stale.py"] };
  const facts = verifiedRouteFacts(entry, { currentFiles: new Map([["kept.js", "hash"], ["reverted.js", "old"], ["overwritten.js", "new"]]),
    diffFiles: new Set(["kept.js", "overwritten.js"]), rootGraph: { tests: {
      "pytest kept.py": { runs: [{ event: 6, outcome: "pass", via: "child" }, { event: 7, outcome: "pass" }] },
      "pytest stale.py": { runs: [{ event: 4, outcome: "pass" }, { event: 8, outcome: "fail" }] },
    } } });
  assert.deepEqual(facts.map((fact) => [fact.type, fact.value]), [["stop", "completed"], ["file", "kept.js"], ["test", "pytest kept.py"]]);
});

test("fixed routing and a main-only plan spend no Jev calls", async () => {
  const app = fakePlan();
  const main = await app.accept([task("main", { owner: "main" })]);
  assert.equal(main.concludesTurn, undefined);
  assert.equal(main.isError, false);
  assert.equal(app.dispatcher.guard(app.exec("edit", { file_path: "a.js" })), undefined);
  const delegated = await app.accept([task()]);
  assert.equal(delegated.concludesTurn, true);
  assert.equal(delegated.value.assignments[0].model, app.root.options.model);
  assert.equal(delegated.value.assignments[0].contextOption, "parent-prefix");
  assert.equal(app.decisions.length, 0);
  assert.equal(app.records.find((record) => record.kind === "plan_route").jev, false);
  assert.equal(app.records.filter((record) => record.kind === "plan_recorded").some((record) => "goal" in record), false);
});

test("the separate plan Jev budget falls back to parent routing for remaining decisions", async () => {
  const app = fakePlan({ planRouting: "jev", apiKey: "fake", planMaxJevCalls: 1 });
  const result = await app.accept([task("a"), task("b")]);
  assert.equal(result.isError, false);
  assert.equal(app.decisions.length, 1);
  assert.equal(app.decisions[0].trigger, "plan_route");
  assert.ok(result.value.assignments.every((assignment) => assignment.contextOption === "parent-prefix"));
  assert.match(app.records.find((record) => record.kind === "plan_fallback").reason, /planMaxJevCalls/);
  await app.accept([task("c")], 2);
  assert.equal(app.decisions.length, 1);
});

test("replans share the root child budget and validation errors remain errors", async () => {
  const app = fakePlan({ planMaxChildren: 1 });
  assert.equal((await app.accept([task("a")])).isError, false);
  const rejected = await app.accept([task("b")], 2);
  assert.equal(rejected.isError, true);
  assert.match(rejected.error.message, /planMaxChildren/);
  assert.equal(app.dispatcher.stateFor(app.root).used, 1);
});
