import { resolve, relative, isAbsolute } from "node:path";
import { costUSD } from "./models.js";
import { switchEstimate } from "./cachespace.js";
import { routeKey, routePrior } from "./routeledger.js";
import { shellWritePaths } from "./graph.js";

export const PLAN_KINDS = ["locate", "implement", "test", "verify", "other"];
const strings = { type: "array", items: { type: "string", minLength: 1 } };
export const planParameters = {
  type: "object", additionalProperties: false, required: ["subtasks"], properties: {
    subtasks: { type: "array", minItems: 1, items: {
      type: "object", additionalProperties: false,
      required: ["id", "kind", "goal", "owner", "acceptance", "context"],
      properties: {
        id: { type: "string", minLength: 1 }, kind: { type: "string", enum: PLAN_KINDS },
        goal: { type: "string", minLength: 1 }, owner: { type: "string", enum: ["main", "delegate"] },
        files: strings, dependsOn: strings, acceptance: { type: "string", minLength: 1 }, context: strings,
      },
    } },
  },
};
export function resultBlock(text) {
  const blocks = [...String(text ?? "").matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (!blocks.length) return undefined;
  try {
    const value = JSON.parse(blocks.at(-1)[1]);
    const list = (items) => Array.isArray(items) ? items : [];
    if (!value || typeof value !== "object" || typeof value.summary !== "string") return undefined;
    return { summary: value.summary, filesChanged: list(value.filesChanged).filter((item) => typeof item === "string"),
      testsRun: list(value.testsRun).filter((run) => run && typeof run.command === "string" &&
        ["pass", "fail", "error"].includes(run.outcome)).map(({ command, outcome }) => ({ command, outcome })),
      openIssues: list(value.openIssues).filter((item) => typeof item === "string") };
  } catch {
    return undefined;
  }
}
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const stringList = (value) => Array.isArray(value) && value.every(nonempty);

export function validatePlan(input, remaining, minDelegated = 0) {
  if (!input || !Array.isArray(input.subtasks) || !input.subtasks.length) return "A plan needs at least one subtask.";
  const ids = new Map();
  for (const task of input.subtasks) {
    if (!task || !nonempty(task.id) || /[\r\n]/.test(task.id) || !PLAN_KINDS.includes(task.kind) || !["main", "delegate"].includes(task.owner) ||
        !nonempty(task.goal) || !nonempty(task.acceptance) || !stringList(task.context))
      return "Each subtask needs id, kind, goal, owner, acceptance and a context array.";
    if (ids.has(task.id)) return "Duplicate subtask id: " + task.id;
    if (task.files !== undefined && !stringList(task.files)) return "Invalid files for " + task.id;
    if (task.dependsOn !== undefined && !stringList(task.dependsOn)) return "Invalid dependencies for " + task.id;
    ids.set(task.id, task);
  }
  if (input.subtasks.filter((task) => task.owner === "delegate").length < minDelegated)
    return "This run requires at least " + minDelegated + " delegated subtask(s) (owner \"delegate\") in the plan.";
  if (input.subtasks.filter((task) => task.owner === "delegate").length > remaining)
    return "Plan exceeds the remaining planMaxChildren budget (" + remaining + ").";
  for (const task of ids.values())
    for (const dep of task.dependsOn ?? [])
      if (!ids.has(dep)) return "Unknown dependency " + dep + " for " + task.id;
  const visiting = new Set(), done = new Set();
  function cycle(id) {
    if (visiting.has(id)) return true;
    if (done.has(id)) return false;
    visiting.add(id);
    if ((ids.get(id).dependsOn ?? []).some(cycle)) return true;
    visiting.delete(id);
    done.add(id);
    return false;
  }
  if ([...ids.keys()].some(cycle)) return "Plan dependencies contain a cycle.";
  return null;
}

export const sameModelEffort = (a, b) => a.model === b.model && a.reasoningEffort === b.reasoningEffort;
export const sameRoute = (a, b) => a.provider === b.provider && sameModelEffort(a, b);
export const sourceLabel = (child, route, subtask) =>
  `[from child ${child} · ${route.model}/${route.reasoningEffort ?? "default"} · subtask ${subtask} · via dsh-autoctx]`;
export const dispatcherLabel = "[dsh-autoctx dispatcher]";
export const briefLabel = (session) => `[from parent ${session} · brief · via dsh-autoctx]`;
export const canonicalPath = (cwd, path) => resolve(cwd, path);
export const workspacePath = (cwd, path) => relative(cwd, resolve(cwd, path)).replaceAll("\\", "/");

export function changedPaths(name, args = {}) {
  if (!args || typeof args !== "object") args = {};
  if (name === "bash") return typeof args.command === "string" ? shellWritePaths(args.command).filter((path) => !path.startsWith("(")) : [];
  const paths = new Set();
  function collect(value) {
    if (Array.isArray(value)) return value.forEach(collect);
    if (!value || typeof value !== "object") return;
    for (const key of ["file_path", "path", "target_file"])
      if (nonempty(value[key])) paths.add(value[key]);
    for (const valuePart of Object.values(value)) if (valuePart && typeof valuePart === "object") collect(valuePart);
  }
  collect(args);
  if (name === "apply_patch")
    for (const patch of [args.patch, args.input, args.diff, args.command].filter((value) => typeof value === "string"))
      for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) paths.add(match[1]);
  return [...paths];
}

