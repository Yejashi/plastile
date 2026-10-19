// The engine scenarios of tests/core/qv4Scenarios.ts in QV4 (the qml tool, offscreen; KWin's
// JavaScript engine without KWin) and in Node (V8, ECMAScript), side by side.
//
// With --rev REV the scenarios run against another commit's src/: `git archive REV src` is
// unpacked into a temporary tree next to this tree's scenario files (tests/core/qv4Scenarios.ts
// and the fakes it imports), so one scenario set compares the code before and after a change.
// The layer is QV4 in the qml tool, not KWin, not nested.
//
// Usage: node probes/perf/qv4iter/engine.ts [--rev REV] [--out FILE]
// Exit 0 always; the table is the result.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { qmlTool, runInQv4 } from "../../../tests/core/qv4.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const FILES = ["tests/core/qv4Scenarios.ts", "tests/core/mockHost.ts", "tests/core/fakeKwin.ts"];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const rev = arg("--rev");
const out = arg("--out");
const tool = qmlTool();
if (!tool) {
  console.error("no qml tool (set PLASTILE_QML, or install qml6)");
  process.exit(0);
}

let root = ROOT;
let tmp: string | null = null;
let commit = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
let dirty = execFileSync("git", ["-C", ROOT, "status", "--porcelain", "--", "src"], { encoding: "utf8" }).trim() !== "";
if (rev) {
  commit = execFileSync("git", ["-C", ROOT, "rev-parse", rev], { encoding: "utf8" }).trim();
  dirty = false;
  tmp = mkdtempSync(join(tmpdir(), "plastile-qv4rev-"));
  const tar = execFileSync("git", ["-C", ROOT, "archive", "--format=tar", commit, "src"]);
  execFileSync("tar", ["-x", "-C", tmp], { input: tar });
  for (const f of FILES) {
    mkdirSync(dirname(join(tmp, f)), { recursive: true });
    copyFileSync(join(ROOT, f), join(tmp, f));
  }
  root = tmp;
}

try {
  const entry = join(root, "tests/core/qv4Scenarios.ts");
  const v8 = (await import(pathToFileURL(entry).href)).runAll() as Record<string, { ok: boolean }>;
  const qv4 = (await runInQv4(entry, "runAll", tool)) as Record<string, { ok: boolean }>;
  const rows = Object.keys(v8).map((name) => ({
    scenario: name,
    qv4Ok: qv4[name]?.ok === true,
    v8Ok: v8[name].ok === true,
    same: JSON.stringify(qv4[name]) === JSON.stringify(v8[name]),
    qv4: qv4[name],
    v8: v8[name],
  }));
  console.log(`src at ${commit.slice(0, 12)}${dirty ? " (+ uncommitted src/ changes)" : ""}; ${tool.version}; node ${process.version}`);
  console.log(`${"scenario".padEnd(30)} ${"QV4".padEnd(6)} ${"V8".padEnd(6)} same`);
  for (const r of rows) {
    console.log(`${r.scenario.padEnd(30)} ${(r.qv4Ok ? "ok" : "FAIL").padEnd(6)} ${(r.v8Ok ? "ok" : "FAIL").padEnd(6)} ${r.same ? "yes" : "NO"}`);
  }
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, JSON.stringify({
      probe: "probes/perf/qv4iter/engine.ts",
      layer: "QV4 in the qml tool (offscreen) and V8 in Node; not KWin, not nested",
      srcCommit: commit, srcDirty: dirty, qml: tool.version, node: process.version, rows,
    }, null, 1) + "\n");
  }
} finally {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}
