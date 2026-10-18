import { randomUUID } from "node:crypto";
import { fileState, emptyRouteLedger, routeKey, verifiedRouteFacts } from "./routeledger.js";
import { STATE_BYTES } from "./decisions.js";
import {
  validatePlan, sameModelEffort, contextOptions, suitabilityQuestions, contextQuestions, childPrompt,
  planGuard, changedPaths, changesPlanFiles, workspacePath, assertWorkspaceFiles, sourceLabel, dispatcherLabel,
  briefLabel, resultBlock,
} from "./plan.js";

const errorResult = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, error: { message }, content: [{ type: "text", text: message }] };
};
const outputText = (output) => (output ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
const describe = (assignment) => ({ subtask: assignment.task.id, model: assignment.route.model,
  effort: assignment.route.reasoningEffort ?? "default", contextOption: assignment.option.option });

export function createPlanDispatcher({ ctx, config, record, note, decide, currentRoute, profilesFor,
  tokensOf, prefixOf, briefFor, graphFor, readLedger, learn, diffFiles, changesFilesCall }) {
  const roots = new Map(), children = new Map();
  const stateFor = (agent) => {
    const id = agent.session.header.parentSession ?? agent.session.id;
    if (!roots.has(id)) roots.set(id, { agent, planned: false, used: 0, jevCalls: 0, dispatches: [],
      ready: false, requests: new Map(), evidence: [], settlements: new Set(), learning: Promise.resolve() });
    return roots.get(id);
  };
  const assignmentsOf = (state) => state.dispatches.flatMap((dispatch) => dispatch.assignments);
  const runningOf = (state) => assignmentsOf(state).filter((assignment) => ["starting", "running", "settling"].includes(assignment.status));
  const appendRecord = (to, from, kind, content, label) => record({ kind: "message_appended", to, from,
    messageKind: kind, ...(kind === "relay" ? { relay: true } : {}), label: true, sourceLabel: label, chars: content.length });

  async function ask(state, request, signal) {
    if (config.planRouting === "fixed") return null;
    let reason;
    if (state.jevCalls >= (config.planMaxJevCalls ?? 6)) reason = "planMaxJevCalls exhausted";
    else if (!config.apiKey) reason = "no Jev API key";
    else if (state.jevUnavailable) reason = "Jev unavailable for this task";
    else if (Buffer.byteLength(JSON.stringify(request)) > STATE_BYTES) reason = "complete decision exceeds Jev state budget";
    if (reason) {
      record({ kind: "plan_fallback", session: state.agent.session.id, trigger: request.trigger, rule: "fixed", reason });
      return null;
    }
    try {
      state.jevCalls++;
      return await decide(state.agent, request, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      state.jevUnavailable = true;
      record({ kind: "plan_fallback", session: state.agent.session.id, trigger: request.trigger,
        rule: "fixed", reason: "Jev decision failed", error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  const dependencies = (dispatch, assignment) => (assignment.task.dependsOn ?? []).map((id) => dispatch.tasks.get(id));
  const eligible = (dispatch, assignment) => dispatch.queued && assignment.status === "pending" &&
    dependencies(dispatch, assignment).every((dep) => dep.status === "settled");

  function queue(state, assignments, reason) {
    if (!assignments.length) return;
    const id = state.agent.session.id;
    for (const assignment of assignments) {
      if (!assignment.child) {
        assignment.child = assignment.option.provider === "reuse" ? assignment.option.option.slice("sibling-reuse:".length) : randomUUID();
      }
    }
    if (state.ready) return;
    const content = dispatcherLabel + " Plan accepted.\n" + assignments.map((assignment) =>
      `- child ${assignment.child}: subtask ${assignment.task.id}; ${assignment.route.model}/${assignment.route.reasoningEffort ?? "default"}; ${assignment.option.option}`)
      .join("\n") +
      "\nContinue only your own subtasks. Do not edit files owned by running children. Child results arrive as messages from those children. " +
      'For each dependency owned by main, send JSON {"subtask":"id","summary":"actual result"} with send_message to the reserved dependent child id after completing it; this releases that dependency. ' +
      "Pending children start after their dependencies settle and a concurrency slot opens.";
    state.ready = true;
    state.agent.followup(note(content));
    record({ kind: "dispatch_queued", session: id, children: assignments.map((assignment) => assignment.child), reason });
    appendRecord(id, id, "dispatch", content, dispatcherLabel);
  }

  async function tool(input, exec) {
    const agent = exec.agent;
    if (!agent || agent.session.header.parentSession !== undefined) return errorResult("plan is available only to the root agent.");
    if (config.mode !== "plan") return errorResult("plan requires mode=plan.");
    const state = stateFor(agent);
    const problem = validatePlan(input, (config.planMaxChildren ?? 3) - state.used);
    if (problem) return errorResult(problem);
    if (state.accepting) return errorResult("Another plan is being recorded; wait for its result.");
    state.accepting = true;
    try {
      const cwd = agent.session.header.cwd;
      if (!cwd) throw new Error("Plan mode requires the root workspace directory.");
      for (const task of input.subtasks) assertWorkspaceFiles(task, cwd);
      const delegated = input.subtasks.filter((task) => task.owner === "delegate");
      if (!delegated.length) {
        state.planned = true;
        record({ kind: "plan_recorded", session: agent.session.id, turn: exec.turn, subtasks: input.subtasks.length,
          delegated: 0, kinds: input.subtasks.map((task) => task.kind) });
        const value = { recorded: true, assignments: [] };
        return { isError: false, value, content: [{ type: "text", text: JSON.stringify(value) }] };
      }
      const parent = currentRoute(agent), prefix = prefixOf(agent), brief = briefFor(agent);
      const requiredEnd = agent.session.snapshotEvents().at(-1)?.seq ?? -1;
      if (!state.prior) state.prior = structuredClone(await readLedger(cwd) ?? emptyRouteLedger());
      const tasks = new Map(input.subtasks.map((task) => [task.id, { task, status: "pending" }]));
      const assignments = delegated.map((task) => ({ task: structuredClone(task), route: { ...parent }, status: "pending",
        id: randomUUID(), parent: agent, baseline: new Map(), touched: new Set(), prefix, brief }));
      let routed = null;
      if (delegated.length && config.planRouting !== "fixed" && config.apiKey &&
          state.jevCalls < (config.planMaxJevCalls ?? 6) && !state.jevUnavailable) {
        const profiles = await profilesFor(agent, exec.signal);
        routed = await ask(state, { trigger: "plan_route", subtasks: delegated,
          questions: suitabilityQuestions(delegated, profiles, state.prior) }, exec.signal);
        if (routed)
          for (const [i, assignment] of assignments.entries()) {
            const selected = profiles[Number(routed.answers["route_" + i].choice.slice(1))];
            if (!selected) throw new Error("Invalid plan route choice.");
            assignment.route = { ...(sameModelEffort(selected.options, parent) ? parent : selected.options) };
          }
      } else if (delegated.length && config.planRouting !== "fixed")
        await ask(state, { trigger: "plan_route", questions: {} }, exec.signal);
      for (const assignment of assignments) record({ kind: "plan_route", session: agent.session.id,
        subtask: assignment.task.id, model: assignment.route.model, effort: assignment.route.reasoningEffort ?? null, jev: !!routed });
      const busy = new Set(runningOf(state).map((assignment) => assignment.child)), seen = new Set();
      const siblings = assignmentsOf(state).slice().reverse().filter((assignment) => {
        if (seen.has(assignment.child)) return false;
        seen.add(assignment.child);
        return assignment.status === "settled" && assignment.outcome?.stopReason === "completed" && !busy.has(assignment.child) &&
          (state.requests.get(assignment.child) ?? 0) < (config.planChildRequests ?? 16);
      })
        .map((assignment) => ({ child: assignment.child, route: assignment.route, status: assignment.status,
          prefixTokens: assignment.settledPrefix?.tokens ?? assignment.prefix.tokens, prefixEnd: assignment.prefix.end,
          latest: assignment.settledPrefix?.latest, at: assignment.settledAt }));
      for (const assignment of assignments) {
        const prompt = childPrompt({ session: agent.session.id, task: assignment.task, brief,
          dependencies: (assignment.task.dependsOn ?? []).map((id) => ({ id, status: "pending" })) });
        assignment.candidates = contextOptions({ route: assignment.route, parent, prefixTokens: prefix.tokens,
          prefixEnd: requiredEnd, briefTokens: tokensOf(prompt), siblings, now: Date.now(),
          ttlMs: (config.cacheTtlSeconds ?? 300) * 1000, needs: assignment.task.context });
      }
      const contextual = routed && await ask(state, { trigger: "plan_context",
        subtasks: assignments.map((assignment) => ({ id: assignment.task.id, context: assignment.task.context,
          model: assignment.route.model, effort: assignment.route.reasoningEffort, estimates: assignment.candidates })),
        questions: contextQuestions(assignments) }, exec.signal);
      for (const [i, assignment] of assignments.entries()) {
        if (!contextual) {
          assignment.route = { ...parent };
          assignment.candidates = contextOptions({ route: parent, parent, prefixTokens: prefix.tokens,
            prefixEnd: prefix.end, briefTokens: assignment.candidates[0].estBriefTokens, needs: assignment.task.context });
          if (routed) record({ kind: "plan_route", session: agent.session.id, subtask: assignment.task.id,
            model: parent.model, effort: parent.reasoningEffort ?? null, jev: false, fallback: true });
        }
        const option = contextual ? contextual.answers["context_" + i].choice : "parent-prefix";
        assignment.option = assignment.candidates.find((candidate) => candidate.option === option && candidate.carriesNeeded);
        if (!assignment.option) throw new Error("Invalid plan context choice for " + assignment.task.id);
        record({ kind: "plan_context", session: agent.session.id, subtask: assignment.task.id,
          option, estimates: assignment.candidates });
        tasks.set(assignment.task.id, assignment);
      }
      const dispatch = { turn: exec.turn, tasks, assignments, queued: false };
      state.dispatches.push(dispatch);
      state.used += assignments.length;
      state.planned = true;
      record({ kind: "plan_recorded", session: agent.session.id, turn: exec.turn, subtasks: input.subtasks.length,
        delegated: delegated.length, kinds: input.subtasks.map((task) => task.kind) });
      const value = { recorded: true, assignments: assignments.map(describe) };
      return { isError: false, value, content: [{ type: "text", text: JSON.stringify(value) }],
        ...(delegated.length ? { concludesTurn: true } : {}) };
    } catch (error) { return errorResult(error); }
    finally { state.accepting = false; }
  }

  function onEvent(session, event) {
    if (session.header.parentSession !== undefined || event.type !== "turn/end") return;
    const state = roots.get(session.id);
    if (!state) return;
    const pending = state.dispatches.filter((dispatch) => !dispatch.queued && dispatch.turn === event.data.turn);
    for (const dispatch of pending) dispatch.queued = true;
    const assignments = pending.flatMap((dispatch) => dispatch.assignments);
    queue(state, assignments, "completed-turn boundary");
  }

  async function beforeEdit(exec) {
    const assignment = children.get(exec.agent?.session.id);
    if (!assignment || !changesPlanFiles(exec.name, exec.arguments, changesFilesCall)) return;
    const cwd = exec.agent.session.header.cwd;
    for (const path of changedPaths(exec.name, exec.arguments)) {
      const local = workspacePath(cwd, path);
      if (!assignment.baseline.has(local)) assignment.baseline.set(local, await fileState(cwd, local));
    }
  }
  function onResult(exec, result) {
    const assignment = children.get(exec.agent?.session.id);
    if (!assignment || result.isError || !changesPlanFiles(exec.name, exec.arguments, changesFilesCall)) return;
    for (const path of changedPaths(exec.name, exec.arguments)) assignment.touched.add(workspacePath(exec.agent.session.header.cwd, path));
  }

  async function relay(state, finished, outcome) {
    const running = runningOf(state).filter((assignment) => assignment.child !== finished.child && assignment.status === "running");
    if (!running.length || config.planRouting === "fixed") return;
    const result = await ask(state, { trigger: "plan_mediation", from: finished.task.id,
      result: outcome.structured ?? outputText(outcome.output),
      siblings: running.map((assignment) => ({ subtask: assignment.task.id, goal: assignment.task.goal, context: assignment.task.context })),
      questions: Object.fromEntries(running.map((assignment, i) => ["relay_" + i, {
        type: "choice", instructions: "Does this settled result help this running sibling? Select none, summary, or verbatim. summary relays the child's own structured summary; do not invent findings.",
        criteria: { none: "No useful information to relay.", summary: "Relay the attributed structured summary.", verbatim: "Relay the full attributed child result." },
      }])),
    }, state.signal);
    if (!result) return;
    for (const [i, target] of running.entries()) {
      if (target.status !== "running") continue;
      const choice = result.answers["relay_" + i].choice;
      if (choice === "none") continue;
      const label = sourceLabel(finished.child, finished.route, finished.task.id);
      const body = choice === "summary" && outcome.structured ? outcome.structured.summary :
        outcome.structured ? JSON.stringify(outcome.structured) : outputText(outcome.output);
      const content = label + "\n" + body;
      try {
        await ctx.subagents.sendMessage(state.agent, target.child, [{ type: "text", text: content }], { signal: state.signal });
        appendRecord(target.child, finished.child, "relay", content, label);
      } catch (error) {
        record({ kind: "plan_relay_failed", to: target.child, from: finished.child, error: String(error) });
      }
    }
  }

  async function settle(state, assignment, outcome) {
    assignment.status = "settling";
    assignment.outcome = outcome;
    assignment.settledAt = Date.now();
    const at = graphFor(state.agent.session.id).sequence;
    const structured = outcome.structured;
    record({ kind: "child_settled", child: assignment.child, subtask: assignment.task.id, stopReason: outcome.stopReason,
      filesChanged: structured?.filesChanged?.length ?? assignment.touched.size,
      testsRun: structured?.testsRun?.length ?? Object.keys(graphFor(assignment.child).tests).length });
    record({ kind: "child_end", id: assignment.child, parent: state.agent.session.id,
      stopReason: outcome.stopReason, active: runningOf(state).length - 1 });
    const pending = assignmentsOf(state).filter((candidate) => candidate.status === "pending");
    if (pending.length) queue(state, pending, "dependency or concurrency slot settled");
    try {
      if (assignment.childAgent) assignment.settledPrefix = prefixOf(assignment.childAgent);
      const files = new Map(), cwd = state.agent.session.header.cwd;
      for (const path of assignment.touched) {
        const current = await fileState(cwd, path);
        if (assignment.baseline.has(path) && current !== assignment.baseline.get(path)) files.set(path, current);
      }
      const tests = Object.entries(graphFor(assignment.child).tests).filter(([, test]) =>
        test.runs.some((run) => run.via === undefined && run.event > assignment.startSequence)).map(([command]) => command);
      state.evidence.push({ id: assignment.id,
        key: routeKey(assignment.task.kind, assignment.route.model, assignment.route.reasoningEffort),
        stopReason: outcome.stopReason, files, tests, at });
    } catch (error) {
      record({ kind: "route_evidence_failed", child: assignment.child, error: String(error) });
    } finally {
      assignment.status = "settled";
    }
    await relay(state, assignment, outcome);
  }

  function collect(state, assignment, outcome) {
    outcome = { ...outcome, structured: outcome.structured ?? resultBlock(outputText(outcome.output)) };
    const pending = settle(state, assignment, outcome);
    state.settlements.add(pending);
    pending.catch((error) => record({ kind: "plan_settlement_failed", child: assignment.child, error: String(error) }))
      .finally(() => state.settlements.delete(pending));
    return pending;
  }

  async function startReady(state, signal) {
    state.signal = signal;
    await Promise.allSettled([...state.settlements]);
    state.ready = false;
    for (const dispatch of state.dispatches) {
      for (const assignment of dispatch.assignments) {
        if (runningOf(state).length >= (config.maxConcurrent ?? 2)) return;
        if (!eligible(dispatch, assignment)) continue;
        const reuse = assignment.option.provider === "reuse";
        if (reuse && runningOf(state).some((other) => other.child === assignment.child)) continue;
        const cwd = state.agent.session.header.cwd;
        if (runningOf(state).some((other) => (other.task.files ?? []).some((file) =>
          (assignment.task.files ?? []).some((path) => workspacePath(cwd, path) === workspacePath(cwd, file))))) continue;
        assignment.status = "starting";
        assignment.startSequence = graphFor(assignment.child).sequence;
        if (!reuse) assignment.prefix = prefixOf(state.agent);
        children.set(assignment.child, assignment);
        const deps = dependencies(dispatch, assignment).map((dep) => ({ id: dep.task.id, ...dep.outcome }));
        const content = childPrompt({ session: state.agent.session.id, task: assignment.task, brief: assignment.brief, dependencies: deps });
        try {
          if (reuse) {
            await ctx.subagents.sendMessage(state.agent, assignment.child, [{ type: "text", text: content }], { signal });
            if (assignment.status === "starting") assignment.status = "running";
          } else {
            const activation = await ctx.subagents.startActivation({ childId: assignment.child, provider: assignment.option.provider,
              label: "Plan " + assignment.task.id, signal, delivery: "parent", request: {
                parent: state.agent, prompt: [{ type: "text", text: content }], maxDepth: 1,
                ...(!sameModelEffort(assignment.route, currentRoute(state.agent)) ? {
                  agentOptions: { ...assignment.route, reasoningEffort: assignment.route.reasoningEffort },
                } : {}),
              } });
            assignment.activation = activation;
            assignment.status = "running";
            activation.result.then((outcome) => collect(state, assignment, outcome), (error) =>
              collect(state, assignment, { stopReason: "error", output: [{ type: "text", text: String(error) }] }))
              .catch(() => {});
          }
          appendRecord(assignment.child, state.agent.session.id, "brief", content, briefLabel(state.agent.session.id));
          record({ kind: "child_start", id: assignment.child, parent: state.agent.session.id,
            active: runningOf(state).length });
          const option = assignment.option;
          record({ kind: "child_assignment", session: state.agent.session.id, child: assignment.child,
            subtask: assignment.task.id, subtaskKind: assignment.task.kind, model: assignment.route.model,
            effort: assignment.route.reasoningEffort ?? null, provider: option.provider, contextOption: option.option,
            estPrefixTokens: option.estPrefixTokens, estCachedTokens: option.estCachedTokens,
            estBriefTokens: option.estBriefTokens, sameSpace: option.sameSpace });
        } catch (error) {
          await collect(state, assignment, { stopReason: "error", output: [{ type: "text", text: String(error) }] });
          record({ kind: "plan_start_failed", child: assignment.child, subtask: assignment.task.id, error: String(error) });
        }
      }
    }
  }

  function guard(exec) {
    if (!exec.agent) return exec.name === "plan" ? "plan requires a root agent." : undefined;
    const child = exec.agent.session.header.parentSession !== undefined;
    const state = stateFor(child ? ctx.agents.get(exec.agent.session.header.parentSession) : exec.agent);
    const assignment = children.get(exec.agent.session.id);
    const owners = runningOf(state).map((assignment) => ({ child: assignment.child, files: assignment.task.files ?? [] }));
    return planGuard({ name: exec.name, args: exec.arguments, child, planned: state.planned,
      files: assignment?.task.files, owners, cwd: exec.agent.session.header.cwd,
      changesFiles: changesPlanFiles(exec.name, exec.arguments, changesFilesCall) });
  }

  async function settleLearning(agent) {
    const state = roots.get(agent.session.id);
    if (!state) return;
    await Promise.allSettled([...state.settlements]);
    if (assignmentsOf(state).some((assignment) => assignment.status !== "settled")) return;
    if (!state.evidence.length) return;
    const apply = async () => {
      const changed = new Set(await diffFiles(agent.session.header.cwd));
      for (const entry of state.evidence) {
        const currentFiles = new Map();
        for (const path of entry.files.keys()) currentFiles.set(path, await fileState(agent.session.header.cwd, path));
        const facts = verifiedRouteFacts(entry, { currentFiles, diffFiles: changed, rootGraph: graphFor(agent.session.id) });
        const result = await learn(agent.session.header.cwd, entry.key, facts, config.learning ?? "frozen");
        record({ kind: "route_learning", key: entry.key, applied: result.applied, facts: result.facts });
      }
    };
    state.learning = state.learning.catch(() => {}).then(apply);
    await state.learning;
  }

  return { tool, onEvent, guard, beforeEdit, onResult, startReady: (agent, signal) => startReady(stateFor(agent), signal),
    settleLearning, stateFor, children,
    jevCalls(id) { return roots.get(id)?.jevCalls ?? 0; },
    childRequests(id) { const child = children.get(id); return child ? stateFor(child.parent).requests.get(id) ?? 0 : 0; },
    countRequest(id) { const child = children.get(id); if (child) {
      const state = stateFor(child.parent); state.requests.set(id, (state.requests.get(id) ?? 0) + 1);
    } },
    onChildStart(info) {
      const assignment = children.get(info.id);
      if (assignment) assignment.childAgent = ctx.agents.get(info.id);
    },
    onChildEnd(info) {
      const assignment = children.get(info.id);
      if (!assignment || assignment.option.provider !== "reuse" || !["starting", "running"].includes(assignment.status)) return;
      return collect(stateFor(assignment.parent), assignment, { stopReason: info.stopReason, output: info.lastAssistantMessage }).catch(() => {});
    },
    async mainDependency(exec) {
      const state = roots.get(exec.agent.session.id);
      if (!state || exec.name !== "send_message") return;
      const dispatch = state.dispatches.find((dispatch) => dispatch.assignments.some((assignment) =>
        assignment.child === exec.arguments.agent_id && assignment.status === "pending"));
      if (!dispatch) return;
      const assignment = dispatch.assignments.find((assignment) => assignment.child === exec.arguments.agent_id);
      const main = dependencies(dispatch, assignment).filter((dep) => dep.task.owner === "main" && dep.status !== "settled");
      if (!main.length) return;
      if (typeof exec.arguments.message !== "string" || !exec.arguments.message.trim()) return errorResult("A main dependency needs its actual result.");
      let report;
      try { report = JSON.parse(exec.arguments.message); } catch {}
      const dep = report?.subtask ? main.find((dep) => dep.task.id === report.subtask) : main.length === 1 ? main[0] : undefined;
      const summary = report?.subtask ? report.summary : exec.arguments.message;
      if (!dep || typeof summary !== "string" || !summary.trim())
        return errorResult("Name one unfinished main dependency using JSON {subtask,summary} with its actual result.");
      dep.status = "settled";
      dep.outcome = { summary, source: "main", reported: true };
      if (!eligible(dispatch, assignment)) return errorResult("Main dependency result recorded; other dependencies are still pending. No message was delivered.");
      await startReady(state, exec.signal);
      if (assignment.status !== "running") return errorResult("Main dependency result recorded; child is waiting for a concurrency slot. No message was delivered.");
    },
  };
}