export const changesPlanFiles = (name, args, changesFilesCall) => changesFilesCall(name, args) ||
  (name === "bash" && typeof args?.command === "string" && shellWritePaths(args.command).length > 0);

export function planGuard({ name, args, child, planned, files = [], owners = [], cwd, changesFiles }) {
  if (child && ["plan", "subagent", "subagent_fork"].includes(name)) return "Plan children cannot plan or delegate.";
  if (!child && ["subagent", "subagent_fork"].includes(name)) return "Use plan to dispatch subtasks in plan mode.";
  if (!changesFiles) return;
  if (!child && !planned) return "Call plan before the first file-changing tool call. Read-only tools may run first.";
  const paths = changedPaths(name, args);
  if (child && files.length) {
    if (!paths.length) return "Cannot identify this edit's paths; use a file tool with explicit paths in the assigned files.";
    const allowed = new Set(files.map((path) => canonicalPath(cwd, path)));
    const outside = paths.find((path) => !allowed.has(canonicalPath(cwd, path)));
    if (outside) return "File is outside this subtask's scope: " + outside;
  }
  if (!child && owners.length) {
    if (!paths.length) return "Use explicit file paths while children own files: " + owners.map((owner) => owner.child).join(", ");
    for (const path of paths) {
      const owner = owners.find((owner) => owner.files.some((file) => canonicalPath(cwd, file) === canonicalPath(cwd, path)));
      if (owner) return "File " + path + " is owned by running child " + owner.child + ".";
    }
  }
}

