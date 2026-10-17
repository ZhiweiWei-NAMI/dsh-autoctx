export function createGraph() {
  return { files: {}, searches: [], tests: {}, commands: [], steps: 0, sequence: 0, imported: {} };
}

const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const items = (value) => Array.isArray(value) ? value : [];
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const put = (object, key, value) => Object.defineProperty(object, key, {
  value, enumerable: true, writable: true, configurable: true,
});
const provenance = (via) => typeof via === "string" ? { via } : {};
const end = (read) => read.to === null ? Infinity : read.to;

function trimKeys(object, limit) {
  for (const key of Object.keys(object).slice(0, -limit)) delete object[key];
}

function fileFor(graph, path) {
  let file = own(graph.files, path);
  if (!file) {
    file = { reads: [], edits: [], editSnippets: [] };
    put(graph.files, path, file);
    trimKeys(graph.files, 200);
  }
  return file;
}

function subtract(ranges, coverage) {
  for (const [start, stop] of coverage) {
    ranges = ranges.flatMap(([from, to]) => {
      if (stop < from || start > to) return [[from, to]];
      const rest = [];
      if (from < start) rest.push([from, start - 1]);
      if (to > stop) rest.push([stop + 1, to]);
      return rest;
    });
  }
  return ranges;
}

// Negative bounds describe positions from EOF, so tail never implies whole-file coverage.
function addRead(graph, path, read) {
  const file = fileFor(graph, path);
  let incoming = [[read.from, end(read)]];
  const retained = [];
  for (const previous of file.reads) {
    if (previous.via !== read.via) {
      retained.push(previous);
    } else if (previous.step > read.step) {
      incoming = subtract(incoming, [[previous.from, end(previous)]]);
      retained.push(previous);
    } else {
      for (const [from, to] of subtract([[previous.from, end(previous)]], [[read.from, end(read)]]))
        retained.push({ ...previous, from, to: to === Infinity ? null : to });
    }
  }
  for (const [from, to] of incoming)
    retained.push({ ...read, from, to: to === Infinity ? null : to });
  retained.sort((a, b) => byString(a.via ?? "", b.via ?? "") || a.from - b.from);
  file.reads = [];
  for (const entry of retained) {
    const last = file.reads.at(-1);
    if (last && last.via === entry.via && last.event === entry.event && entry.from <= end(last) + 1)
      last.to = Math.max(end(last), end(entry)) === Infinity ? null : Math.max(end(last), end(entry));
    else file.reads.push(entry);
  }
}

function addEdit(graph, path, edit, snippet) {
  const file = fileFor(graph, path);
  if (file.edits.some((entry) => entry.via === edit.via && entry.event === edit.event)) return;
  file.edits.push(edit);
  file.editSnippets = typeof snippet === "string" && snippet.trim() ? [snippet.slice(0, 300)] : [];
}

function addSearch(graph, pattern, path, observation) {
  let search = graph.searches.find((entry) => entry.pattern === pattern && entry.path === path);
  if (!search) {
    search = { pattern, path, step: observation.step, observations: [] };
    graph.searches.push(search);
  }
  const previous = search.observations.find((entry) => entry.via === observation.via);
  if (previous && observation.event > previous.event) Object.assign(previous, observation);
  else if (!previous) search.observations.push(observation);
  search.step = Math.max(search.step, observation.step);
  if (graph.searches.length > 50) {
    const oldest = graph.searches.reduce((a, b) => a.step <= b.step ? a : b);
    graph.searches.splice(graph.searches.indexOf(oldest), 1);
  }
}

function addTest(graph, key, run) {
  let test = own(graph.tests, key);
  if (!test) {
    test = { runs: [] };
    put(graph.tests, key, test);
    trimKeys(graph.tests, 30);
  }
  if (test.runs.some((entry) => entry.via === run.via && entry.event === run.event)) return;
  test.runs.push({ ...run, summary: run.summary.slice(0, 120) });
  if (test.runs.length > 10) test.runs.shift();
}

