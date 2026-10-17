import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { apply } from "../index.js";
import { createGraph, observe, editsAfter } from "../graph.js";
import { newStats, applyStatsRecord } from "../stats.js";

function childSession(id) {
  return {
    id,
    header: { parentSession: "root" },
    requestHeader: () => undefined,
    snapshotEvents: () => [],
    surface: { nodes: [] },
    eventAt: () => ({ data: { message: { content: [], source: { kind: "user" } } } }),
    deriveEventMessage: () => ({ content: [], source: { kind: "user" } }),
  };
}

function reviewComposition(options = {}) {
  const handlers = new Map(),
    agents = new Map(),
    children = [],
    steered = [],
    tables = new Map();
  let started = 0,
    settlement = null;
  const signal = new AbortController().signal;
  const config = {
    mode: "auto",
    apiKey: "test-key",
    jevModel: "jev-test",
    jevEndpoint: "https://jev.invalid",
    routes: [],
    maxChildren: 2,
    maxConcurrent: 1,
    maxChildRequests: 16,
    maxChildTurnRequests: 8,
    maxDecisions: 10,
    pressureTokens: 2000,
    ceilingRatio: 1.5,
    retainTokens: 1024,
    economyGuidance: false,
    keepRatio: 0.35,
    reviewBeforeFinish: true,
    reviewMaxRequests: 10,
    ...options,
  };
  const root = {
    options: { provider: "native", model: "main" },
    session: {
      id: "root",
      header: {},
      requestHeader: () => undefined,
      snapshotEvents: () => [],
      surface: { nodes: [] },
      eventAt: () => ({ data: { message: { content: [], source: { kind: "user" } } } }),
      deriveEventMessage: () => ({ content: [], source: { kind: "user" } }),
    },
    steer: (message) => steered.push(message),
  };
  agents.set("root", root);
  async function startChild(provider, request, mode = "one-shot") {
    if (options.failStart) throw new Error("provider refused");
    started++;
    const child = {
      id: "review-" + started,
      kind: "child",
      mode,
      provider,
      prompt: request.prompt[0].text,
      toolFilter: request.toolFilter,
    };
    children.push(child);
    agents.set(child.id, { session: childSession(child.id), steer() {} });
    handlers.get("subagent/start")({ id: child.id, runId: child.id + "-run" });
    const result = new Promise((resolve) => {
      settlement = (stopReason = options.stopReason ?? "completed") => {
        const output = options.report ?? [{ type: "text", text: "LGTM: tests pass" }];
        handlers.get("subagent/end")({
          id: child.id,
          runId: child.id + "-run",
          stopReason,
          lastAssistantMessage: output,
        });
        if (mode === "continuable") root.steer({
          source: { kind: "subagent-settled", senderSessionId: child.id },
          content: output,
        });
        resolve({ stopReason, output });
      };
    });
    const abort = () => settlement("aborted");
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    return {
      id: child.id,
      result,
      dispose: async () => {
        request.signal.removeEventListener("abort", abort);
        child.disposed = true;
      },
    };
  }
  const ctx = {
    tools: {
      guard() {},
      get: () => ({ parameters: { type: "object" } }),
    },
    on(name, fn) {
      handlers.set(name, fn);
    },
    inject() {},
    llm: { prepareCall: async () => {} },
    agents: { get: (id) => agents.get(id) },
    tokenMeter: {
      measure: () => ({ totalTokens: 100, nodes: [] }),
      estimateMessage: (message) => JSON.stringify(message).length / 4,
    },
    storageDomain: {
      open: async () => ({
        table: (name) => {
          if (!tables.has(name)) tables.set(name, new Map());
          const recordsTable = tables.get(name);
          return {
            get: (key) => recordsTable.get(key),
            delete: async (key) => recordsTable.delete(key),
            put: async (key, value) => recordsTable.set(key, value),
          };
        },
        close: async () => {},
      }),
    },
    subagents: {
      listChildren: async () => children,
      getProvider: (name) =>
        options.noFork && name === "fork" ? undefined : {},
      start: startChild,
      startContinuable: ({ provider, request, signal }) =>
        startChild(provider, { ...request, signal }, "continuable"),
    },
  };
  apply(ctx, config);
  return {
    config,
    ctx,
    root,
    agents,
    children,
    handlers,
    steered,
    get started() {
      return started;
    },
    settle: () => settlement?.(),
    preStep: (turn, agent = root, messages = []) =>
      handlers.get("agent/pre-step")(
        { agent, messages, turn, signal },
        async () => ({ kind: "continue" }),
      ),
    edit: (agent = root, name = "edit", args = {}, isError = false) =>
      handlers.get("tools/result")({ name, agent, arguments: args, callId: "call-edit" }, { isError }),
    stop: (turn, agent = root, abort = signal) =>
      handlers.get("agent/turn-stopping")({ agent, turn, signal: abort }),
  };
}

