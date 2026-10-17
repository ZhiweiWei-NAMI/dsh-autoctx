export const ASSESSABLE_THRESHOLD = 0.5;
export const CONTRIBUTION_LEVELS = [
  'Wrong or harmful: a claim was contradicted by related facts, or acting on it broke things.',
  'Not useful: claims were correct but irrelevant or already known.',
  'Mixed: some claims were useful and some were wrong.',
  'Useful: related facts confirmed a claim that the executor needed.',
  'Decisive: it identified the actual defect or fix confirmed by related facts.',
];

const round = (value, digits) => Number(value.toFixed(digits));
const clip = (text, cap) => Array.from(text).slice(0, cap).join('');
const unique = values => [...new Set(values)];
const basename = path => path.replace(/\\/g, '/').split('/').at(-1);
const normalize = token => token.replace(/\\/g, '/').replace(/^\.\//, '')
  .replace(/[.,;:!?]+$/, '').replace(/:\d+(?::\d+)?$/, '');
const tokensOf = text => unique([
  ...[...text.matchAll(/`([^`]+)`/g)].map(match => normalize(match[1])),
  ...[...text.matchAll(/[A-Za-z0-9_$@./\\:-]+/g)].map(match => normalize(match[0])),
].filter(Boolean));

function claimTexts(text) {
  const items = [];
  let bullet;
  const flush = () => {
    if (bullet !== undefined) items.push(bullet);
    bullet = undefined;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^(?:\*\*)?(?:LGTM|DEFECTS)\b(?:\*\*)?\s*[:.!?\-]?\s*/i, '');
    if (!line) { flush(); continue; }
    const item = /^(?:[-*]|\d+\.)\s+(.+)$/.exec(line);
    if (item) {
      flush();
      bullet = item[1];
    } else if (bullet !== undefined) bullet += ' ' + line;
    else items.push(...line.split(/(?<=[.!?])\s+/));
  }
  flush();
  return items.map(item => item.trim()).filter(Boolean).slice(0, 6)
    .map(item => clip(item, 200));
}

function mentions(key, reference) {
  if (normalize(key) === reference) return true;
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^A-Za-z0-9_$])' + escaped + '(?=$|[^A-Za-z0-9_$])').test(key);
}

function claimFacts(text, at, graph) {
  const tokens = tokensOf(text);
  const files = Object.keys(graph.files).filter(path =>
    tokens.includes(normalize(path)) || tokens.includes(basename(path)));
  const symbols = unique([
    ...[...text.matchAll(/`([A-Za-z_$][\w$]*)`/g)].map(match => match[1]),
    ...[...text.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1]),
  ]);
  const tests = unique([
    ...Object.keys(graph.tests).filter(key => tokens.includes(normalize(key))),
    ...tokens.filter(token => token.includes('test_')),
  ]);
  const editsAfter = files.flatMap(path => {
    const count = graph.files[path].edits.filter(edit => edit.via === undefined && edit.event > at).length;
    return count ? [{ path, count }] : [];
  });
  const testRunsAfter = Object.entries(graph.tests).flatMap(([key, test]) => {
    const referenced = tests.length
      ? tests.some(reference => mentions(key, reference))
      : files.some(path => key.includes(basename(path)));
    if (!referenced) return [];
    const outcomes = test.runs.filter(run => run.event > at)
      .sort((a, b) => a.event - b.event).slice(-5).map(run => run.outcome);
    return outcomes.length ? [{ key, outcomes }] : [];
  });
  return { text, files, symbols, tests, related: { editsAfter, testRunsAfter } };
}

const matched = claim => claim.related.editsAfter.length > 0 || claim.related.testRunsAfter.length > 0;

export function contributionFacts(entry, graph) {
  return {
    role: entry.role,
    model: entry.model,
    children: entry.children,
    completed: entry.completed,
    calls: entry.calls,
    usd: round(entry.usd, 6),
    seconds: round(entry.ms / 1000, 1),
    cacheHit: entry.input > 0 ? round(entry.cacheRead / entry.input, 3) : null,
    reports: entry.reports.map(report => {
      const claims = claimTexts(report.text).map(text => claimFacts(text, report.at, graph));
      return {
        ...(report.verdict !== undefined ? { verdict: report.verdict } : {}),
        ...(report.outcome !== undefined ? { outcome: report.outcome } : {}),
        ...(report.trigger !== undefined ? { trigger: report.trigger } : {}),
        claims,
        unmatched: claims.filter(claim => !matched(claim)).length,
      };
    }),
  };
}

export function learningQuestions(facts, { tag, need }) {
  const scope = tag === undefined ? 'this task kind' : clip(String(tag), 50);
  const preference = need === undefined ? '' : ' User need: ' + clip(
    typeof need === 'string' ? need : JSON.stringify(need), 70) + '.';
  return Object.fromEntries(facts.flatMap((_, i) => [
    ['assessable_' + i, {
      type: 'noul',
      instructions: 'For facts[' + i + '], how probable is it that specific claims can be judged from correspondence with later edits of named code, tests of named behavior, or explicit user feedback? Overall task success/failure alone is not correspondence. Ignored claims are not wrong; an edit alone does not confirm correctness. Below 0.5 means no observation: weight and n stay unchanged. Judge independently of fit_' + i + '; questions cannot see each other\'s answers.',
    }],
    ['fit_' + i, {
      type: 'score',
      instructions: 'Judge facts[' + i + '] for ' + scope + ' using only claims with correspondence to later edits of named code, named-behavior tests, or explicit user feedback. Overall outcome alone is insufficient; ignored claims are not wrong. Judge independently of assessable_' + i + '. Use the criteria; no insufficient-evidence level. Score is the probability-weighted mean of indices (2 may mix extremes). Plugin: assessable < 0.5 means no weight/n change; otherwise target = score/4.' + preference,
      criteria: CONTRIBUTION_LEVELS,
    }],
  ]));
}

function basisOf(fact) {
  const claims = fact.reports.flatMap(report => report.claims);
  const matches = claims.filter(matched);
  const keys = unique(matches.flatMap(claim => claim.related.testRunsAfter.map(run => run.key)));
  const paths = unique(matches.flatMap(claim => claim.related.editsAfter.map(edit => edit.path)));
  const related = [
    ...keys.slice(0, 1).map(key => {
      const outcomes = unique(matches.flatMap(claim => claim.related.testRunsAfter
        .filter(run => run.key === key).flatMap(run => run.outcomes)));
      return clip(key, 32) + ' ' + outcomes.join('/');
    }),
    ...(paths.length ? ['edits to ' + paths.slice(0, 2).map(path => clip(path, 24)).join(', ')] : []),
  ].join('; ');
  const tail = '; ' + (claims.length - matches.length) + ' unmatched; $' + fact.usd + '; ' + fact.seconds + 's';
  return clip(matches.length + ' claims matched' + (related ? ': ' + related : ''), 160 - tail.length) + tail;
}

function answerNumber(answer, type, field, maximum, name) {
  const value = answer?.[field];
  if (answer?.type !== type || !Number.isFinite(value) || value < 0 || value > maximum)
    throw new TypeError('Invalid ' + name + '.' + field);
  return value;
}

export function proposalsFrom(answers, facts, { tag, evidenceId, weightKey }) {
  const proposals = [], unassessable = [];
  for (const [i, fact] of facts.entries()) {
    const key = weightKey(tag, fact.model, fact.role);
    const assessable = answerNumber(answers['assessable_' + i], 'noul', 'noul', 1, 'assessable_' + i);
    if (assessable < ASSESSABLE_THRESHOLD) {
      unassessable.push({ key, assessable });
      continue;
    }
    const fit = answers['fit_' + i];
    const score = answerNumber(fit, 'score', 'score', 4, 'fit_' + i);
    const confidence = answerNumber(fit, 'score', 'confidence', 1, 'fit_' + i);
    proposals.push({
      key,
      target: score / 4,
      basis: basisOf(fact),
      // Jev confidence is uncalibrated; this is its complement, not an error estimate.
      uncertainty: round(1 - confidence, 2),
      evidence: [evidenceId + ':' + fact.role + '|' + fact.model],
    });
  }
  return { proposals, unassessable };
}
