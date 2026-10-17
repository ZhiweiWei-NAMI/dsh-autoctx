import { execFile } from 'node:child_process';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { resolve } from 'node:path';

const chars = value => typeof value === 'string' ? value : '';
const budget = (value, fallback) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
const errorText = error => error instanceof Error ? error.message : String(error);

function git(cwd, args, timeoutMs) {
  return new Promise((accept, reject) => {
    const child = execFile('git', ['-c', 'core.quotePath=false', '-c', 'safe.directory=*', ...args], {
      cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
    }, (error, stdout) => error ? reject(error) : accept(stdout));
    child.stdin?.end();
  });
}

function diffUnits(diff) {
  const units = [];
  for (const file of diff.split(/(?=^diff --git )/m).filter(Boolean)) {
    const parts = file.split(/(?=^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)/m);
    if (parts.length === 1) units.push(file);
    else {
      units.push(parts[0] + parts[1]);
      units.push(...parts.slice(2));
    }
  }
  return units;
}

function boundedDiff(diff, maxChars) {
  if (diff.length <= maxChars) return { diff, truncated: false };
  const marker = '\n[… diff truncated …]\n';
  let kept = '';
  for (const unit of diffUnits(diff)) {
    if (kept.length + unit.length + marker.length > maxChars) break;
    kept += unit;
  }
  return { diff: kept + (maxChars >= marker.length ? marker : ''), truncated: true };
}

export async function workspaceDiff(cwd, { maxChars = 12000, timeoutMs = 5000 } = {}) {
  // Without a workspace, git would diff whatever directory the host process runs in.
  if (!cwd) return { diff: '', files: [], untracked: [], truncated: false, error: 'no workspace' };
  try {
    let base;
    try {
      base = (await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], timeoutMs)).trim();
    } catch (error) {
      if (error.code !== 1) throw error;
      // An unborn repository still needs a single diff against its current files.
      base = (await git(cwd, ['hash-object', '-t', 'tree', '--stdin'], timeoutMs)).trim();
    }
    const diff = await git(cwd, ['diff', '--no-color', '--no-ext-diff', '-U3', base, '--'], timeoutMs);
    const names = await git(cwd, ['diff', '--no-ext-diff', '--name-only', '-z', base, '--'], timeoutMs);
    const status = await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'], timeoutMs);
    const files = names.split('\0').filter(Boolean), untracked = [];
    const entries = status.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.startsWith('?? ')) untracked.push(entry.slice(3));
      if (/^[RC]|^.[RC]/.test(entry)) i++;
    }
    let combined = diff, omitted = false;
    // Reading every new file of a large untracked tree would stall the turn; the first 20 are enough.
    for (const path of untracked.slice(0, 20)) {
      if (!files.includes(path)) files.push(path);
      const absolute = resolve(cwd, path), info = await lstat(absolute);
      const header = `diff --git ${JSON.stringify('a/' + path)} ${JSON.stringify('b/' + path)}\n`;
      if (!info.isSymbolicLink() && !info.isFile()) throw new Error(`Unsupported untracked file: ${path}`);
      if (!info.isSymbolicLink() && info.size >= 16000) {
        combined += header + '[Untracked file content omitted: at least 4000 characters]\n';
        omitted = true;
        continue;
      }
      const content = info.isSymbolicLink() ? await readlink(absolute) : await readFile(absolute, 'utf8');
      if (content.length >= 4000) {
        combined += header + `[Untracked file content omitted: ${content.length} characters]\n`;
        omitted = true;
      } else if (content.includes('\0')) {
        combined += header + `Binary files /dev/null and ${JSON.stringify('b/' + path)} differ\n`;
      } else {
        const lines = content ? content.split('\n') : [];
        if (content.endsWith('\n')) lines.pop();
        combined += header + `new file mode ${info.isSymbolicLink() ? '120000' : info.mode & 0o111 ? '100755' : '100644'}\n` +
          `--- /dev/null\n+++ ${JSON.stringify('b/' + path)}\n@@ -0,0 +${lines.length ? 1 : 0},${lines.length} @@\n` +
          lines.map(line => '+' + line + '\n').join('') +
          (content && !content.endsWith('\n') ? '\\ No newline at end of file\n' : '');
      }
    }
    const bounded = boundedDiff(combined, budget(maxChars, 12000));
    return { ...bounded, files, untracked, truncated: bounded.truncated || omitted };
  } catch (error) {
    return { diff: '', files: [], untracked: [], truncated: false, error: errorText(error) };
  }
}