function addCommand(graph, entry) {
  const command = { ...entry, command: entry.command.slice(0, 160) };
  if (graph.commands.some((previous) => previous.via === command.via &&
    previous.event === command.event && previous.command === command.command && previous.kind === command.kind)) return;
  graph.commands.push(command);
  if (graph.commands.length > 8) graph.commands.shift();
}

function parseArgs(raw) {
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  return isObject(raw) ? raw : null;
}
const argString = (args, key) => typeof args?.[key] === "string" && args[key].trim() ? args[key] : undefined;

export function observe(graph, step, call, result) {
  try {
    if (Number.isFinite(step)) graph.steps = step;
    if (!Number.isFinite(step) || typeof call?.name !== "string") return;
    const args = parseArgs(call.arguments);
    if (!args) return;
    const observation = { step, event: ++graph.sequence };
    const failed = !!result?.isError;
    if (call.name === "bash") {
      const command = argString(args, "command");
      if (command) classifyBash(graph, observation, command, result?.text ?? "", failed);
    } else if (!failed && call.name === "read") {
      const path = argString(args, "file_path") ?? argString(args, "path");
      if (!path) return;
      const from = Number.isInteger(args.offset) && args.offset >= 1 ? args.offset : 1;
      const to = Number.isInteger(args.limit) && args.limit > 0 ? from + args.limit - 1 : null;
      addRead(graph, path, { from, to, ...observation });
    } else if (!failed && ["edit", "write", "multi_edit", "apply_patch"].includes(call.name)) {
      const changes = new Map();
      function collect(value) {
        if (Array.isArray(value)) return value.forEach(collect);
        if (!isObject(value)) return;
        const path = argString(value, "file_path") ?? argString(value, "path");
        const snippet = [value.new_string, value.content, value.patch, value.diff].find((v) => typeof v === "string");
        if (path) changes.set(path, snippet);
        for (const nested of Object.values(value)) if (typeof nested === "object") collect(nested);
      }
      collect(args);
      for (const [path, snippet] of changes) {
        addEdit(graph, path, { ...observation }, snippet);
      }
    } else if (!failed && call.name === "grep") {
      if (typeof args.pattern === "string")
        addSearch(graph, args.pattern, argString(args, "path") ?? argString(args, "include") ?? "", { ...observation });
    }
  } catch {
    // Malformed observations must not interrupt the agent.
  }
}

function withoutHeredocs(command) {
  const lines = [], pending = [];
  for (const line of command.split("\n")) {
    if (pending.length) {
      const { delimiter, tabs } = pending[0];
      if ((tabs ? line.replace(/^\t+/, "") : line) === delimiter) pending.shift();
      continue;
    }
    lines.push(line.replace(/'[^']*'|"(?:\\.|[^"\\])*"|\\.|<<(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|([^\s;&|<>]+))/g,
      (match, tabs, single, double, bare) => {
        if (tabs === undefined) return match;
        pending.push({ delimiter: single ?? double ?? bare, tabs: !!tabs });
        return "";
      }));
  }
  return lines.join("\n");
}

function segments(command) {
  command = withoutHeredocs(command);
  const out = [];
  let start = 0, quote = null, piped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "\\" && quote !== "'") { i++; continue; }
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\n" || ch === ";" || ch === "|" || (ch === "&" && command[i + 1] === "&")) {
      if (!piped) out.push(command.slice(start, i).trim());
      piped = ch === "|" && command[i + 1] !== "|";
      if (command[i + 1] === ch) i++;
      start = i + 1;
    }
  }
  if (!piped) out.push(command.slice(start).trim());
  return out.filter(Boolean);
}

function tokenize(segment) {
  const out = [];
  let current = "", quote = null, quoted = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "\\" && quote !== "'" && i + 1 < segment.length) {
      if (quote === '"' && !['"', "\\", "$", "`", "\n"].includes(segment[i + 1])) current += ch;
      else current += segment[++i];
    }
    else if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; quoted = true; }
    else if (/\s/.test(ch)) {
      if (current || quoted) out.push(current);
      current = "";
      quoted = false;
    } else current += ch;
  }
  if (current || quoted) out.push(current);
  return out;
}
const base = (token) => (token ?? "").replace(/^.*\//, "");

function redirects(segment) {
  const paths = [];
  const command = segment.replace(/'[^']*'|"(?:\\.|[^"\\])*"|\\.|(?:\d*|&)(>>?|<)(?:&[\d-]+|[ \t]*((?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^\s<>])+))/g,
    (match, operator, target) => {
      if (!operator) return match;
      if (operator.startsWith(">") && target) paths.push(tokenize(target)[0]);
      return "";
    });
  return { command: command.trim(), paths };
}