function recordAll(t) {
  const records = [];
  t.mock.method(fs, "appendFileSync", (file, line) => records.push(JSON.parse(line)));
  return records;
}

test("a root turn that changed a file gets one review, and the report is steered back", async (t) => {
  const records = recordAll(t);
  const app = reviewComposition({ recordFile: "review.jsonl" });
  await app.preStep(1, app.root, [{
    source: { kind: "user" },
    content: [{ type: "text", text: "Fix the missing widget." }],
  }]);
  app.edit();
  const pending = app.stop(1);
  assert.equal(app.started, 1);
  assert.equal(app.children.length, 1);
  assert.equal(app.children[0].mode, "one-shot");
  assert.match(app.children[0].prompt, /Original issue:\nFix the missing widget\./);
  assert.deepEqual(app.children[0].toolFilter, { deny: ["subagent", "subagent_fork"] });
  assert.deepEqual(records.filter((r) => r.kind === "review_start").length, 1);
  await app.stop(1);
  assert.equal(app.started, 1);
  app.settle();
  await pending;
  assert.equal(app.children[0].disposed, true);
  assert.equal(records.filter((r) => r.kind === "review_end").length, 1);
  assert.equal(records.find((r) => r.kind === "review_end").lgtm, true);
  assert.equal(app.steered.length, 1);
  assert.deepEqual(app.steered[0].source, { kind: "dsh-autoctx" });
  assert.match(app.steered[0].content[0].text, /Independent review of your change/);
  assert.match(app.steered[0].content[0].text, /LGTM: tests pass/);
  assert.match(app.steered[0].content[0].text, /fix it and verify; otherwise finish\./);
  await app.stop(1);
  await app.preStep(2);
  await app.stop(2);
  assert.equal(app.started, 1);
});

test("bash records python, perl and patch writes", () => {
  const graph = createGraph();
  const command = `cd /testbed && python - <<'EOF'
p='src/_pytest/setuponly.py'
s=open(p).read()
s=s.replace("old", "new")
open(p,'w').write(s)
EOF
cat >> testing/test_setuponly.py <<'EOF'
def test_missing():
    assert True
EOF
python -c "open('src/c.py','a').write('x')"
perl -pi -e 's/a/b/' src/d.py
git apply fix.patch
patch -p1 < fix.patch`;
  observe(graph, 1, { name: "bash", arguments: { command } }, { isError: false });
  assert.deepEqual(editsAfter(graph, 0).map(({ path }) => path), [
    "src/_pytest/setuponly.py", "testing/test_setuponly.py", "src/c.py", "src/d.py", "(patch)",
  ]);
  assert.deepEqual(graph.tests, {});
  assert.deepEqual(graph.commands, []);
});

test("read-only python scripts do not count as edits", () => {
  const graph = createGraph();
  const command = `python - <<'EOF'
p='src/_pytest/setuponly.py'
print(open(p).read())
EOF`;
  observe(graph, 1, { name: "bash", arguments: { command } }, { isError: false });
  observe(graph, 2, { name: "bash", arguments: { command: "python -c \"print(open('/tmp/x.py').read())\"" } }, { isError: false });
  assert.deepEqual(editsAfter(graph, 0), []);
  assert.deepEqual(graph.files, {});
});

test("a turn changed only by a bash write still gets one review", async (t) => {
  const records = recordAll(t);
  const app = reviewComposition({ recordFile: "review.jsonl" });
  await app.preStep(1);
  app.edit(app.root, "bash", {
    command: "cat > src/widget.js <<'EOF'\nexport const widget = 1;\nEOF",
  });
  const pending = app.stop(1);
  assert.equal(app.started, 1);
  assert.deepEqual(records.filter((r) => r.kind === "review_start").length, 1);
  app.settle();
  await pending;
});

test("a read-only bash turn does not start a review", async (t) => {
  recordAll(t);
  const app = reviewComposition({ recordFile: "review.jsonl" });
  await app.preStep(1);
  app.edit(app.root, "bash", { command: "cat src/widget.js" });
  await app.stop(1);
  assert.equal(app.started, 0);
});

test("read-only turns, children and disabled reviews never start a review", async (t) => {
  const records = recordAll(t);
  const readOnly = reviewComposition({ recordFile: "review.jsonl" });
  await readOnly.preStep(1);
  readOnly.edit(readOnly.root, "read");
  readOnly.edit(readOnly.root, "str_replace_editor", { command: "view" });
  readOnly.edit(readOnly.root, "edit", {}, true);
  await readOnly.stop(1);
  assert.equal(readOnly.started, 0);

  const child = {
    session: childSession("child"),
    steer() {},
  };
  const underChild = reviewComposition({ recordFile: "review.jsonl" });
  underChild.agents.set("child", child);
  await underChild.preStep(1, child);
  underChild.edit(child);
  await underChild.stop(1, child);
  assert.equal(underChild.started, 0);

  const disabled = reviewComposition({ reviewBeforeFinish: false, recordFile: "review.jsonl" });
  await disabled.preStep(1);
  disabled.edit();
  await disabled.stop(1);
  assert.equal(disabled.started, 0);
  assert.equal(records.filter((r) => r.kind === "review_start").length, 0);
});

