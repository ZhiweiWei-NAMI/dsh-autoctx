export const AUTOCTX_FORK = "autoctx-fork";

// Only a closed step in the currently open turn qualifies. In particular, none
// of the assistant/tool events in the delegating step may enter the seed.
export function closedStepSeed(events) {
  const turn = events.findLast((event) => event.type === "turn/start" || event.type === "turn/end");
  if (turn?.type !== "turn/start") return undefined;
  const boundary = events.findLast((event) => event.type === "step/end" &&
    event.seq > turn.seq && event.data.turn === turn.data.turn);
  if (!boundary) return undefined;
  // Equivalent to dsh-session buildForkSeed at a closed step: no tool results
  // or step endings need repair. Both added events are model-invisible in
  // dsh-session's surface/deriveEventMessage. Keep every source event unchanged;
  // the host Session constructor validates JSON, contiguity and surface data.
  // This preserves the seed projection; the host still owns later request-time
  // system/tool assembly, including model-dependent prompt reconciliation.
  return [...events.slice(0, boundary.seq + 1),
    { type: "session/end-seed", seq: boundary.seq + 1, time: boundary.time, data: { inherited: true } },
    { type: "turn/end", seq: boundary.seq + 2, time: boundary.time,
      data: { turn: turn.data.turn, reason: { kind: "forked" } } },
  ];
}

export function createClosedStepForkProvider(subagents, onPrepared = () => {}) {
  const native = () => {
    const provider = subagents.getProvider("fork");
    if (typeof provider?.prepareContinuable !== "function")
      throw new Error("AutoCTX delegation requires the native in-process fork provider.");
    return provider;
  };
  return {
    name: AUTOCTX_FORK,
    get capabilities() { return native().capabilities; },
    get inheritsParentContext() { return native().inheritsParentContext; },
    async prepareContinuable(request) {
      const provider = native();
      const seed = closedStepSeed(request.parent.session.snapshotEvents());
      // Everything beyond seed selection (route merging, presets, validation,
      // initial inbox acceptance, continuation and disposal) remains host-owned.
      const prepared = seed ? { seed } : await provider.prepareContinuable(request);
      onPrepared(request, { seeded: prepared.seed !== undefined, seedEvents: prepared.seed?.length ?? 0,
        seedBoundary: seed ? "closed-step" : prepared.seed?.length ? "completed-turn" : "empty" });
      return prepared;
    },
  };
}

export const requestConfig = (agent) => agent.session.requestHeader?.()?.config ?? agent.options;
export const sameRequestConfig = (left, right) => ["provider", "model", "reasoningEffort"]
  .every((key) => left?.[key] === right?.[key]);

// Native children and reused plan children report their actual inherited log.
// Routed starts use the facts captured by prepareContinuable instead.
export function childSeedFacts(child) {
  const seeded = child.session.header.isSeeded;
  const seedEvents = child.session.inheritedEventCount;
  const end = seeded && child.session.snapshotEvents().slice(0, seedEvents)
    .findLast((event) => event.type === "turn/end");
  return { seeded, seedEvents,
    seedBoundary: seedEvents === 0 ? "empty" : seeded === true
      ? end?.data.reason?.kind === "forked" ? "closed-step" : "completed-turn" : undefined };
}