export function contextOptions({ route, parent, prefixTokens, briefTokens, siblings = [], now, ttlMs, needs, prefixEnd }) {
  const sameSpace = sameRoute(route, parent);
  const estimate = (cached, fresh) => {
    const usd = costUSD(route.model, { inputTokens: fresh, cacheReadTokens: cached, outputTokens: 0 });
    return { estPrefixTokens: prefixTokens, estCachedTokens: cached, estBriefTokens: briefTokens,
      uncachedTokens: fresh, ...(usd === undefined ? { priceAvailable: false } : { usd, priceAvailable: true }) };
  };
  const parentCached = sameSpace ? prefixTokens : 0;
  const options = [{ option: "parent-prefix", provider: "fork", sameSpace, carriesNeeded: true,
    ...estimate(parentCached, prefixTokens - parentCached + briefTokens),
    cache: sameSpace ? "same model/provider/effort cache space; estimated prefix reuse" : "different cache space: entire prefix re-read uncached on first request" }];
  for (const sibling of siblings.filter((sibling) => sameRoute(sibling.route, route) && sibling.status === "settled")) {
    const reused = sibling.latest ? switchEstimate({ latest: sibling.latest, target: sibling.latest, at: sibling.at,
      now, ttlMs, pendingTokens: briefTokens, price: { input: 1, cacheRead: 0 } }).reusableTokens :
      now - sibling.at <= ttlMs ? sibling.prefixTokens : 0;
    const cached = Math.min(sibling.prefixTokens, reused);
    options.push({ option: "sibling-reuse:" + sibling.child, provider: "reuse", sameSpace: true,
      carriesNeeded: !needs.includes("parent-history") || sibling.prefixEnd >= prefixEnd,
      ...estimate(cached, sibling.prefixTokens - cached + briefTokens), estPrefixTokens: sibling.prefixTokens,
      cache: "sibling's own prefix is reusable; appended brief is new" });
  }
  options.push({ option: "brief", provider: "spawn", sameSpace: false,
    carriesNeeded: !needs.includes("parent-history"), ...estimate(0, briefTokens), estPrefixTokens: 0,
    cache: "fresh attributed brief; all tokens new; file/test references can be read with tools" });
  return options;
}

export function suitabilityQuestions(subtasks, profiles, prior) {
  return Object.fromEntries(subtasks.map((task, i) => ["route_" + i, {
    type: "choice", instructions: "Choose for task suitability; do not consider caching. Use the subtask kind, goal, acceptance and frozen routing prior. When suitability is comparable, prefer preferredRoute=true; other listed routes are valid when clearly more suitable.",
    criteria: Object.fromEntries(profiles.map((profile, j) => ["p" + j, JSON.stringify({
      model: profile.options.model, effort: profile.options.reasoningEffort ?? "default", capability: profile.capability,
      knowledge: profile.knowledge, ...(profile.route === undefined ? {} : { route: profile.route, preferredRoute: !!profile.preferredRoute }), prior: routePrior(prior, routeKey(task.kind, profile.options.model, profile.options.reasoningEffort)),
    })])),
  }]));
}

export function contextQuestions(assignments) {
  return Object.fromEntries(assignments.map((assignment, i) => ["context_" + i, {
    type: "choice", instructions: "Choose a context carrying the subtask's needed information, using token/cost estimates. Never choose carriesNeeded=false. Different model or effort re-reads the whole parent prefix uncached.",
    criteria: Object.fromEntries(assignment.candidates.filter((candidate) => candidate.carriesNeeded)
      .map((candidate) => [candidate.option, JSON.stringify(candidate)])),
  }]));
}

export function childPrompt({ session, task, brief, dependencies }) {
  return briefLabel(session) + "\n" +
    "You are a delegated plan child. Complete only this subtask, obey the user's constraints, share the workspace, and do not revert others' edits. Do not delegate.\n" +
    JSON.stringify({ id: task.id, kind: task.kind, goal: task.goal, acceptance: task.acceptance,
      files: task.files ?? [], context: task.context, dependsOn: dependencies }) +
    "\nRoot request and observed evidence (attributed background):\n" + brief +
    "\nEnd your closing message with one ```json block {\"summary\": string, \"filesChanged\": [path], \"testsRun\": [{\"command\": string, \"outcome\": \"pass\"|\"fail\"|\"error\"}], \"openIssues\": [string]}. Do not claim unperformed work.";
}

export function assertWorkspaceFiles(task, cwd) {
  for (const path of task.files ?? []) {
    const local = relative(cwd, resolve(cwd, path));
    if (!local || local === ".." || local.startsWith(".." + "/") || isAbsolute(local))
      throw new Error("Subtask file must be inside the workspace: " + path);
  }
}
