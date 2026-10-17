import test from "node:test";
import assert from "node:assert/strict";
import {
  createGraph,
  observe,
  digest,
  progressKey,
  editsAfter,
  hasRead,
  merge,
  fromJSON,
} from "../graph.js";

const call = (name, args) => ({
  name,
  arguments: typeof args === "string" ? args : JSON.stringify(args),
});
const ok = (text = "") => ({ isError: false, text });
const ranges = (file) => file.reads.map(({ from, to, step }) => [from, to, step]);
const edit = (path, snippet) =>
  call("edit", { file_path: path, old_string: "a", new_string: snippet });

test("observe classifies bash read, search, test, inspect and command segments", () => {
  const graph = createGraph();
  observe(graph, 1, call("bash", { command: "cd /repo && sed -n '40,80p' src/a.js" }), ok(""));
  observe(graph, 2, call("bash", { command: "cat src/b.js && grep -n handle src/a.js" }), ok(""));
  observe(graph, 3, call("bash", { command: "pytest -q tests/test_x.py" }), ok("3 failed, 10 passed in 0.4s"));
  observe(graph, 4, call("bash", { command: "git diff --stat" }), ok("src/a.js | 2 ++"));
  observe(graph, 5, call("bash", { command: "make build" }), ok(""));

  assert.deepEqual(ranges(graph.files["src/a.js"]), [[40, 80, 1]]);
  assert.deepEqual(ranges(graph.files["src/b.js"]), [[1, null, 2]]);
  assert.deepEqual(
    graph.searches.map((s) => [s.pattern, s.path]),
    [["handle", "src/a.js"]],
  );
  const runs = Object.values(graph.tests)[0].runs;
  assert.equal(runs[0].outcome, "fail");
  assert.match(runs[0].summary, /3 failed, 10 passed/);
  assert.equal(graph.commands.at(-1).command, "make build");
  assert.equal(graph.commands.at(-2).command, "git diff --stat");
  assert.equal(hasRead(graph, "src/a.js"), true);
  assert.equal(hasRead(graph, "src/z.js"), false);
});

test("bash assigns ordered summaries to piped test runs", () => {
  const graph = createGraph();
  const command = "cd /testbed && python -m pytest testing/test_mark.py -q 2>&1 | tail -4 && python -m pytest testing/test_metafunc.py testing/test_nodes.py -q 2>&1 | tail -4";
  const result = "...x....  [100%]\n91 passed, 1 xfailed in 3.05s\nERROR: file or directory not found: testing/test_metafunc.py\n\n\nno tests ran in 0.00s\n";
  observe(graph, 1, call("bash", { command }), ok(result));
  assert.deepEqual(Object.keys(graph.tests), [
    "python -m pytest testing/test_mark.py -q",
    "python -m pytest testing/test_metafunc.py testing/test_nodes.py -q",
  ]);
  assert.deepEqual(Object.values(graph.tests).map(({ runs }) => [runs[0].outcome, runs[0].summary]), [
    ["pass", "91 passed, 1 xfailed"],
    ["unknown", "no tests ran"],
  ]);
  assert.deepEqual(graph.commands, []);
});

test("bash assigns the last summary only to the last test when counts differ", () => {
  const graph = createGraph();
  const command = "pytest first.py && pytest second.py";
  observe(graph, 1, call("bash", { command }), ok("2 passed in 1s"));
  assert.deepEqual(Object.values(graph.tests).map(({ runs }) => runs.at(-1).outcome), ["unknown", "pass"]);
  observe(graph, 2, call("bash", { command }), ok("2 passed in 1s\n1 error in 1s\nInterrupted: 1 error during collection"));
  assert.deepEqual(Object.values(graph.tests).map(({ runs }) => [runs.at(-1).outcome, runs.at(-1).summary]), [
    ["unknown", ""],
    ["error", "Interrupted: 1 error during collection"],
  ]);
});

test("bash records a heredoc edit and the failing test after its body", () => {
  const graph = createGraph();
  const command = "cd /testbed && cat > changelog/10324.bugfix.rst <<'EOF'\nFixed missing marks for classes that inherit from multiple classes.\nEOF\npython -m pytest testing/test_mark.py -q -k \"inherited\" 2>&1 | tail -8";
  const result = "FAILED testing/test_mark.py::TestFunctional::test_mark_inherited_no_leak_to_sibling\n1 failed, 2 passed, 89 deselected in 0.25s";
  observe(graph, 1, call("bash", { command }), ok(result));
  assert.deepEqual(editsAfter(graph, 0), [{ path: "changelog/10324.bugfix.rst", step: 1 }]);
  assert.deepEqual(graph.files["changelog/10324.bugfix.rst"].editSnippets, []);
  assert.deepEqual(Object.keys(graph.tests), ['python -m pytest testing/test_mark.py -q -k "inherited"']);
  assert.equal(Object.values(graph.tests)[0].runs[0].outcome, "fail");
  assert.deepEqual(graph.commands, []);
  assert.doesNotMatch(digest(graph), /command tail|2>&1/);
});