function writePaths(tokens) {
  const head = base(tokens[0]);
  if (head === "tee") return tokens.slice(1).filter((token) => token && !token.startsWith("-"));
  if (head !== "sed" || !tokens.some((token) => /^-i|^--in-place/.test(token))) return [];
  const paths = [];
  let script = false, options = true;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (options && token === "--") { options = false; continue; }
    if (options && ["-e", "-f", "--expression", "--file"].includes(token)) { script = true; i++; continue; }
    if (options && /^(?:-[ef].|--(?:expression|file)=)/.test(token)) { script = true; continue; }
    if (options && token.startsWith("-")) continue;
    if (!script) script = true;
    else if (token) paths.push(token);
  }
  return paths;
}

function classifyBash(graph, observation, command, text, failed) {
  const parsed = segments(command).map(redirects);
  const testCount = parsed.filter((entry) => isTestCommand(tokenize(entry.command))).length;
  const summaries = (typeof text === "string" ? text : "").split(/[\r\n]+/)
    .filter((line) => /\b(?:\d+[ \t]+(?:passed|failed|errors?|failures?)|no tests ran|Interrupted)\b/i.test(line));
  let testIndex = 0;
  for (const { command: segment, paths } of parsed) {
    const tokens = tokenize(segment);
    const head = base(tokens[0]);
    if (head === "cd") continue;
    const writes = [...paths, ...writePaths(tokens)];
    if (!failed) for (const path of writes) {
      if (!/^\/(?:tmp|dev)(?:\/|$)/.test(path)) addEdit(graph, path, { ...observation });
    }
    if (isTestCommand(tokens)) {
      const summary = summaries.length === testCount ? summaries[testIndex] : summaries.at(-1) ?? text;
      testIndex++;
      addTest(graph, segment, { ...observation, ...testOutcome(summary) });
      continue;
    }
    if (writes.length) continue;
    if (!failed && ["cat", "nl", "head", "tail", "less", "sed"].includes(head)) {
      const reads = parseReads(tokens);
      if (reads.length) {
        for (const { path, from, to } of reads) addRead(graph, path, { from, to, ...observation });
        continue;
      }
    }
    if (["grep", "rg", "find", "ls"].includes(head) || (head === "git" && tokens[1] === "grep")) {
      const search = parseSearch(tokens);
      if (search) {
        addSearch(graph, search.pattern, search.path, { ...observation });
        continue;
      }
    }
    const kind = head === "git" && ["diff", "status", "log"].includes(tokens[1]) ? "inspect" : "command";
    addCommand(graph, { command: segment, ...observation, kind });
  }
}

function isTestCommand(tokens) {
  const head = base(tokens[0]);
  return head === "pytest" || head === "tox" ||
    (/^python[0-9.]*$/.test(head) && tokens[1] === "-m" && ["pytest", "unittest"].includes(tokens[2])) ||
    (head === "npm" && (tokens[1] === "test" || (tokens[1] === "run" && tokens[2] === "test")));
}

