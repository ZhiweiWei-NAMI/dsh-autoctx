import {createHash} from 'node:crypto';

export function focusTerms({failingTests = [], errors = [], symbols = []} = {}) {
  const terms = new Map();
  for (const value of [...failingTests, ...errors, ...symbols]) {
    const term = (value instanceof Error ? value.message : String(value)).trim();
    if (term && !terms.has(term.toLowerCase())) terms.set(term.toLowerCase(), term);
  }
  return [...terms.values()];
}

function references(text, argument) {
  const value = text + '\n' + (argument ?? '');
  const files = new Set(), symbols = new Set(), tests = new Set();
  const paths = /(?:[A-Za-z]:)?(?:\.?\.?[/\\])?(?:[\w@~.+-]+[/\\])+[\w@~.+-]+|\b[\w@+-]+\.[A-Za-z][\w+-]*\b/g;
  for (const match of value.matchAll(paths)) {
    const path = match[0].replace(/\\/g, '/').replace(/^(?:\.\/|[ab]\/)/, '').replace(/\.+$/, '');
    if (!/^\d+\.\d+$/.test(path)) files.add(path);
  }
  for (const match of value.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(|`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)`/g))
    symbols.add(match[1] ?? match[2]);
  for (const match of value.matchAll(/\btest_[A-Za-z0-9_]+\b/g)) tests.add(match[0]);
  return {files: [...files], symbols: [...symbols], tests: [...tests]};
}

function signatureOf(text) {
  const normalized = text
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, '')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\b/g, '')
    .replace(/\b0x[\da-f]+\b/gi, '')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '')
    .replace(/[\d\s]+/g, '');
  return createHash('sha256').update(normalized).digest('hex');
}

const sourceLine = line => line.replace(/^[ \t]*\d+(?:[ \t]*[|:][ \t]?|\t| )/, '');
const definition = /^(?:(?:export|default|async)\s+)*(?:def|class|function\*?)\s+[A-Za-z_$][\w$]*/;

function semanticRanges(text, maxChars) {
  const lines = [];
  let offset = 0;
  for (const match of text.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    lines.push({start: offset, end: offset + match[0].length, text: match[0]});
    offset += match[0].length;
  }
  if (!lines.length) return [[0, 0]];
  const diff = lines.some(line => /^(?:diff --git |@@ )/.test(line.text));
  const pytest = lines.some(line => /^\s*(?:_{3,}\s+\S.*_{3,}|={3,}.*(?:FAILURES|ERRORS|short test summary)|Traceback \(most recent call last\):)/i.test(line.text));
  const source = !diff && !pytest && lines.some(line => definition.test(sourceLine(line.text)));
  const starts = [0];
  let hunk = false;
  for (const line of lines) {
    let boundary = false;
    if (diff) {
      if (/^diff --git /.test(line.text)) {
        boundary = true;
        hunk = false;
      } else if (/^@@ /.test(line.text)) {
        boundary = hunk;
        hunk = true;
      }
    } else if (pytest) {
      boundary = /^\s*(?:_{3,}\s+\S.*_{3,}|={3,}.*(?:FAILURES|ERRORS|short test summary)|Traceback \(most recent call last\):)/i.test(line.text);
    } else if (source) {
      boundary = definition.test(sourceLine(line.text));
    } else {
      boundary = !line.text.trim();
    }
    if (boundary && line.start > starts.at(-1)) starts.push(line.start);
  }
  starts.push(text.length);
  const ranges = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const start = starts[i], end = starts[i + 1];
    const previous = ranges.at(-1);
    if (!diff && !pytest && !source && previous && end - previous[0] <= maxChars) previous[1] = end;
    else ranges.push([start, end]);
  }
  return ranges;
}

function splitRange(text, start, end, maxChars) {
  const ranges = [];
  while (end - start > maxChars) {
    const newline = text.lastIndexOf('\n', start + maxChars - 1);
    // A single oversized line still needs a bounded segment.
    const next = newline >= start ? newline + 1 : start + maxChars;
    ranges.push([start, next]);
    start = next;
  }
  if (start < end || !ranges.length) ranges.push([start, end]);
  return ranges;
}