function diffPath(header) {
  let path = header;
  if (path.startsWith('"')) {
    path = /^"(?:\\.|[^"\\])*"/.exec(path)?.[0] ?? path;
    try { path = JSON.parse(path); }
    catch {
      const escapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
      const bytes = [];
      for (const token of path.slice(1, -1).matchAll(/\\([0-7]{1,3}|.)|[^\\]+/g)) {
        if (token[1] === undefined) bytes.push(Buffer.from(token[0]));
        else if (/^[0-7]/.test(token[1])) bytes.push(Buffer.from([parseInt(token[1], 8)]));
        else bytes.push(Buffer.from([escapes[token[1]] ?? token[1].charCodeAt(0)]));
      }
      path = Buffer.concat(bytes).toString('utf8');
    }
  } else path = path.split('\t')[0];
  return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
}

function hunksOf(diff) {
  const hunks = [];
  let path, oldPath, removed = false, oldLeft = 0, newLeft = 0;
  for (const line of chars(diff).split('\n')) {
    if (line.startsWith('diff --git ')) {
      path = oldPath = undefined;
      oldLeft = newLeft = 0;
    } else if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      oldLeft = Number(match[2] ?? 1);
      newLeft = Number(match[4] ?? 1);
      if (path) hunks.push({ path, start: Number(match[3]), count: newLeft, removed });
    } else if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith(' ') || line.startsWith('-')) oldLeft--;
      if (line.startsWith(' ') || line.startsWith('+')) newLeft--;
    } else if (line.startsWith('--- ')) oldPath = diffPath(line.slice(4));
    else if (line.startsWith('+++ ')) {
      const current = diffPath(line.slice(4));
      path = current ?? oldPath;
      removed = current === null;
    }
  }
  return hunks;
}

