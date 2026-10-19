// QV4-level checks of the iteration rule (docs/validation/PERFORMANCE.md §7.1). They run code in
// KWin's JavaScript engine through the qml tool (tests/core/qv4.ts: offscreen, no compositor, no
// KWin), because QV4's for...of over a Map or Set differs from ECMAScript only there: Node runs
// V8, which follows the specification, so an ordinary unit test cannot see the difference.
//
// Without a Qt 6 qml tool (tests/core/qv4.ts says where it looks) these tests are skipped and say so,
// unless PLASTILE_REQUIRE_QV4=1: then they fail (CI's native-tools job sets it).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { qmlCandidates, qmlTool, requireQv4, runInQv4, runQml, type QmlTool } from "./qv4.ts";
import { runAll } from "./qv4Scenarios.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const found = qmlTool();
const skip = found || requireQv4() ? false : "no Qt 6 qml tool (set PLASTILE_QML or install qml6): QV4 iteration checks not run";

/** The qml tool; with PLASTILE_REQUIRE_QV4=1 and none found, the test fails here instead of being skipped. */
function need(): QmlTool {
  if (!found) assert.fail(`PLASTILE_REQUIRE_QV4=1 but no Qt 6 qml tool runs here (tried ${qmlCandidates().join(", ")})`);
  return found;
}

type Visits = Record<string, Record<string, string>>;

/** probes/perf/qv4iter/cases.js in V8, as probes/perf/qv4iter/run.py loads it. */
function casesInV8(): Visits {
  const src = readFileSync(resolve(ROOT, "probes/perf/qv4iter/cases.js"), "utf8").replace(".pragma library", "");
  return new Function(src + "\nreturn results();")() as Visits;
}

test("QV4 iteration under mutation: forEach and arrays follow ECMAScript (what the rule relies on)", { skip }, (t) => {
  const tool = need();
  const qv4 = runQml(resolve(ROOT, "probes/perf/qv4iter/main.qml"), "qv4iter", tool) as Visits;
  const v8 = casesInV8();
  const differs: string[] = [];
  for (const c of Object.keys(v8)) {
    for (const kind of Object.keys(v8[c])) {
      const allowed = kind.endsWith("forEach") || kind.startsWith("array-");
      if (allowed) assert.equal(qv4[c][kind], v8[c][kind], `${c} / ${kind}: QV4 ${qv4[c][kind]}, ECMAScript ${v8[c][kind]}`);
      else if (qv4[c][kind] !== v8[c][kind]) differs.push(`${c} / ${kind}`);
    }
  }
  // Insertion never differs (measured): entries added during the loop are visited in every form.
  for (const c of ["add-new", "add-two", "add-at-last", "set-existing"]) {
    for (const kind of Object.keys(v8[c])) assert.equal(qv4[c][kind], v8[c][kind], `${c} / ${kind}`);
  }
  // The deviation itself is reported, not required: a later Qt may fix it; the rule stays valid.
  t.diagnostic(`${tool.version}: Map/Set iterator walks (for...of, next(), yield*, Array.from) differ from ECMAScript in ${differs.length} cases`
    + (differs.length ? ` (e.g. ${differs[0]})` : " (none: this Qt may have fixed it)"));
});

test("engine scenarios: QV4 gives the ECMAScript outcome wherever a loop's collection changes under it", { skip }, async () => {
  const tool = need();
  const v8 = runAll() as Record<string, { ok: boolean }>;
  const qv4 = (await runInQv4(resolve(ROOT, "tests/core/qv4Scenarios.ts"), "runAll", tool)) as Record<string, { ok: boolean }>;
  assert.deepEqual(Object.keys(qv4), Object.keys(v8));
  for (const name of Object.keys(v8)) {
    assert.ok(v8[name].ok, `${name} in V8: ${JSON.stringify(v8[name])}`);
    assert.deepEqual(qv4[name], v8[name], `${name}: QV4 differs from V8`);
  }
});