export function segmentUnits(units, {maxSegmentChars = 1500, focus = []} = {}) {
  if (!Number.isInteger(maxSegmentChars) || maxSegmentChars < 1)
    throw new RangeError('maxSegmentChars must be a positive integer.');
  return units.flatMap(unit => {
    let text = unit.text, decoded = false;
    try {
      const block = JSON.parse(unit.text);
      if (typeof block?.text === 'string') {
        text = block.text;
        decoded = true;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const ranges = unit.required || !decoded ? [[0, text.length]] :
      semanticRanges(text, maxSegmentChars).flatMap(([start, end]) => splitRange(text, start, end, maxSegmentChars));
    return ranges.map(([start, end], k) => {
      const value = text.slice(start, end);
      return {id: unit.id + '#' + k, unitId: unit.id, position: unit.position, kind: unit.kind,
        tool: unit.tool, argument: unit.argument, required: unit.required, text: value, start, end,
        signature: signatureOf(value), refs: references(value, unit.argument)};
    });
  });
}

const omission = count => `[… ${count} chars omitted …]`;

function headTail(text, limit) {
  if (text.length <= limit) return text;
  const marker = omission(text.length);
  if (marker.length >= limit) return text.slice(0, Math.max(0, limit));
  const room = limit - marker.length, head = Math.ceil(room / 2), tail = Math.floor(room / 2);
  return text.slice(0, head) + omission(text.length - head - tail) + (tail ? text.slice(-tail) : '');
}

function focusedExcerpt(text, focus, limit) {
  const terms = focusTerms({symbols: focus}).map(term => term.toLowerCase());
  if (!terms.length) return '';
  const lines = text.split('\n'), matches = [];
  for (let i = 0; i < lines.length; i++)
    if (terms.some(term => lines[i].toLowerCase().includes(term))) matches.push(i);
  if (!matches.length) return '';
  const selected = new Map();
  let used = 0;
  // Reserve the matching lines before spending space on their context.
  for (const distance of [0, 1, 2, 3]) {
    for (const match of matches) {
      for (const i of distance ? [match - distance, match + distance] : [match]) {
        if (i < 0 || i >= lines.length || selected.has(i)) continue;
        let line = lines[i];
        if (!distance && line.length + 4 > limit - used && limit - used > 8) {
          const lower = line.toLowerCase();
          const at = Math.min(...terms.map(term => lower.indexOf(term)).filter(index => index >= 0));
          const width = limit - used - 6;
          const start = Math.max(0, at - Math.floor(width / 3));
          line = (start ? '…' : '') + line.slice(start, start + width) + '…';
        }
        const cost = line.length + 4;
        if (used + cost <= limit) {
          selected.set(i, line);
          used += cost;
        }
      }
    }
  }
  if (!selected.size) return headTail(lines[matches[0]], limit);
  let previous = -2;
  return [...selected.keys()].sort((a, b) => a - b).map(i => {
    const prefix = i === previous + 1 ? '\n' : previous < 0 ? '' : '\n…\n';
    previous = i;
    return prefix + selected.get(i);
  }).join('');
}

export function segmentPreview(segment, focus = [], maxChars = 600) {
  if (!Number.isInteger(maxChars) || maxChars < 1)
    throw new RangeError('maxChars must be a positive integer.');
  const parts = [segment.kind ?? 'unit'];
  if (segment.tool) parts.push(segment.tool);
  if (segment.argument) parts.push('(' + segment.argument + ')');
  parts.push(segment.unitId);
  const raw = parts.join(' '), text = segment.text;
  if (raw.length + 1 + text.length <= maxChars) return raw + '\n' + text;
  const titleLimit = Math.min(200, Math.floor(maxChars / 3));
  const suffix = ' [' + segment.unitId + ']';
  const title = raw.length <= titleLimit ? raw : suffix.length < titleLimit ?
    raw.slice(0, titleLimit - suffix.length - 1) + '…' + suffix : headTail(raw, titleLimit);
  const room = maxChars - title.length - 1;
  const focused = focusedExcerpt(text, focus, Math.floor(room * 2 / 3));
  const body = focused ? focused + '\n…\n' + headTail(text, room - focused.length - 3) : headTail(text, room);
  return (title + '\n' + body).slice(0, maxChars);
}