function parseReads(tokens) {
  const head = base(tokens[0]);
  let from = 1, to = null, script;
  if (head === "sed") {
    if (!tokens.includes("-n") || tokens.some((token) => /^-i|^--in-place/.test(token))) return [];
    script = tokens.find((token) => /^\d+(?:\s*,\s*\d+)?p$/.test(token));
    if (!script) return [];
    const bounds = script.match(/\d+/g).map(Number);
    [from, to] = [bounds[0], bounds[1] ?? bounds[0]];
  }
  const paths = [];
  let count = "10", options = true;
  const valueFlags = new Set(["-b", "-d", "-f", "-h", "-i", "-l", "-s", "-v", "-w"]);
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === script) continue;
    if (token === "--") { options = false; continue; }
    if (/^\d*[<>]/.test(token)) break;
    if (options && (head === "head" || head === "tail")) {
      if (token === "-n" || token === "--lines") { count = tokens[++i]; continue; }
      const match = /^(?:-n|--lines=)([+-]?\d+)$|^-(\d+)$/.exec(token);
      if (match) { count = match[1] ?? match[2]; continue; }
      if (/^(?:-c|--bytes)/.test(token)) return [];
    }
    if (options && token.startsWith("-")) {
      if (head === "nl" && valueFlags.has(token)) i++;
      continue;
    }
    if (token && token !== "-") paths.push(token);
  }
  if (head === "head" || head === "tail") {
    if (!/^[+-]?\d+$/.test(count) || Number(count) === 0 || (head === "head" && Number(count) < 0)) return [];
    if (head === "head") to = Number(count);
    else if (count.startsWith("+")) from = Number(count);
    else { from = -Math.abs(Number(count)); to = -1; }
  }
  if (from === 0 || (to !== null && to < from)) return [];
  return paths.map((path) => ({ path, from, to }));
}

const GREP_VALUE_FLAGS = new Set([
  "-f", "--file", "-A", "-B", "-C", "-m", "--include", "--exclude", "-g", "--glob", "--type", "-t",
]);
function parseSearch(tokens) {
  const head = base(tokens[0]);
  if (head === "find") {
    const at = tokens.findIndex((token) => ["-name", "-iname", "-path"].includes(token));
    return { pattern: at >= 0 ? tokens[at + 1] ?? "" : "", path: tokens[1] && !tokens[1].startsWith("-") ? tokens[1] : "." };
  }
  if (head === "ls") return { pattern: "", path: tokens.slice(1).find((token) => !token.startsWith("-")) ?? "." };
  let pattern, options = true;
  const paths = [];
  for (let i = head === "git" ? 2 : 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^\d*[<>]/.test(token)) break;
    if (options && token === "--") { options = false; continue; }
    if (options && (token === "-e" || token === "--regexp")) { pattern = tokens[++i]; continue; }
    if (options && /^--regexp=|^-e./.test(token)) { pattern = token.replace(/^--regexp=|^-e/, ""); continue; }
    if (options && token.startsWith("-")) {
      if (GREP_VALUE_FLAGS.has(token)) i++;
      continue;
    }
    if (pattern === undefined) pattern = token;
    else paths.push(token);
  }
  return pattern === undefined ? null : { pattern, path: paths.join(" ") };
}

function testOutcome(text) {
  const source = typeof text === "string" ? text : "";
  if (/\bInterrupted\b/i.test(source)) return { outcome: "error", summary: source.trim().slice(0, 120) };
  const status = "(?:passed|failed|errors?|failures?|skipped|xfailed|xpassed)";
  const phrase = `\\d+[ \\t]+${status}\\b`;
  const blocks = [...source.matchAll(new RegExp(`no tests ran|${phrase}(?:[ \\t]*,[ \\t]*${phrase})*`, "gi"))];
  const summary = blocks.at(-1)?.[0];
  if (!summary) return { outcome: "unknown", summary: (source.trim().split(/[\r\n]+/).at(-1) ?? "").slice(0, 120) };
  const matches = [...summary.matchAll(/(\d+)\s+(\w+)/g)];
  const count = (pattern) => matches.some((match) => +match[1] > 0 && pattern.test(match[2]));
  const outcome = count(/^(failed|failures?)$/i) ? "fail" : count(/^errors?$/i) ? "error" : count(/^passed$/i) ? "pass" : "unknown";
  return { outcome, summary: summary.slice(0, 120) };
}

