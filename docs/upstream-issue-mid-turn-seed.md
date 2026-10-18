# Draft issue (not filed): closed-step fork seeds for continuable subagents

**Target:** dsh 0.2.1 — `@deepseek-ai/dsh-subagent`, `@deepseek-ai/dsh-subagent-fork-in-process`
**Status:** draft text only; no PR.

## Problem

A fork child can inherit the parent's history only through the last completed turn:

- `ContinuableCreateSpec.seed` is documented as a "Completed-turn prefix of the parent's log … contiguous from seq 0,
  lossless JSON, balanced" (`dsh-subagent/lib/types/types.d.ts`).
- `completedTurnPrefix(parent)` in `dsh-subagent-fork-in-process` slices through the last `turn/end`.

A delegation issued during the first turn of a single-prompt task (the common headless case) therefore starts with
an empty seed. The child cannot share the parent's prompt prefix, even when it runs on the same model and effort with
the same system prompt and tools. In a 72-case benchmark of a delegating plugin, all 51 same-turn review children
started unseeded (`historySeeded: false`).

Workaround in use: end the parent turn, queue a parent follow-up, and start children in the next turn. This works
but costs an extra parent turn and serializes planning and dispatch.

## Existing pieces

The host already supports exact-boundary forks for ordinary sessions:

- `buildForkSeed(events, boundary)` (`dsh-session/lib/types/fork.js`) copies an inclusive prefix, appends
  `session/end-seed`, and closes an open tail with `forked`-cause closers.
- `SessionCommandController.fork` passes `inheritedEventCount: boundary + 1`.
- The subagent manager sets `inheritedEventCount = prepared.seed.length`
  (`dsh-subagent/lib/index.js`, `startLocal`).

So a provider that returned `buildForkSeed` output would have its synthetic closers counted as inherited, and the
provider contract does not allow that seed shape anyway.

## Proposed minimal change

1. `ContinuableCreateSpec` gains optional `inheritedEventCount`. When present, `startLocal` uses it instead of
   `seed.length`. It must be at most `seed.length`, and events after it must be the `end-seed` marker plus
   `forked` closers.
2. The fork provider gains a config option `cut: "completed-turn" | "closed-step"`, default `"completed-turn"`
   (unchanged behavior). For `"closed-step"`, the boundary is the last `step/end` of the in-flight turn. The step
   carrying the delegating tool call is still open and stays excluded. Every tool call before the boundary has its
   result, so `buildForkSeed` adds only `session/end-seed` and a `forked` `turn/end`, with no synthetic error tool
   results. If the current turn has no closed step, fall back to the completed-turn prefix.
3. Contract docs: "balanced" may include `forked` closers outside the inherited count, matching the session fork
   documentation.

## Questions for maintainers

- Are `session/end-seed` and a `forked` `turn/end` model-invisible in the child's request projection? If not, which
  projection rule should apply?
- Ordering with delegated policy capture: "fresh policy wins stale seed state" should hold unchanged.
- Cold resume of a closed-step child: the inherited count must persist, as it does for session forks.

## Tests suggested

- Seed validation for a closed-step cut (balanced, contiguous, inherited count, no synthetic tool results).
- Child request prefix equals the parent's request prefix through the boundary (same model, effort and tools).
- Fallback to the completed-turn prefix when the in-flight turn has no closed step.
- Cold resume and disposal of a closed-step child.
