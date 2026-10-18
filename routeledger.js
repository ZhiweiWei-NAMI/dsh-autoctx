import { createHash } from "node:crypto";
import { readFile, lstat, readlink } from "node:fs/promises";
import { resolve } from "node:path";

export const routeKey = (kind, model, effort) => [kind, model, effort ?? "default"].join("|");
export const emptyRouteLedger = () => ({ version: 1, rows: {}, consumed: [] });
export const routePrior = (ledger, key) => Object.hasOwn(ledger.rows, key) ? structuredClone(ledger.rows[key]) : undefined;

export function applyRouteFacts(ledger, key, facts, mode) {
  const fresh = facts.filter((fact) => !ledger.consumed.includes(fact.id));
  if (mode !== "auto" || !fresh.length) return { ledger, applied: false, facts: fresh.length };
  const next = structuredClone(ledger);
  const row = Object.hasOwn(next.rows, key) ? next.rows[key] : { filesSurvived: 0, testsConfirmed: 0, stops: {} };
  for (const fact of fresh) {
    if (fact.type === "file") row.filesSurvived++;
    else if (fact.type === "test") row.testsConfirmed++;
    else if (fact.type === "stop") Object.defineProperty(row.stops, fact.value, {
      value: (Object.hasOwn(row.stops, fact.value) ? row.stops[fact.value] : 0) + 1,
      enumerable: true, writable: true, configurable: true,
    });
    else throw new Error("Unsupported route fact: " + fact.type);
    next.consumed.push(fact.id);
  }
  Object.defineProperty(next.rows, key, { value: row, enumerable: true, writable: true, configurable: true });
  return { ledger: next, applied: true, facts: fresh.length };
}

export async function fileState(cwd, path) {
  const absolute = resolve(cwd, path);
  try {
    const stat = await lstat(absolute);
    const content = stat.isSymbolicLink() ? await readlink(absolute) : await readFile(absolute);
    return createHash("sha256").update(String(stat.mode & 0o777)).update("\0").update(content).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    throw error;
  }
}

export function verifiedRouteFacts(entry, { currentFiles, diffFiles, rootGraph }) {
  const facts = [{ id: entry.id + ":stop", type: "stop", value: entry.stopReason }];
  for (const [path, hash] of entry.files)
    if (diffFiles.has(path) && currentFiles.get(path) === hash)
      facts.push({ id: entry.id + ":file:" + path + ":" + hash, type: "file", value: path });
  for (const command of entry.tests) {
    const runs = Object.hasOwn(rootGraph.tests, command) ? rootGraph.tests[command].runs : [];
    const latest = runs.filter((run) => run.via === undefined && run.event > entry.at).at(-1);
    if (latest?.outcome === "pass")
      facts.push({ id: entry.id + ":test:" + command, type: "test", value: command });
  }
  return facts;
}
