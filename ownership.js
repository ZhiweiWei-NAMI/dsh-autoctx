import { resolve } from "node:path";
import { shellWritePaths } from "./graph.js";
import { messageAppended } from "./routing.js";

export const OWNERSHIP_LABEL = "AutoCTX ownership";
// Continuable activations in DSH are not jobs. send_message accepts input,
// not a wait request; the runtime delivers agent-message/subagent-settled inbox
// messages and the headless runner joins children with waitForChildren after
// the parent yields. Never keep the parent alive by repeatedly steering it.
export const NATIVE_COLLECTION = "Collect the child's send_message reply or native subagent-settled inbox notice before integrating; if needed, request its result with send_message({agent_id: CHILD_ID, message: 'Report your result when ready'}) and yield the turn so the runtime can wait for children and resume you on delivery.";

export function ownershipContract(child, description) {
  return `Child ${child} now owns this subtask (${description}); you may continue disjoint work but must not redo its assigned work. ` +
    NATIVE_COLLECTION.replace("CHILD_ID", JSON.stringify(child));
}

export function appendOwnershipResult(result, notes) {
  return notes.length ? { ...result, content: [...(result.content ?? []), ...notes.map((text) => ({ type: "text", text }))] } : result;
}

const investigation = /\b(?:investigat\w*|inspect\w*|analy[sz]\w*|diagnos\w*|trac\w*|review\w*|examin\w*|research\w*|locat\w*|read|find|understand)\b/i;
// Deliberately lexical: explicit file/directory tokens only, no inferred module
// names, semantic similarity, globs, URLs or filesystem traversal. An overlap
// requires an investigation verb in the same sentence as the named path.
function assignmentPaths(assignment, cwd) {
  const paths = new Map();
  for (const sentence of assignment.split(/\n|;|[.!?](?=\s|$)/)) {
    for (const match of sentence.matchAll(/(?:^|[\s`'"(])((?:\.?\.?\/|\/)?[\w.-]+(?:\/[\w.-]+)*\/?)(?=$|[\s`'"),:])/g)) {
      const raw = match[1];
      if ((!raw.includes("/") && !/\w\.\w/.test(raw)) || /[*?]|^https?:/.test(raw)) continue;
      const path = resolve(cwd, raw);
      paths.set(path, (paths.get(path) ?? false) || investigation.test(sentence));
    }
  }
  return paths;
}

const reads = new Set(["read", "grep", "glob"]);
const writes = new Set(["edit", "write", "multi_edit", "apply_patch"]);
// Inspect only path arguments, patch headers and simple shell operands. Never
// match strings inside file contents, replacement text or arbitrary scripts.
export function ownershipToolPaths(tool, args = {}, cwd = ".") {
  const paths = new Set();
  const add = (path) => { if (typeof path === "string" && path && path !== "(shell-target)") paths.add(resolve(cwd, path)); };
  const editing = writes.has(tool) || (tool === "str_replace_editor" && ["create", "str_replace", "insert"].includes(args.command));
  if (reads.has(tool) || writes.has(tool) || tool === "str_replace_editor") {
    const collect = (value) => {
      if (Array.isArray(value)) return value.forEach(collect);
      if (!value || typeof value !== "object") return;
      add(value.file_path ?? value.path);
      if (Array.isArray(value.edits)) collect(value.edits);
    };
    collect(args);
    if (tool === "apply_patch") for (const match of String(args.patch ?? args.input ?? "").matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) add(match[1]);
  } else if (tool === "bash" && typeof args.command === "string") {
    const changed = shellWritePaths(args.command);
    changed.forEach(add);
    // No shell expansion, compound commands, pipelines or quoted scripts.
    if (!/[\n;&|<>$`]/.test(args.command) && /^\s*(?:cat|sed|head|tail|rg|grep|nl|less|more)\s/.test(args.command)) {
      const [head, ...tokens] = (args.command.match(/'[^']*'|"[^"]*"|\S+/g) ?? [])
        .map((token) => token.replace(/^(['"])(.*)\1$/, "$2"));
      const operands = [];
      let supported = true;
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (/^-[nc]$/.test(token) && ["head", "tail"].includes(head)) { index++; continue; }
        if (token.startsWith("-")) {
          if (!/^-[nEriIHvlwscq]+$/.test(token)) supported = false;
        } else operands.push(token);
      }
      // sed's script and grep/rg's pattern are not inspected repository paths.
      if (["sed", "grep", "rg"].includes(head)) operands.shift();
      if (supported) operands.forEach(add);
    }
    return { paths, editing: changed.length > 0 };
  }
  return { paths, editing };
}

export function createOwnershipTracker(record, now = () => new Date().toISOString()) {
  const entries = new Map();
  const overlaps = new Map();
  const hasResult = (entry) => entry.deliveries.length > entry.deliveryStart;
  const state = (entry) => entry.running ? "running" : entry.deliveries.some((item) => !item.consumed)
    ? "delivered" : hasResult(entry) ? "consumed" : "awaiting-delivery";
  const outstanding = (entry) => entry.running || !hasResult(entry) || entry.deliveries.some((item) => !item.consumed);
  const append = (parent, child, kind, content) => {
    const labelled = `[${OWNERSHIP_LABEL}] ${content}`;
    record(messageAppended(parent, child, kind, OWNERSHIP_LABEL, labelled));
    return labelled;
  };
  const deliver = (parent, child, message, via) => {
    const entry = entries.get(child);
    if (!entry || entry.parent !== parent || entry.deliveries.some((item) => message.id !== undefined
      ? item.id === message.id : item.message === message)) return;
    entry.deliveries.push({ id: message.id, message, consumed: false });
    entry.state = state(entry);
    record({ kind: "child_result_delivered", parent, child, at: now(), via });
  };
  const observeMessage = (parent, message) => {
    const source = message.source;
    if (source?.kind === "agent-message" || source?.kind === "subagent-settled")
      deliver(parent, source.senderSessionId, message, source.kind === "agent-message" ? "send_message" : "settlement-inbox");
  };
  const takeDependencies = (parent, paths) => {
    const due = [...entries.values()].filter((entry) => entry.parent === parent && outstanding(entry) && !entry.reminded &&
      (paths === undefined || [...paths].some((path) => entry.paths.has(path))));
    for (const entry of due) entry.reminded = true;
    return due;
  };
  const describe = (due) => due.map((entry) => `${entry.child} (${entry.description}; ${entry.running ? "running" : entry.state})`).join(", ");
  return {
    entries,
    // Reserve before asynchronous acceptance so a fast child cannot deliver
    // before its ownership exists. Publish only after acceptance; undo failures.
    reserve({ child, parent, description, assignment, cwd = "." }) {
      const previous = entries.get(child);
      const deliveries = [...(previous?.deliveries ?? [])];
      const entry = { child, parent, description, assignment, startedAt: now(), state: "starting",
        running: true, deliveries, deliveryStart: deliveries.length, paths: assignmentPaths(assignment, cwd), reminded: false };
      entries.set(child, entry);
      return {
        accept() {
          entry.state = state(entry);
          record({ kind: "ownership_assigned", parent, child, description });
        },
        cancel() { if (entries.get(child) === entry) previous ? entries.set(child, previous) : entries.delete(child); },
      };
    },
    end(child) {
      const entry = entries.get(child);
      if (entry) { entry.running = false; entry.state = state(entry); }
    },
    onEvent(session, event) {
      if (event.type === "agent/inbox/spliced") for (const message of event.data.inserted) observeMessage(session.id, message);
      if (event.type === "user/message") observeMessage(session.id, event.data);
    },
    // The actual model boundary, not pre-step admission or inbox claiming.
    // Identity matching prevents rejected admissions/compaction calls from
    // falsely claiming that the parent has seen a delivered result.
    onRequest(parent, messages) {
      for (const entry of entries.values()) {
        if (entry.parent !== parent) continue;
        for (const delivery of entry.deliveries) {
          if (delivery.consumed || !messages.some((message) => delivery.id !== undefined
            ? message.id === delivery.id : message === delivery.message)) continue;
          delivery.consumed = true;
          record({ kind: "child_result_consumed", parent, child: entry.child, at: now(), parentRequestAfter: true });
        }
        entry.state = state(entry);
      }
    },
    // One reminder per assignment, shared by finish and integration. A second
    // final answer must be allowed to yield to native waitForChildren.
    dependencyNote(parent, paths) {
      const due = takeDependencies(parent, paths);
      if (!due.length) return undefined;
      return append(parent, due[0].child, "ownership-dependency", "Outstanding child results: " +
        describe(due) +
        ". Continue disjoint work until these dependencies are collected. " + NATIVE_COLLECTION.replace("CHILD_ID", JSON.stringify(due[0].child)));
    },
    toolSnapshot(parent, tool, args, cwd) {
      const { paths, editing } = ownershipToolPaths(tool, args, cwd);
      return { paths, editing, investigating: [...entries.values()].filter((entry) =>
        entry.parent === parent && entry.running && !hasResult(entry)) };
    },
    toolNotes(parent, tool, args, cwd, snapshot = this.toolSnapshot(parent, tool, args, cwd)) {
      const { paths, editing, investigating } = snapshot;
      const overlapsFound = [];
      for (const entry of investigating) {
        for (const path of paths) {
          if (entry.paths.get(path) !== true || overlaps.get(entry.child)?.has(path)) continue;
          if (!overlaps.has(entry.child)) overlaps.set(entry.child, new Set());
          overlaps.get(entry.child).add(path);
          record({ kind: "ownership_overlap", parent, child: entry.child, tool, path });
          overlapsFound.push({ child: entry.child, path });
        }
      }
      const due = editing ? takeDependencies(parent, paths) : [];
      if (!overlapsFound.length && !due.length) return [];
      const content = overlapsFound.length
        ? overlapsFound.map(({ child, path }) => `Child ${child} owns investigation of ${path}.`).join(" ") +
          (due.length ? " Outstanding results: " + describe(due) + "." : "") +
          " Continue disjoint work or yield for its native send_message reply/subagent-settled inbox result before integrating."
        : "Outstanding child results: " + describe(due) + ". " + NATIVE_COLLECTION.replace("CHILD_ID", JSON.stringify(due[0].child));
      return [append(parent, overlapsFound[0]?.child ?? due[0].child,
        overlapsFound.length ? "ownership-overlap" : "ownership-dependency", content)];
    },
  };
}