test("a review is skipped when no child slot or request budget remains", async (t) => {
  recordAll(t);
  const noSlot = reviewComposition({ maxChildren: 1, recordFile: "review.jsonl" });
  noSlot.children.push({ id: "existing", kind: "child" });
  noSlot.agents.set("existing", { session: childSession("existing"), steer() {} });
  noSlot.handlers.get("subagent/start")({ id: "existing", runId: "existing-run" });
  await noSlot.preStep(1);
  noSlot.edit();
  await noSlot.stop(1);
  assert.equal(noSlot.started, 0);
  assert.equal(noSlot.children.length, 1);

  const noBudget = reviewComposition({ maxChildRequests: 0, recordFile: "review.jsonl" });
  await noBudget.preStep(1);
  noBudget.edit();
  await noBudget.stop(1);
  assert.equal(noBudget.started, 0);
});

test("a review start failure is recorded and does not abort the turn", async (t) => {
  const records = recordAll(t);
  const app = reviewComposition({ failStart: true, recordFile: "review.jsonl" });
  await app.preStep(1);
  app.edit();
  await app.stop(1);
  assert.equal(app.started, 0);
  assert.equal(records.filter((r) => r.kind === "review_failed").length, 1);
  assert.match(records.find((r) => r.kind === "review_failed").error, /provider refused/);
  assert.equal(app.steered.length, 0);
});

test("an empty review report is recorded as a failure without steering anything", async (t) => {
  const records = recordAll(t);
  const app = reviewComposition({
    report: [{ type: "text", text: "   " }],
    recordFile: "review.jsonl",
  });
  await app.preStep(1);
  app.edit();
  const pending = app.stop(1);
  app.settle();
  await pending;
  assert.equal(records.filter((r) => r.kind === "review_end").length, 0);
  assert.match(records.find((r) => r.kind === "review_failed").error, /no report/);
  assert.equal(app.steered.length, 0);
});

test("an aborted turn propagates the abort instead of recording a failure", async (t) => {
  const records = recordAll(t);
  const app = reviewComposition({ recordFile: "review.jsonl" });
  await app.preStep(1);
  app.edit();
  const controller = new AbortController();
  const pending = app.stop(1, app.root, controller.signal);
  await Promise.resolve();
  controller.abort(new Error("turn cancelled"));
  await assert.rejects(pending, /turn cancelled/);
  assert.equal(records.filter((r) => r.kind === "review_failed").length, 0);
});

test("the fork provider is preferred, with spawn as the fallback", async (t) => {
  recordAll(t);
  const withFork = reviewComposition({ recordFile: "review.jsonl" });
  await withFork.preStep(1);
  withFork.edit();
  const pending = withFork.stop(1);
  assert.equal(withFork.children[0].provider, "fork");
  withFork.settle();
  await pending;

  const noFork = reviewComposition({ noFork: true, recordFile: "review.jsonl" });
  await noFork.preStep(1);
  noFork.edit(noFork.root, "str_replace_editor", { command: "str_replace" });
  const fallback = noFork.stop(1);
  assert.equal(noFork.children[0].provider, "spawn");
  assert.match(noFork.children[0].prompt, /Original issue:/);
  noFork.settle();
  await fallback;
});

test("failed settlement with partial LGTM output does not continue the parent", async (t) => {
  const records = recordAll(t);
  const app = reviewComposition({ stopReason: "error", recordFile: "review.jsonl" });
  await app.preStep(1);
  app.edit();
  const pending = app.stop(1);
  app.settle();
  await pending;
  assert.equal(app.children[0].disposed, true);
  assert.equal(records.filter((r) => r.kind === "review_end").length, 0);
  assert.match(records.find((r) => r.kind === "review_failed").error, /ended with error/);
  assert.equal(app.steered.length, 0);
});

test("review statistics count completed reviews and LGTM reports", () => {
  let stats = newStats("auto", 12, 64000);
  stats = applyStatsRecord(stats, { kind: "review_end", lgtm: true });
  stats = applyStatsRecord(stats, { kind: "review_end", lgtm: false });
  stats = applyStatsRecord(stats, { kind: "review_failed" });
  assert.equal(stats.reviews, 2);
  assert.equal(stats.reviewsLgtm, 1);
});