test("bash drops redirections from test keys and ignores pipeline filters", () => {
  const graph = createGraph();
  observe(graph, 1, call("bash", { command: "pytest -q 2>&1 | tail -8 | cat" }), ok("1 passed"));
  observe(graph, 2, call("bash", { command: "pytest -q >/dev/null" }), ok("1 passed"));
  observe(graph, 3, call("bash", { command: "pytest -q > file" }), ok("1 passed"));
  assert.deepEqual(Object.keys(graph.tests), ["pytest -q"]);
  assert.equal(graph.tests["pytest -q"].runs.length, 3);
  assert.deepEqual(graph.commands, []);
  assert.deepEqual(editsAfter(graph, 0), [{ path: "file", step: 3 }]);
});

test("bash records shell writes without interpreting heredoc bodies or quoted operators", () => {
  const graph = createGraph();
  const command = `cat > first.txt <<EOF
pytest fake.py && echo fake > fake.txt
EOF
cat >> second.txt <<"END"
ls fake
END
tee third.txt; sed -i 's/old/new/' fourth.txt
echo 'literal > ignored.txt | pytest fake.py' > "fifth file.txt"
echo ignored > /tmp/ignored; tee /dev/null`;
  observe(graph, 1, call("bash", { command }), ok());
  assert.deepEqual(editsAfter(graph, 0).map(({ path }) => path), [
    "first.txt", "second.txt", "third.txt", "fourth.txt", "fifth file.txt",
  ]);
  assert.ok(Object.values(graph.files).every((file) => !file.reads.length && !file.editSnippets.length));
  assert.deepEqual(graph.tests, {});
  assert.deepEqual(graph.searches, []);
  assert.deepEqual(graph.commands, []);
});

test("bash renders directory listings as list entries", () => {
  const graph = createGraph();
  observe(graph, 1, call("bash", { command: "ls changelog" }), ok("10324.bugfix.rst"));
  assert.equal(digest(graph), "list changelog");
  assert.equal(digest(fromJSON(JSON.stringify(graph))), "list changelog");
});

test("observe merges read windows, marks edits stale and keeps edit snippets", () => {
  const graph = createGraph();
  observe(graph, 1, call("read", { file_path: "src/a.js", offset: 1, limit: 80 }), ok(""));
  observe(graph, 2, call("read", { file_path: "src/a.js", offset: 120, limit: 81 }), ok(""));
  observe(graph, 3, call("bash", { command: "cat src/b.js" }), ok(""));
  assert.equal(digest(graph), "read L1-80, 120-200 src/a.js\nread whole src/b.js");
  observe(graph, 4, edit("src/a.js", "const x = 1;"), ok(""));
  assert.deepEqual(editsAfter(graph, 3), [{ path: "src/a.js", step: 4 }]);
  assert.deepEqual(editsAfter(graph, 4), []);
  assert.equal(hasRead(graph, "src/a.js"), true);
  assert.equal(
    digest(graph),
    "edit src/a.js steps 4 const x = 1;\nread L1-80, 120-200 (stale) src/a.js\nread whole src/b.js",
  );
});

test("digest orders edited files before tests before reads, truncates on a line and is deterministic", () => {
  const graph = createGraph();
  observe(graph, 1, call("read", { file_path: "src/a.js", limit: 80 }), ok(""));
  observe(graph, 2, call("bash", { command: "pytest -q" }), ok("10 passed in 1s"));
  observe(graph, 3, call("bash", { command: "pytest -q slow.py" }), ok("1 failed, 2 passed"));
  observe(graph, 4, edit("src/b.js", "x"), ok(""));
  observe(graph, 5, call("bash", { command: "rg TODO src" }), ok(""));

  const lines = digest(graph).split("\n");
  assert.match(lines[0], /^edit src\/b\.js steps 4/);
  assert.match(lines[1], /^test fail pytest -q slow\.py: 1 failed, 2 passed/);
  assert.match(lines[2], /^test pass pytest -q: 10 passed/);
  assert.match(lines[3], /^read .* src\/a\.js$/);
  assert.match(lines[4], /^search TODO in src/);

  const long = createGraph();
  for (let i = 0; i < 40; i++)
    observe(long, i + 1, call("read", { file_path: `src/f${String(i).padStart(2, "0")}.js` }), ok(""));
  const truncated = digest(long, 200);
  assert.ok(truncated.length <= 200);
  assert.match(truncated.split("\n").at(-1), /^… \d+ more entries$/);
  assert.equal(truncated, digest(long, 200));
  assert.equal(digest(graph), digest(graph));
});

