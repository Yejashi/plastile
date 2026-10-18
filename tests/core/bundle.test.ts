// The bundle KWin loads: built in memory with the build's own options (tools/bundle-options.ts)
// and checked for what QV4 reports as qt.qml.usedbeforedeclared at load (tools/qv4check.ts).
// The first physical session (KWin 6.7.5, Qt 6.12.0) logged five such warnings; the checker
// finds exactly those five in that bundle (MAX_ZONE_ID, TOP_KEYS, CONTEXT_KEYS, MASTER_KEYS,
// FLOAT_KEYS) and none in the current one. KWin's own log is the oracle in nested scenarios.

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { BUNDLE_OPTIONS } from "../../tools/bundle-options.ts";
import { usedBeforeDeclaration } from "../../tools/qv4check.ts";

test("the bundle has no variable used above its declaration (QV4 qt.qml.usedbeforedeclared)", async () => {
  const r = await build({ ...BUNDLE_OPTIONS, write: false, outfile: "plastile.mjs" });
  const code = r.outputFiles![0].text;
  assert.ok(code.length > 10000 && code.indexOf("createRuntime") >= 0, "bundled the runtime");
  assert.deepEqual(usedBeforeDeclaration(code).map((e) => `${e.name} line ${e.ref.line} (declared line ${e.decl.line})`), []);
});

test("the checker reports what QV4 reports and nothing else", () => {
  const code = [
    "function early() { return LIMIT + later(); }", // LIMIT: reported; later(): a function, hoisted
    "const LIMIT = 1;",
    "function later() { return LIMIT; }",            // after the declaration: fine
    "function shadow(LIMIT2) { return LIMIT2; }",    // a parameter, not the module binding
    "var LIMIT2 = 2;",
    "function obj(o) { return { KEYS, n: o.KEYS2, KEYS3: 1 }; }", // shorthand is a reference; property names are not
    "let KEYS = [], KEYS2 = 0, KEYS3 = 0;",
    "function inner() { var x = y; var y = 1; return x; }", // a local var too
    "function useClass() { return new Engine(); }",
    "var Engine = class {};",
    "export { early, later, shadow, obj, inner, useClass, LIMIT };",
  ].join("\n");
  assert.deepEqual(usedBeforeDeclaration(code).map((e) => `${e.name}@${e.ref.line}`),
    ["LIMIT@1", "KEYS@6", "y@8", "Engine@9"]);
});