const definition = /^\s*(async\s+)?(def|class|function)\s|^\s*(export\s+)?(async\s+)?function\s|=>\s*\{\s*$/;

export async function hunkContext(cwd, diff, { radius = 20, maxChars = 8000 } = {}) {
  try {
    const hunks = hunksOf(diff), grouped = new Map(), windows = [];
    radius = budget(radius, 20);
    maxChars = budget(maxChars, 8000);
    for (const hunk of hunks) {
      if (!grouped.has(hunk.path)) grouped.set(hunk.path, []);
      grouped.get(hunk.path).push(hunk);
    }
    for (const [path, changes] of grouped) {
      let lines;
      try {
        if (changes[0].removed) {
          windows.push({ text: `### ${path}\n[Deleted file; removed code is in the diff.]`, hunks: changes.length });
          continue;
        }
        lines = (await readFile(resolve(cwd, path), 'utf8')).split('\n');
        if (lines.at(-1) === '' && lines.length > 1) lines.pop();
      } catch (error) {
        windows.push({ text: `### ${path}\n[Unable to read current file: ${errorText(error)}]`, hunks: changes.length });
        continue;
      }
      const ranges = [];
      for (const hunk of changes.sort((a, b) => a.start - b.start)) {
        const start = Math.max(1, Math.min(lines.length, hunk.start));
        let from = Math.max(1, start - radius);
        const to = Math.min(lines.length, start + Math.max(1, hunk.count) - 1 + radius);
        for (let line = start; line >= Math.max(1, start - 120); line--) {
          if (definition.test(lines[line - 1])) { from = Math.min(from, line); break; }
        }
        const previous = ranges.at(-1);
        if (previous && from <= previous.to + 1) {
          previous.to = Math.max(previous.to, to);
          previous.hunks++;
        } else ranges.push({ from, to, hunks: 1 });
      }
      for (const range of ranges) windows.push({
        text: `### ${path} (lines ${range.from}-${range.to})\n` +
          lines.slice(range.from - 1, range.to).map((line, i) => `${String(range.from + i).padStart(5)} | ${line}`).join('\n'),
        hunks: range.hunks,
      });
    }
    let text = '', included = 0;
    for (const window of windows) {
      const remaining = hunks.length - included - window.hunks;
      const next = text + (text ? '\n\n' : '') + window.text;
      const marker = remaining ? `\n\n[… ${remaining} more hunks omitted …]` : '';
      if (next.length + marker.length > maxChars) break;
      text = next;
      included += window.hunks;
    }
    if (included < hunks.length) {
      const marker = `[… ${hunks.length - included} more hunks omitted …]`;
      if (text.length + (text ? 2 : 0) + marker.length <= maxChars) text += (text ? '\n\n' : '') + marker;
    }
    return text;
  } catch (error) {
    const message = `[Unable to collect hunk context: ${errorText(error)}]`;
    return message.slice(0, budget(maxChars, 8000));
  }
}

function headTail(text, maxChars) {
  if (!maxChars) return '';
  if (text.length <= maxChars) return text;
  const reserve = `\n[… ${text.split('\n').length} lines …]\n`;
  if (maxChars <= reserve.length) return text.slice(-maxChars);
  const room = maxChars - reserve.length, head = Math.floor(room / 3), tail = room - head;
  const count = text.slice(head, text.length - tail).split('\n').length;
  return text.slice(0, head) + `\n[… ${count} lines …]\n` + text.slice(-tail);
}

export function failureExcerpt(text, { maxChars = 3000, focus = [] } = {}) {
  text = chars(text);
  maxChars = budget(maxChars, 3000);
  if (!maxChars) return '';
  if (text.length <= maxChars) return text;
  const lines = text.split('\n'), scores = new Map();
  const mark = (i, score) => {
    if (i >= 0 && i < lines.length) scores.set(i, Math.max(scores.get(i) ?? 0, score));
  };
  const terms = (Array.isArray(focus) ? focus : [focus]).filter(term => typeof term === 'string' && term.length);
  let summary = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^_+\s+.+\s+_+\s*$/.test(line)) mark(i, 6);
    if (/Traceback/.test(line)) {
      mark(i, 6);
      const frames = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/Traceback|^_+\s|^=+\s/.test(lines[j])) break;
        if (/^\s*File ".+", line \d+|^\s*\S+\.py:\d+:/.test(lines[j])) frames.push(j);
      }
      for (const frame of frames.slice(-2)) {
        mark(frame, 7);
        for (let j = frame + 1; j < lines.length && /^\s+\S/.test(lines[j]) && !/^\s*File "/.test(lines[j]); j++) mark(j, 6);
      }
    }
    if (/^E(?:\s|$)/.test(line)) {
      mark(i, 8);
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) mark(j, 7);
    }
    if (/\bassert\b|\b\w*(?:Error|Exception)\b/.test(line)) mark(i, 8);
    if (/short test summary info/.test(line)) summary = true;
    if (summary && line.trim()) mark(i, 5);
    if (summary && /^=+/.test(line) && !/short test summary info/.test(line)) summary = false;
    if (/^(?:=+\s*)?.*\b\d+\s+(?:passed|failed|errors?|failures?|skipped)\b.*(?:=+)?\s*$/.test(line)) mark(i, 9);
    if (terms.some(term => line.includes(term))) {
      mark(i, 8);
      for (let j = i - 2; j <= i + 2; j++) if (j !== i) mark(j, 2);
    }
  }
  if (!scores.size) return headTail(text, maxChars);
  const selected = new Map();
  const render = () => {
    const output = [];
    let skipped = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!selected.has(i)) { skipped++; continue; }
      if (skipped) output.push(`[… ${skipped} lines …]`);
      skipped = 0;
      output.push(selected.get(i));
    }
    if (skipped) output.push(`[… ${skipped} lines …]`);
    return output.join('\n');
  };
  let used = 0;
  for (const [i] of [...scores].sort((a, b) => b[1] - a[1] || b[0] - a[0])) {
    const value = headTail(lines[i], Math.floor(maxChars / 2));
    const cost = value.length + 1;
    if (used + cost + 60 > maxChars) continue;
    selected.set(i, value);
    used += cost;
  }
  if (!selected.size) {
    const best = [...scores].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    selected.set(best, headTail(lines[best], Math.max(0, maxChars - 60)));
  }
  let result = render();
  for (const [i] of [...scores].sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    if (result.length <= maxChars) break;
    if (selected.size <= 1) break;
    selected.delete(i);
    result = render();
  }
  return result.length <= maxChars ? result : headTail(result, maxChars);
}