function mergedRanges(reads) {
  const ranges = reads.map((read) => [read.from, end(read)]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [from, to] of ranges) {
    const last = merged.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  if (merged.some(([from, to]) => from === 1 && to === Infinity)) return [[1, Infinity]];
  return merged;
}
function rangeText(ranges) {
  return ranges.map(([from, to], i) => {
    if (from < 0) return to === -1 ? `last ${-from} lines` : `${-to}-${-from} lines from end`;
    if (to === Infinity) return from === 1 ? "whole" : `L${from}-`;
    return `${i ? "" : "L"}${from}${from === to ? "" : "-" + to}`;
  }).join(", ");
}
function cut(lines, limit) {
  if (lines.join("\n").length <= limit) return lines.join("\n");
  for (let kept = lines.length - 1; kept >= 0; kept--) {
    const text = [...lines.slice(0, kept), `… ${lines.length - kept} more entries`].join("\n");
    if (text.length <= limit) return text;
  }
  return "";
}

export function digest(graph, maxChars = 2000) {
  const lines = [];
  const paths = Object.keys(graph.files).sort(byString);
  for (const path of paths) {
    const file = graph.files[path];
    if (!file.edits.length) continue;
    const snippet = file.editSnippets.at(-1);
    lines.push(`edit ${path} steps ${file.edits.map((edit) => edit.step).join(",")}${snippet ? " " + snippet.replace(/\s+/g, " ").trim().slice(0, 120) : ""}`);
  }
  const tests = Object.entries(graph.tests).map(([key, test]) => ({ key, run: test.runs.at(-1) }));
  const rank = { fail: 0, error: 1, pass: 2, unknown: 3 };
  tests.sort((a, b) => rank[a.run.outcome] - rank[b.run.outcome] || b.run.step - a.run.step || byString(a.key, b.key));
  for (const { key, run } of tests)
    lines.push(`test ${run.outcome} ${key.slice(0, 160)}${run.summary ? ": " + run.summary.replace(/\s+/g, " ") : ""}`);
  for (const path of paths) {
    const file = graph.files[path];
    const latestEdit = Math.max(-Infinity, ...file.edits.map((edit) => edit.step));
    const fresh = mergedRanges(file.reads.filter((read) => read.step >= latestEdit));
    const wholeFresh = fresh.some(([from, to]) => from === 1 && to === Infinity);
    const stale = wholeFresh ? [] : subtract(mergedRanges(file.reads.filter((read) => read.step < latestEdit)), fresh);
    if (fresh.length) lines.push(`read ${rangeText(fresh)} ${path}`);
    if (stale.length) lines.push(`read ${rangeText(stale)} (stale) ${path}`);
  }
  for (const search of graph.searches.slice().sort((a, b) => byString(a.path, b.path) || byString(a.pattern, b.pattern)))
    lines.push(search.pattern ? `search ${search.pattern}${search.path ? " in " + search.path : ""}` : `list ${search.path || "."}`);
  for (const command of graph.commands)
    lines.push(`${command.kind} ${command.command.replace(/\s+/g, " ")}`);
  return cut(lines, Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 2000);
}

export function progressKey(graph) {
  const files = Object.keys(graph.files).sort(byString).map((path) => {
    const file = graph.files[path];
    return [path, mergedRanges(file.reads).map(([from, to]) => [from, to === Infinity ? null : to]), file.edits.length];
  });
  const tests = Object.keys(graph.tests).sort(byString).map((key) => [key, graph.tests[key].runs.at(-1).outcome]);
  const searches = graph.searches.map((search) => [search.pattern, search.path])
    .sort((a, b) => byString(a[0], b[0]) || byString(a[1], b[1]));
  return JSON.stringify({ files, tests, searches });
}

export function editsAfter(graph, step) {
  return Object.entries(graph.files).flatMap(([path, file]) => file.edits
    .filter((edit) => edit.step > step).map((edit) => ({ path, step: edit.step })))
    .sort((a, b) => a.step - b.step);
}

export function hasRead(graph, path) {
  return !!own(graph.files, path)?.reads.length;
}

export function merge(target, source, label) {
  if (target === source) return target;
  // Watermarks survive eviction of bounded histories and prevent replay after restore.
  const seen = {};
  function contribution(entry) {
    const via = entry.via === undefined ? label : `${label}/${entry.via}`;
    if (entry.event <= (own(target.imported, via) ?? -1)) return null;
    put(seen, via, Math.max(own(seen, via) ?? -1, entry.event));
    return { ...entry, via };
  }
  target.steps = Math.max(target.steps, source.steps);
  for (const [path, file] of Object.entries(source.files)) {
    for (const read of file.reads) {
      const entry = contribution(read);
      if (entry) addRead(target, path, entry);
    }
    for (let i = 0; i < file.edits.length; i++) {
      const entry = contribution(file.edits[i]);
      if (entry) addEdit(target, path, entry, i === file.edits.length - 1 ? file.editSnippets.at(-1) : undefined);
    }
  }
  for (const [key, test] of Object.entries(source.tests)) for (const run of test.runs) {
    const entry = contribution(run);
    if (entry) addTest(target, key, entry);
  }
  for (const search of source.searches) for (const observation of search.observations) {
    const entry = contribution(observation);
    if (entry) addSearch(target, search.pattern, search.path, entry);
  }
  for (const command of source.commands) {
    const entry = contribution(command);
    if (entry) addCommand(target, entry);
  }
  for (const [via, event] of Object.entries(seen)) put(target.imported, via, event);
  return target;
}

export function fromJSON(value) {
  const raw = parseArgs(value);
  const graph = createGraph();
  if (!raw) return graph;
  if (Number.isFinite(raw.steps)) graph.steps = raw.steps;
  if (Number.isInteger(raw.sequence) && raw.sequence >= 0) graph.sequence = raw.sequence;
  if (isObject(raw.imported)) for (const [via, event] of Object.entries(raw.imported)) {
    if (Number.isInteger(event) && event >= 0) put(graph.imported, via, event);
  }
  function observation(entry, legacyVia) {
    const event = Number.isInteger(entry.event) && entry.event >= 0 ? entry.event : ++graph.sequence;
    const via = provenance(entry.via ?? legacyVia);
    if (via.via === undefined) graph.sequence = Math.max(graph.sequence, event);
    return { step: entry.step, event, ...via };
  }
  if (isObject(raw.files)) for (const [path, stored] of Object.entries(raw.files)) {
    if (!isObject(stored) || !path) continue;
    for (const item of items(stored.reads)) {
      const read = Array.isArray(item) ? { from: item[0], to: item[1], step: item[2] } : item;
      if (!isObject(read) || !Number.isFinite(read.step) || !Number.isInteger(read.from)) continue;
      const valid = read.from > 0 ? read.to === null || (Number.isInteger(read.to) && read.to >= read.from) :
        read.from < 0 && Number.isInteger(read.to) && read.to < 0 && read.to >= read.from;
      if (valid) addRead(graph, path, { from: read.from, to: read.to, ...observation(read, stored.via) });
    }
    const edits = items(stored.edits);
    for (let i = 0; i < edits.length; i++) {
      const edit = typeof edits[i] === "number" ? { step: edits[i] } : edits[i];
      if (!isObject(edit) || !Number.isFinite(edit.step)) continue;
      addEdit(graph, path, observation(edit, stored.via));
    }
    const snippet = items(stored.editSnippets).filter((item) => typeof item === "string").at(-1);
    const file = own(graph.files, path);
    if (file?.edits.length && snippet) file.editSnippets = [snippet.slice(0, 300)];
  }
  for (const search of items(raw.searches)) {
    if (!isObject(search) || typeof search.pattern !== "string") continue;
    for (const entry of Array.isArray(search.observations) ? search.observations : [search]) {
      if (isObject(entry) && Number.isFinite(entry.step))
        addSearch(graph, search.pattern, typeof search.path === "string" ? search.path : "", observation(entry));
    }
  }
  if (isObject(raw.tests)) for (const [key, test] of Object.entries(raw.tests)) {
    if (!key.trim() || !isObject(test)) continue;
    for (const run of items(test.runs)) {
      if (!isObject(run) || !Number.isFinite(run.step) || !["pass", "fail", "error", "unknown"].includes(run.outcome)) continue;
      addTest(graph, key, { ...observation(run), outcome: run.outcome,
        summary: typeof run.summary === "string" ? run.summary : "" });
    }
  }
  for (const command of items(raw.commands)) {
    if (!isObject(command) || !Number.isFinite(command.step) || !argString(command, "command")) continue;
    addCommand(graph, { command: command.command, ...observation(command),
      kind: command.kind === "inspect" ? "inspect" : "command" });
  }
  return graph;
}
