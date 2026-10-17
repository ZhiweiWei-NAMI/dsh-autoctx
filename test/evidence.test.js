import test from "node:test";
import assert from "node:assert/strict";
import { contributionFacts, learningQuestions, proposalsFrom } from "../learning.js";
import { failureExcerpt, advisorBrief, adviceQuestion } from "../briefs.js";
import { segmentUnits, segmentPreview } from "../segments.js";
import { planSelection, renderSelection, droppedUnitLine } from "../decisions.js";
import { weightKey } from "../ledger.js";

const graph = {
  sequence: 20,
  files: { "src/app/widget.py": { reads: [], edits: [{ event: 12, step: 5 }, { event: 3, step: 1 }] } },
  tests: { "pytest testing/test_widget.py::test_render": { runs: [{ outcome: "fail", event: 2 }, { outcome: "pass", event: 14 }] } },
};
const entry = (text, at = 10) => ({
  role: "reviewer", model: "glm-5.3-flash", children: 1, completed: 1, calls: 4, usd: 0.0012, ms: 11000, input: 1000, cacheRead: 900,
  reports: [{ verdict: "DEFECTS", text, at }],
});

test("a claim is paired with the later edits and test runs it names; an unrelated claim is unmatched", () => {
  const fact = contributionFacts(entry("DEFECTS\n- `render()` in widget.py reads the size before the update\n- Docs are thin"), graph);
  const [named, vague] = fact.reports[0].claims;
  assert.deepEqual(named.related.editsAfter, [{ path: "src/app/widget.py", count: 1 }]);
  assert.deepEqual(named.related.testRunsAfter, [{ key: "pytest testing/test_widget.py::test_render", outcomes: ["pass"] }]);
  assert.deepEqual(vague.related, { editsAfter: [], testRunsAfter: [] });
  assert.equal(fact.reports[0].unmatched, 1);
});

test("an unassessable contribution is no observation: no proposal, so weight and count stay", () => {
  const facts = [contributionFacts(entry("Looks fine overall."), graph), contributionFacts(entry("- widget.py `render()` is wrong"), graph)];
  const questions = learningQuestions(facts, { tag: "bugfix", need: "quality" });
  assert.deepEqual(Object.keys(questions), ["assessable_0", "fit_0", "assessable_1", "fit_1"]);
  assert.equal(questions.fit_0.criteria.some((level) => /insufficient/i.test(level)), false);
  const answers = {
    assessable_0: { type: "noul", noul: 0.2 },
    fit_0: { type: "score", score: 2, confidence: 0.3 },
    assessable_1: { type: "noul", noul: 0.8 },
    fit_1: { type: "score", score: 3.2, confidence: 0.7 },
  };
  const { proposals, unassessable } = proposalsFrom(answers, facts, { tag: "bugfix", evidenceId: "turn:s:1", weightKey });
  assert.deepEqual(unassessable, [{ key: weightKey("bugfix", "glm-5.3-flash", "reviewer"), assessable: 0.2 }]);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].target, 0.8);
  assert.ok(proposals[0].basis.length <= 160);
});

test("the advisor brief keeps the decisive failure line from the middle and trims the ledger first", () => {
  const output = [...Array(200).fill("collected ok"), "E   AssertionError: size 3 != 4", ...Array(200).fill("noise"), "== 1 failed in 0.3s =="].join("\n");
  const failure = failureExcerpt(output, { maxChars: 600 });
  assert.match(failure, /E {3}AssertionError: size 3 != 4/);
  assert.match(failure, /1 failed/);
  const brief = advisorBrief({
    prompt: "ADVISOR",
    question: adviceQuestion("repeated failure: pytest t.py", { attempts: 2 }),
    failure, diff: "d".repeat(3000), context: "c".repeat(3000), attempts: "Run 1: fail", task: "t".repeat(3000), ledger: "l".repeat(9000),
    maxChars: 9000,
  });
  assert.ok(brief.length <= 9000);
  assert.ok(brief.startsWith("ADVISOR\n\n## Question\n`pytest t.py` still fails after 2"));
  assert.ok(brief.includes("E   AssertionError: size 3 != 4"));
  assert.ok(brief.indexOf("## Observed failure") < brief.indexOf("## Current change (diff)"));
  assert.ok(!brief.includes("l".repeat(9000)));
});

test("a long pytest output is split into sections, so the failure in the middle is its own candidate", () => {
  const text = ["=== test session starts ===", ...Array(60).fill("testing/test_a.py ....."), "=================================== FAILURES ===================================",
    "_____________________ test_render _____________________", "    def test_render():", ">       assert render() == 4", "E       assert 3 == 4", ...Array(60).fill("log line")].join("\n");
  const unit = { id: "event_5_block_0", position: 5, kind: "tool/text", tool: "bash", argument: "pytest", text: JSON.stringify({ type: "text", text }), required: false };
  const segments = segmentUnits([unit]);
  const failing = segments.find((segment) => segment.text.includes("E       assert 3 == 4"));
  assert.ok(failing && !failing.text.includes("test session starts"));
  assert.ok(segmentPreview(failing, ["test_render"]).includes("E       assert 3 == 4"));
});

test("selection keeps one copy of a duplicate and pulls in the definition a kept report needs, though judged low", () => {
  const units = [
    { id: "src", position: 1, kind: "tool/text", text: JSON.stringify({ type: "text", text: "def render():\n    return size()\n" }), required: false },
    { id: "run1", position: 2, kind: "tool/text", text: JSON.stringify({ type: "text", text: "Traceback (most recent call last):\nValueError in render()\n" }), required: false },
    { id: "run2", position: 3, kind: "tool/text", text: JSON.stringify({ type: "text", text: "Traceback (most recent call last):\nValueError in render()\n" }), required: false },
  ];
  const segments = segmentUnits(units);
  const ids = segments.map((segment) => segment.id);
  const judgments = ids.map((id) => ({ source: id, importance: { score: id.startsWith("src") ? 0 : 2 } }));
  const plan = planSelection({ segments, judgedIds: ids, judgments, keepBudget: 1000, tokensOf: (segment) => segment.text.length / 4 });
  assert.deepEqual(plan.keptIds, ["src#0", "run2#0"]);
  const rendered = renderSelection(units, segments, plan.keptIds, droppedUnitLine);
  assert.equal(rendered.blocks.length, 2);
  assert.equal(rendered.dropped.length, 1);
});
