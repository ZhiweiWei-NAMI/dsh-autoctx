import { createPlanDispatcher } from "../plandispatch.js";
import { createGraph } from "../graph.js";
import { emptyRouteLedger, applyRouteFacts } from "../routeledger.js";

export const task = (id = "work", extra = {}) => ({ id, kind: "implement", goal: "Fix the observed defect",
  owner: "delegate", files: [id + ".js"], acceptance: "The requested behavior works", context: ["parent-history"], ...extra });
export const resultText = (value = { summary: "Completed assigned work", filesChanged: [], testsRun: [], openIssues: [] }) =>
  "Done.\n```json\n" + JSON.stringify(value) + "\n```";
export const completed = (extra = {}) => ({ stopReason: "completed", output: [{ type: "text", text: resultText() }], ...extra });
export const tick = () => new Promise((resolve) => setImmediate(resolve));

export function fakePlan(overrides = {}) {
  const config = { mode: "plan", planRouting: "fixed", planMaxChildren: 3, planMaxJevCalls: 6,
    planChildRequests: 16, maxConcurrent: 2, learning: "frozen", cacheTtlSeconds: 300, ...overrides };
  const events = [], followups = [], starts = [], messages = [], decisions = [], records = [], agents = new Map(), graphs = new Map();
  const root = { options: { provider: "native", model: "deepseek-v4.1-flash", reasoningEffort: "high" },
    session: { id: "root", header: { cwd: "/repo" }, snapshotEvents: () => events },
    followup(message) { followups.push(message); } };
  agents.set("root", root);
  const signal = new AbortController().signal;
  let ledger = emptyRouteLedger(), dispatcher;
  const ctx = { agents: { get: (id) => agents.get(id) }, subagents: {
    async startActivation(spec) {
      starts.push(spec);
      await overrides.establish?.(spec);
      const child = { options: spec.request.agentOptions ?? root.options,
        session: { id: spec.childId, header: { cwd: "/repo", parentSession: "root" }, snapshotEvents: () => events } };
      agents.set(spec.childId, child);
      dispatcher.onChildStart({ id: spec.childId });
      let settle;
      const result = new Promise((resolve) => { settle = resolve; });
      spec.settle = (outcome = completed()) => { agents.delete(spec.childId); settle(outcome); };
      return { childId: spec.childId, result, dispose: async () => {} };
    },
    async sendMessage(sender, targetId, content, options) {
      messages.push({ sender, targetId, content, options });
      return "message-" + messages.length;
    },
  } };
  const graphFor = (id) => {
    if (!graphs.has(id)) graphs.set(id, createGraph());
    return graphs.get(id);
  };
  const changesFilesCall = (name) => ["edit", "write", "apply_patch", "multi_edit"].includes(name);
  dispatcher = createPlanDispatcher({ ctx, config, record: (record) => records.push(record),
    note: (content) => ({ role: "user", source: { kind: "dsh-autoctx" }, content: [{ type: "text", text: content }] }),
    changesFilesCall, currentRoute: (agent) => ({ ...agent.options }),
    profilesFor: async () => [{ options: root.options, capability: "General work" },
      { options: { provider: "other", model: "glm-5.3-flash", reasoningEffort: "high" }, capability: "Alternative route" }],
    async decide(agent, request) {
      decisions.push(request);
      if (overrides.decide) return overrides.decide(agent, request);
      return { answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, {
        type: "choice", confidence: 1, choice: key.startsWith("route_") ? "p0" : key.startsWith("context_") ? "parent-prefix" : "summary",
      }])) };
    },
    tokensOf: (text) => text.length / 4,
    prefixOf: () => ({ tokens: 1000, end: events.at(-1)?.seq ?? -1 }),
    briefFor: () => "User requested a concrete fix. Observed: named failure.", graphFor,
    readLedger: async () => ledger,
    learn: async (_cwd, key, facts, mode) => { const result = applyRouteFacts(ledger, key, facts, mode); ledger = result.ledger; return result; },
    diffFiles: async () => [],
  });
  return { dispatcher, config, ctx, root, events, followups, starts, messages, decisions, records, graphFor,
    exec: (name, arguments_, agent = root, turn = 1) => ({ name, arguments: arguments_, agent, turn, signal }),
    accept: (subtasks, turn = 1) => dispatcher.tool({ subtasks }, { agent: root, turn, signal }),
    end(turn = 1) {
      const event = { seq: events.length, type: "turn/end", data: { turn, reason: { kind: "completed" } } };
      events.push(event);
      return dispatcher.onEvent(root.session, event);
    },
    start: () => dispatcher.startReady(root, signal),
  };
}