export function adviceQuestion(trigger, { test, attempts } = {}) {
  trigger = chars(trigger);
  if (trigger === 'stall') return 'No new evidence for several steps. Given the current change and the code below, what is the most likely remaining defect, and which one check would confirm it?';
  if (trigger.startsWith('repeated failure: ')) {
    const command = chars(test) || trigger.slice('repeated failure: '.length);
    const count = Number.isInteger(attempts) && attempts >= 0 ? attempts : 'several';
    return `\`${command}\` still fails after ${count} edit-and-rerun attempts. Using the current change, the code around it and the failure output below: what in the changed code or its callers causes this failure, and what single change would fix it?`;
  }
  return `Given the current change, the code around it and the observed failure below${trigger ? ' (trigger: ' + trigger + ')' : ''}, what is the most likely defect, and what single change would fix it?`;
}

const trimMarker = '\n[… trimmed …]';

function trimText(text, maxChars) {
  if (text.length <= maxChars) return text;
  return maxChars >= trimMarker.length ? text.slice(0, maxChars - trimMarker.length) + trimMarker : text.slice(0, maxChars);
}

function brief(prompt, sections, priorities, maxChars) {
  const render = () => chars(prompt) + sections.map(section => `\n\n## ${section.title}\n${section.text}`).join('');
  let result = render();
  for (const [title, minimum] of priorities) {
    if (result.length <= maxChars) break;
    const section = sections.find(entry => entry.title === title);
    const floor = Math.min(section.text.length, minimum ? minimum + trimMarker.length : 0);
    const keep = Math.max(floor, section.text.length - (result.length - maxChars));
    section.text = trimText(section.text, keep);
    result = render();
  }
  // Role instructions, failure evidence and minimum code survive even an impossible budget.
  return result;
}

export function advisorBrief({ prompt, question, failure, diff, context, attempts, task, ledger, maxChars = 16000 } = {}) {
  return brief(prompt, [
    { title: 'Question', text: chars(question) },
    { title: 'Observed failure', text: chars(failure) },
    { title: 'Current change (diff)', text: chars(diff) },
    { title: 'Relevant code', text: chars(context) },
    { title: 'Previous attempts', text: chars(attempts) },
    { title: 'Task', text: chars(task) },
    { title: 'Evidence ledger', text: chars(ledger) },
  ], [['Evidence ledger', 0], ['Task', 1500], ['Relevant code', 0], ['Current change (diff)', 2000]], budget(maxChars, 16000));
}

export function reviewBrief({ prompt, task, diff, context, ledger, maxChars = 16000 } = {}) {
  return brief(prompt, [
    { title: 'Scope', text: 'Review exactly this change; the surrounding code is included so you need not rediscover it.' },
    { title: 'Change', text: chars(diff) },
    { title: 'Surrounding code', text: chars(context) },
    { title: 'Original issue', text: chars(task) },
    { title: 'Evidence ledger', text: chars(ledger) },
  ], [['Evidence ledger', 0], ['Original issue', 1500], ['Surrounding code', 0], ['Change', 2000]], budget(maxChars, 16000));
}

export function attemptsFrom(graph, testKey) {
  const test = graph?.tests && Object.hasOwn(graph.tests, testKey) ? graph.tests[testKey] : undefined;
  const runs = (Array.isArray(test?.runs) ? test.runs : [])
    .filter(run => run.via === undefined).slice().sort((a, b) => a.event - b.event);
  const edits = Object.entries(graph?.files ?? {}).flatMap(([path, file]) =>
    (Array.isArray(file.edits) ? file.edits : []).filter(edit => edit.via === undefined)
      .map(edit => ({ path, event: edit.event }))).sort((a, b) => a.event - b.event);
  const lines = [];
  for (let i = Math.max(0, runs.length - 5); i < runs.length; i++) {
    const run = runs[i], previous = runs[i - 1];
    const paths = [...new Set(edits.filter(edit => (!previous || edit.event > previous.event) && edit.event <= run.event)
      .map(edit => edit.path))];
    if (paths.length) lines.push(`Edited ${previous ? 'since previous run' : 'before first run'}: ${paths.join(', ')}`);
    const summary = chars(run.summary).replace(/\s+/g, ' ').trim();
    lines.push(`Run ${i + 1} (event ${run.event}): ${run.outcome}${summary ? ' — ' + summary : ''}`);
  }
  const last = runs.at(-1);
  if (last) {
    const paths = [...new Set(edits.filter(edit => edit.event > last.event).map(edit => edit.path))];
    if (paths.length) lines.push(`Edited since last run: ${paths.join(', ')}`);
  }
  return lines.join('\n');
}