test("progressKey tracks new evidence only", () => {
  const graph = createGraph();
  observe(graph, 1, call("read", { file_path: "src/a.js", limit: 10 }), ok(""));
  const afterRead = progressKey(graph);
  observe(graph, 2, call("read", { file_path: "src/a.js", limit: 5 }), ok(""));
  assert.equal(progressKey(graph), afterRead);
  observe(graph, 3, call("read", { file_path: "src/a.js", offset: 50, limit: 5 }), ok(""));
  const afterRange = progressKey(graph);
  assert.notEqual(afterRange, afterRead);

  const tests = createGraph();
  observe(tests, 1, call("bash", { command: "pytest -q" }), ok("2 failed, 1 passed"));
  const afterFail = progressKey(tests);
  observe(tests, 2, call("bash", { command: "pytest -q" }), ok("2 failed, 1 passed"));
  assert.equal(progressKey(tests), afterFail);
  observe(tests, 3, call("bash", { command: "pytest -q" }), ok("3 passed"));
  assert.notEqual(progressKey(tests), afterFail);

  observe(graph, 4, edit("src/a.js", "y"), ok(""));
  assert.notEqual(progressKey(graph), afterRange);
});

test("merge folds a child graph into the parent and keeps the child label", () => {
  const parent = createGraph();
  observe(parent, 1, call("read", { file_path: "src/p.js", limit: 3 }), ok(""));
  const child = createGraph();
  observe(child, 1, call("read", { file_path: "src/c.js", limit: 2 }), ok(""));
  observe(child, 2, call("bash", { command: "npm test" }), ok("1 passed in 0.2s"));
  merge(parent, child, "child-1");
  assert.equal(parent.files["src/c.js"].reads[0].via, "child-1");
  assert.equal(parent.files["src/p.js"].reads[0].via, undefined);
  assert.deepEqual(ranges(parent.files["src/c.js"]), [[1, 2, 1]]);
  assert.equal(Object.values(parent.tests)[0].runs[0].outcome, "pass");
  assert.equal(Object.values(parent.tests)[0].runs[0].via, "child-1");
});

test("fromJSON restores a graph and ignores garbage", () => {
  assert.deepEqual(fromJSON("not json"), createGraph());
  assert.deepEqual(fromJSON(null), createGraph());
  assert.deepEqual(fromJSON(42), createGraph());
  const stored = fromJSON(
    JSON.stringify({
      files: { "src/a.js": { reads: [[1, 20, 1], "junk"], edits: [2], editSnippets: ["x"] } },
      searches: [{ pattern: "p", path: "src", step: 3 }, null],
      tests: { "pytest -q": { runs: [{ step: 4, outcome: "pass", summary: "1 passed" }] } },
      commands: [{ command: "make", step: 5 }],
      steps: 6,
      unknown: { ignored: true },
    }),
  );
  assert.deepEqual(ranges(stored.files["src/a.js"]), [[1, 20, 1]]);
  assert.equal(stored.files["src/a.js"].reads[0].via, undefined);
  assert.equal(stored.searches.length, 1);
  assert.equal(stored.tests["pytest -q"].runs[0].outcome, "pass");
  assert.equal(stored.steps, 6);
  assert.equal(stored.unknown, undefined);
});

test("malformed calls and arguments are ignored without throwing", () => {
  const graph = createGraph();
  observe(graph, 1, call("read", "{not json"), ok(""));
  observe(graph, 1, call("read", "[]"), ok(""));
  observe(graph, 1, call("edit", "{oops"), ok(""));
  observe(graph, 1, { name: 7, arguments: {} }, ok(""));
  // A call with no arguments must not add evidence but must still be observed.
  observe(graph, 1, call("grep", "[[["), ok(""));
  observe(graph, 1, { name: "read", arguments: {} }, ok(""));
  observe(graph, 1, undefined, undefined);
  assert.deepEqual(graph.files, {});
  assert.deepEqual(graph.searches, []);
  assert.deepEqual(graph.commands, []);
  assert.equal(graph.steps, 1);
});
