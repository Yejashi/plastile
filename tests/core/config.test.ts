import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.ts";
import type { WindowMeta } from "../../src/core/types.ts";
import {
  compileConfig, formatError, resolveContext, resolveWindow, ruleCacheKey,
  type CompileResult, type ConfigSnapshot, type ContextInfo,
} from "../../src/config/index.ts";
import { globMatch } from "../../src/config/matchers.ts";

// CONFIGURATION §2 example, verbatim.
const DOC_EXAMPLE = {
  schemaVersion: 1,
  defaults: {
    enabled: true,
    layout: "master-stack",
    gaps: { inner: 8, outer: { top: 8, right: 8, bottom: 8, left: 8 } },
    masterStack: { ratio: 0.55, masterCount: 1, insert: "after-focus" },
    bsp: { insert: "focused", axis: "alternate", initialRatio: 0.5 },
    overflow: "float-new",
    followOnSend: false,
    multiContextWindows: "float",
    animation: { enabled: false, durationMs: 0 },
  },
  overrides: [
    { id: "wide-display", match: { outputName: "DP-1" }, set: { masterStack: { ratio: 0.6 } } },
    { id: "writing-desktop", match: { desktopName: "Writing" }, set: { layout: "monocle" } },
  ],
  rules: [
    { id: "float-dialogs", priority: 100, match: { windowType: "dialog" }, actions: { mode: "floating" } },
    { id: "terminal-borders", priority: 20, match: { appId: "org.kde.konsole" }, actions: { border: "normal" } },
  ],
  diagnostics: { level: "warn", traceCapacity: 2048 },
};

const CTX: ContextInfo = { outputName: "HDMI-A-1", desktopId: "d-uuid-1", desktopName: "Main", activityId: "a-uuid-1" };

function meta(patch: Partial<WindowMeta> = {}): WindowMeta {
  return {
    appId: "org.kde.dolphin", resourceName: "dolphin", title: "Home — Dolphin", role: "", kind: "normal",
    transient: false, transientFor: null, modal: false, special: false, managed: true, resizeable: true,
    moveable: true, skipTaskbar: false, pid: 100, own: false, ...patch,
  };
}

function ok(r: CompileResult): ConfigSnapshot {
  if (!r.ok) assert.fail(`expected success, got ${r.errors.map(formatError).join("; ")}`);
  return r.snapshot;
}

function json(doc: unknown, extra: Record<string, unknown> = {}): ConfigSnapshot {
  return ok(compileConfig({ configJson: JSON.stringify(doc), ...extra }, 1));
}

/** Compiles, expects failure, and returns "path: message" strings. */
function errors(flat: Record<string, unknown>): string[] {
  const r = compileConfig(flat, 1);
  if (r.ok) assert.fail("expected validation failure");
  return r.errors.map(formatError);
}

function docErrors(doc: unknown): string[] {
  return errors({ configJson: JSON.stringify(doc) });
}

function hasError(list: string[], prefix: string) {
  assert.ok(list.some((e) => e.startsWith(prefix)), `no error starting "${prefix}" in ${JSON.stringify(list)}`);
}

test("empty input yields built-in defaults", () => {
  const s = ok(compileConfig({}, 7));
  assert.equal(s.revision, 7);
  assert.deepEqual(s.defaults, DEFAULT_SETTINGS);
  assert.notEqual(s.defaults, DEFAULT_SETTINGS, "snapshot owns a frozen copy");
  assert.ok(Object.isFrozen(s.defaults) && Object.isFrozen(s.defaults.gaps.outer));
  assert.ok(!Object.isFrozen(DEFAULT_SETTINGS), "shared defaults are untouched");
  assert.equal(s.traceCapacity, 2048);
  assert.equal(s.diagnostics, "warn");
  assert.equal(s.usesTitleRules, false);
  assert.deepEqual(resolveContext(s, CTX).chain, ["builtin"]);
  // Missing KConfig keys arrive as undefined/null/"".
  assert.deepEqual(ok(compileConfig({ layout: "", gapInner: null, configJson: "  ", masterRatio: undefined }, 1)).defaults, DEFAULT_SETTINGS);
});

test("flat keys coerce KConfig strings and booleans", () => {
  const s = ok(compileConfig({
    layout: "bsp", gapInner: "4", gapOuter: 12, masterRatio: "0.6", masterCount: "2", masterInsert: "end",
    bspInsert: "last", bspAxis: "longest", singleWindowGaps: "false", ratioStep: " 0.1 ", traceCapacity: "4096",
    diagnostics: "debug",
  }, 1));
  assert.equal(s.defaults.layout, "bsp");
  assert.deepEqual(s.defaults.gaps, { inner: 4, outer: { top: 12, right: 12, bottom: 12, left: 12 } });
  assert.deepEqual(s.defaults.masterStack, { ratio: 0.6, masterCount: 2, insert: "end", ratioStep: 0.1 });
  assert.deepEqual(s.defaults.bsp, { insert: "last", axis: "longest", initialRatio: 0.5, ratioStep: 0.1 });
  assert.equal(s.defaults.singleWindowGaps, false);
  assert.equal(s.traceCapacity, 4096);
  assert.equal(s.diagnostics, "debug");
  assert.deepEqual(resolveContext(s, CTX).chain, ["builtin", "flat"]);
  assert.equal(ok(compileConfig({ singleWindowGaps: true }, 1)).defaults.singleWindowGaps, true);
});

test("flat key errors name the key (Q01)", () => {
  const e = errors({
    layout: "spiral", gapInner: "8px", gapOuter: 201, masterRatio: "1", masterCount: 2.5, singleWindowGaps: "yes",
    ratioStep: 0, traceCapacity: 10, diagnostics: "verbose", bspAxis: 3, configJson: 5,
  });
  for (const p of ["layout:", "gapInner: must be a number", "gapOuter: must be an integer in 0..200",
    "masterRatio: must be strictly between", "masterCount: must be an integer", "singleWindowGaps: must be true or false",
    "ratioStep:", "traceCapacity: must be an integer in 64..65536", "diagnostics:", "bspAxis:", "configJson: must be a JSON string"]) {
    hasError(e, p);
  }
  hasError(errors({ masterRatio: NaN }), "masterRatio: must be a finite number");
  hasError(errors({ gapInner: "NaN" }), "gapInner: must be a number");
  hasError(errors({ gapInner: "0x10" }), "gapInner: must be a number");
  hasError(errors({ masterRatio: Infinity }), "masterRatio: must be a finite number");
  // Unknown flat keys are leftovers from other versions: warning, not failure. This covers
  // compileConfig only: in KWin the runtime reads FLAT_KEYS by name (readConfig cannot list a
  // group), so an unknown key never reaches the validator and is ignored without a warning.
  const r = compileConfig({ floatDialogs: true }, 1);
  assert.ok(r.ok);
  assert.deepEqual(r.warnings.map(formatError), ["floatDialogs: unknown key ignored"]);
});

test("CONFIGURATION §2 example compiles", () => {
  const r = compileConfig({ configJson: JSON.stringify(DOC_EXAMPLE) }, 3);
  const s = ok(r);
  assert.deepEqual(r.ok && r.warnings, []);
  assert.deepEqual(s.defaults, DEFAULT_SETTINGS);
  assert.equal(s.traceCapacity, 2048);
  assert.equal(s.diagnostics, "warn");
  assert.equal(s.defaults.followOnSend, false);
  assert.ok(!("animation" in s.defaults) && !("multiContextWindows" in s.defaults), "inert fields are not surfaced");
  assert.deepEqual(resolveContext(s, CTX).chain, ["builtin", "json.defaults"]);
  const dp1 = resolveContext(s, { ...CTX, outputName: "DP-1" });
  assert.equal(dp1.settings.masterStack.ratio, 0.6);
  assert.deepEqual(dp1.chain, ["builtin", "json.defaults", "override wide-display"]);
  const both = resolveContext(s, { ...CTX, outputName: "DP-1", desktopName: "Writing" });
  assert.equal(both.settings.layout, "monocle");
  assert.equal(both.settings.masterStack.ratio, 0.6);
  assert.deepEqual(both.chain.slice(2), ["override wide-display", "override writing-desktop"]);
  const dlg = resolveWindow(s, meta({ kind: "dialog", appId: "org.kde.konsole" }), CTX);
  assert.deepEqual(dlg.actions, { mode: "floating", border: "normal" });
  assert.deepEqual(dlg.ruleIds, ["terminal-borders", "float-dialogs"], "priority 20 applies before 100");
  assert.deepEqual(dlg.reasons, { mode: "rule float-dialogs", border: "rule terminal-borders" });
  assert.equal(dlg.blockedBy, null);
});

test("JSON schema violations report precise paths (Q01)", () => {
  const e = docErrors({
    schemaVersion: 1,
    defaults: { gaps: { inner: -1, outer: { top: 1, middle: 2 } }, masterStack: { ratio: 1.5, masterCount: 9 }, bsp: { axis: null } },
    overrides: [{ id: "o", match: {}, set: {} }],
    rules: [
      { id: "a", match: { appId: "x" }, actions: { mode: "tiled" } },
      { id: "a", match: { appId: "y" }, actions: { mode: "floating" } },
      { id: "c", match: { appId: "z" }, actions: { colour: "red" } },
      { id: "d", match: { title: { regex: "(" } }, actions: { mode: "floating" } },
      { id: "e", match: { title: { regex: "a".repeat(257) } }, actions: { mode: "floating" } },
      { id: "f", match: { title: { regex: "x", flags: "g" } }, actions: { mode: "floating" } },
      { id: "g", match: { windowType: ["normal", "window"] }, actions: { mode: "floating" } },
      { id: "h", match: {}, actions: { mode: "floating" } },
      { id: "i", priority: "high", match: { appId: { glob: "a*", exact: "b" } }, actions: {} },
    ],
  });
  for (const p of [
    "defaults.gaps.inner: must be an integer in 0..200",
    "defaults.gaps.outer.middle: unknown key",
    "defaults.masterStack.ratio: must be strictly between 0 and 1",
    "defaults.masterStack.masterCount: must be an integer in 0..8",
    "defaults.bsp.axis: must be one of", "overrides[0].match: empty match",
    "rules[1].id: duplicate id \"a\" (also at rules[0])",
    "rules[2].actions.colour: unknown key",
    "rules[3].match.title.regex: invalid regex",
    "rules[4].match.title.regex: pattern longer than 256 characters",
    "rules[5].match.title.flags: unsupported flags",
    "rules[6].match.windowType[1]: must be one of",
    "rules[7].match: empty match",
    "rules[8].priority: must be a finite number",
    "rules[8].match.appId: matcher needs exactly one of",
  ]) hasError(e, p);
  assert.ok(e.some((x) => x.includes("null is not allowed")), "explicit null explains inheritance");

  hasError(errors({ configJson: "{ nope" }), "configJson: invalid JSON");
  hasError(errors({ configJson: "[]" }), "configJson: must be an object");
  hasError(docErrors({}), "schemaVersion: required");
  hasError(docErrors({ schemaVersion: 2 }), "schemaVersion: unsupported schema version 2");
  hasError(docErrors({ schemaVersion: 1, extra: 1 }), "extra: unknown key");
  hasError(errors({ configJson: '{"schemaVersion":1,"defaults":{"gaps":{"inner":1e999}}}' }), "defaults.gaps.inner: must be a finite number");
  hasError(docErrors({ schemaVersion: 1, defaults: { followOnSend: "yes" } }), "defaults.followOnSend: must be a boolean");
  hasError(docErrors({ schemaVersion: 1, defaults: { animation: { durationMs: 150 } } }), "defaults.animation.durationMs: not supported");
  hasError(docErrors({ schemaVersion: 1, defaults: { multiContextWindows: "tile" } }), "defaults.multiContextWindows: not supported");
  hasError(docErrors({ schemaVersion: 1, overrides: [{ id: "o", match: { outputName: "a" }, set: {}, when: 1 }] }), "overrides[0].when: unknown key");
  hasError(docErrors({ schemaVersion: 1, overrides: [{ id: "x", match: { outputName: "a" }, set: {} }, { id: "x", match: { outputName: "b" }, set: {} }] }),
    "overrides[1].id: duplicate id");
  hasError(docErrors({ schemaVersion: 1, rules: [{ id: "x".repeat(513), match: { appId: "a" }, actions: {} }] }), "rules[0].id: longer than 512");
  hasError(docErrors({ schemaVersion: 1, rules: [{ id: "r", match: { appId: "a".repeat(513) }, actions: {} }] }), "rules[0].match.appId: longer than 512");
  hasError(docErrors({ schemaVersion: 1, rules: [{ match: { appId: "a" }, actions: {} }] }), "rules[0].id: required");
  hasError(docErrors({ schemaVersion: 1, defaults: { gaps: { outer: "8" } } }), "defaults.gaps.outer: must be a number or");
  hasError(docErrors({ schemaVersion: 1, defaults: { masterStack: { ratio: 0 } } }), "defaults.masterStack.ratio: must be strictly between");
  hasError(docErrors({ schemaVersion: 1, defaults: { bsp: { initialRatio: 1 } } }), "defaults.bsp.initialRatio: must be strictly between");
});

test("list bounds: 256 rules and 64 overrides", () => {
  const rule = (i: number) => ({ id: `r${i}`, match: { appId: `a${i}` }, actions: { mode: "floating" } });
  const ov = (i: number) => ({ id: `o${i}`, match: { desktopId: `d${i}` }, set: { layout: "bsp" } });
  json({ schemaVersion: 1, rules: Array.from({ length: 256 }, (_, i) => rule(i)), overrides: Array.from({ length: 64 }, (_, i) => ov(i)) });
  hasError(docErrors({ schemaVersion: 1, rules: Array.from({ length: 257 }, (_, i) => rule(i)) }), "rules: at most 256 entries");
  hasError(docErrors({ schemaVersion: 1, overrides: Array.from({ length: 65 }, (_, i) => ov(i)) }), "overrides: at most 64 entries");
});

test("compile never throws on hostile input", () => {
  const hostile: Record<string, unknown> = {};
  Object.defineProperty(hostile, "layout", { enumerable: true, get() { throw new Error("boom"); } });
  const r = compileConfig(hostile, 1);
  assert.equal(r.ok, false);
  assert.equal(compileConfig({ configJson: '{"__proto__":{"x":1},"schemaVersion":1}' }, 1).ok, false);
  assert.equal(compileConfig({ configJson: "[".repeat(100000) }, 1).ok, false);
});

test("precedence: builtin < flat < json.defaults < overrides (Q02)", () => {
  const s = json({
    schemaVersion: 1,
    defaults: { gaps: { inner: 6 }, masterStack: { ratio: 0.5 } },
    overrides: [
      { id: "late", match: { outputName: "DP-1" }, set: { masterStack: { ratio: 0.7 } } },
      { id: "early", priority: -1, match: { outputName: "DP-1", desktopName: "Main" }, set: { masterStack: { ratio: 0.3, masterCount: 2 } } },
      { id: "act", match: { activityId: { glob: "a-uuid-*" } }, set: { gaps: { outer: { left: 0 } } } },
      { id: "nomatch", match: { outputName: "DP-1", desktopId: "other" }, set: { layout: "floating" } },
    ],
  }, { gapInner: 2, gapOuter: 10, masterRatio: 0.45, masterCount: 3 });
  assert.equal(s.defaults.gaps.inner, 6, "json.defaults beats flat");
  assert.equal(s.defaults.masterStack.ratio, 0.5);
  assert.equal(s.defaults.masterStack.masterCount, 3, "flat value survives deep merge");
  const r = resolveContext(s, { ...CTX, outputName: "DP-1" });
  assert.deepEqual(r.chain, ["builtin", "flat", "json.defaults", "override early", "override late", "override act"]);
  assert.equal(r.settings.masterStack.ratio, 0.7, "later override wins per field");
  assert.equal(r.settings.masterStack.masterCount, 2, "fields the later override omits are inherited");
  assert.deepEqual(r.settings.gaps.outer, { top: 10, right: 10, bottom: 10, left: 0 }, "number outer then partial edges");
  assert.equal(r.settings.layout, "master-stack", "AND match: one field mismatch excludes the override");
  assert.equal(resolveContext(s, { ...CTX, outputName: "DP-1" }), r, "memoized");
  const other = resolveContext(s, { ...CTX, activityId: "b" });
  assert.equal(other.settings, s.defaults);
  assert.deepEqual(other.chain, ["builtin", "flat", "json.defaults"]);
});

test("priority beats declaration order; ties keep declaration order", () => {
  const s = json({
    schemaVersion: 1,
    overrides: [
      { id: "hi", priority: 10, match: { desktopId: "d-uuid-1" }, set: { layout: "bsp" } },
      { id: "lo1", match: { desktopId: "d-uuid-1" }, set: { layout: "monocle" } },
      { id: "lo2", match: { desktopId: "d-uuid-1" }, set: { layout: "floating", gaps: { inner: 0 } } },
    ],
  });
  const r = resolveContext(s, CTX);
  assert.equal(r.settings.layout, "bsp");
  assert.equal(r.settings.gaps.inner, 0);
  assert.deepEqual(r.chain, ["builtin", "override lo1", "override lo2", "override hi"]);
});

test("rules apply per property with field-level reasons (Q02)", () => {
  const s = json({
    schemaVersion: 1,
    rules: [
      { id: "all-kde", match: { appId: { glob: "org.kde.*" } }, actions: { mode: "floating", border: "none" } },
      { id: "dolphin-tile", match: { resourceName: "dolphin" }, actions: { mode: "tiled", insert: "master" } },
      { id: "first", priority: -5, match: { appId: { regex: "^ORG\\.", flags: "i" } }, actions: { insert: "end", border: "keep" } },
      { id: "dlg", match: { windowType: ["dialog", "utility"], transient: true }, actions: { mode: "excluded" } },
    ],
  });
  const r = resolveWindow(s, meta(), CTX);
  assert.deepEqual(r.ruleIds, ["first", "all-kde", "dolphin-tile"]);
  assert.deepEqual(r.actions, { insert: "master", border: "none", mode: "tiled" });
  assert.deepEqual(r.reasons, { insert: "rule dolphin-tile", border: "rule all-kde", mode: "rule dolphin-tile" });
  assert.equal(r.blockedBy, null);
  assert.deepEqual(resolveWindow(s, meta({ appId: "firefox", resourceName: "firefox" }), CTX).ruleIds, []);
  assert.deepEqual(resolveWindow(s, meta({ appId: "firefox", resourceName: "firefox", kind: "utility", transient: true }), null).actions, { mode: "excluded" });
  assert.deepEqual(resolveWindow(s, meta({ appId: "firefox", resourceName: "firefox", kind: "utility", transient: false }), null).ruleIds, []);
  assert.deepEqual(resolveWindow(s, meta({ appId: "firefox", resourceName: "firefox", kind: "normal", transient: true }), null).ruleIds, []);
});

test("matchers: exact, glob, regex, windowType", () => {
  assert.ok(globMatch("org.kde.*", "org.kde.konsole"));
  assert.ok(globMatch("*", ""));
  assert.ok(globMatch("a?c", "abc") && !globMatch("a?c", "ac"));
  assert.ok(globMatch("*a*b*c", "xxaxxbxxc") && !globMatch("*a*b*c", "xxaxxbxxcx"), "anchored at both ends");
  assert.ok(!globMatch("ORG.*", "org.kde"), "case-sensitive");
  assert.ok(!globMatch("a*a*a*a*a*a*a*a*b", "a".repeat(2000)), "no catastrophic backtracking");
  const s = json({
    schemaVersion: 1,
    rules: [
      { id: "exact", match: { appId: "firefox" }, actions: { border: "none" } },
      { id: "exact-obj", match: { appId: { exact: "org.kde.konsole" } }, actions: { border: "keep" } },
      { id: "glob-nowild", match: { appId: { glob: "gimp" } }, actions: { border: "normal" } },
      { id: "re", match: { title: { regex: "picture-in-picture", flags: "i" } }, actions: { mode: "floating" } },
      { id: "types", match: { windowType: ["toolbar", "utility"] }, actions: { mode: "floating" } },
    ],
  });
  assert.deepEqual(resolveWindow(s, meta({ appId: "firefox" }), CTX).ruleIds, ["exact"]);
  assert.deepEqual(resolveWindow(s, meta({ appId: "firefox-esr" }), CTX).ruleIds, [], "exact is not a prefix match");
  assert.deepEqual(resolveWindow(s, meta({ appId: "org.kde.konsole" }), CTX).ruleIds, ["exact-obj"]);
  assert.deepEqual(resolveWindow(s, meta({ appId: "gimp" }), CTX).ruleIds, ["glob-nowild"]);
  assert.deepEqual(resolveWindow(s, meta({ appId: "firefox", title: "Picture-in-Picture" }), CTX).ruleIds, ["exact", "re"]);
  assert.deepEqual(resolveWindow(s, meta({ kind: "utility" }), CTX).ruleIds, ["types"]);
  assert.deepEqual(resolveWindow(s, meta({ kind: "dialog" }), CTX).ruleIds, []);
});

test("built-in exclusions cannot be overridden by rules", () => {
  const s = json({
    schemaVersion: 1,
    rules: [
      { id: "tile-everything-kde", match: { appId: { glob: "org.kde.*" } }, actions: { mode: "tiled", border: "normal" } },
      { id: "tile-docks", match: { windowType: ["dock", "normal"] }, actions: { mode: "tiled" } },
    ],
  });
  const dock = resolveWindow(s, meta({ appId: "org.kde.plasmashell", kind: "dock" }), CTX);
  assert.equal(dock.blockedBy, "kind:dock");
  assert.deepEqual(dock.actions, { mode: "excluded" });
  assert.deepEqual(dock.ruleIds, ["tile-everything-kde", "tile-docks"], "attempted rules stay in the explanation");
  assert.equal(dock.reasons.mode, "builtin kind:dock; ignored rule tile-docks");
  assert.equal(dock.reasons.border, "ignored (builtin kind:dock): rule tile-everything-kde");
  assert.equal(resolveWindow(s, meta({ special: true }), CTX).blockedBy, "special");
  assert.equal(resolveWindow(s, meta({ own: true, kind: "popup" }), CTX).blockedBy, "own");
  for (const kind of ["desktop", "notification", "tooltip", "popup", "osd", "applet-popup", "dnd-icon", "menu", "splash"] as const) {
    assert.equal(resolveWindow(s, meta({ kind }), CTX).actions.mode, "excluded", kind);
  }
  // Exclusion applies without any rules as well.
  assert.equal(resolveWindow(ok(compileConfig({}, 1)), meta({ kind: "osd" }), null).reasons.mode, "builtin kind:osd");
  assert.equal(resolveWindow(s, meta({ kind: "normal" }), CTX).actions.mode, "tiled");
});

test("title-independent cache keys and memoization (Q03)", () => {
  const noTitle = json({ schemaVersion: 1, rules: [{ id: "k", match: { appId: "org.kde.dolphin" }, actions: { mode: "floating" } }] });
  assert.equal(noTitle.usesTitleRules, false);
  const a = meta({ title: "Home — Dolphin" }), b = meta({ title: "Downloads — Dolphin" });
  assert.equal(ruleCacheKey(a, noTitle), ruleCacheKey(b, noTitle), "title change does not change the key");
  const ra = resolveWindow(noTitle, a, CTX);
  assert.equal(resolveWindow(noTitle, b, CTX), ra, "title change returns the identical cached result");
  assert.ok(Object.isFrozen(ra) && Object.isFrozen(ra.actions), "cached results cannot be mutated by callers");
  assert.notEqual(ruleCacheKey(meta({ kind: "dialog" }), noTitle), ruleCacheKey(a, noTitle));
  assert.notEqual(ruleCacheKey(meta({ appId: "a", resourceName: "bc" }), noTitle), ruleCacheKey(meta({ appId: "ab", resourceName: "c" }), noTitle));

  const withTitle = json({ schemaVersion: 1, rules: [{ id: "t", match: { title: { glob: "Home*" } }, actions: { mode: "floating" } }] });
  assert.equal(withTitle.usesTitleRules, true);
  // The shared cache holds the title-free part; only rules that use the title see it (CONFIGURATION §4).
  assert.equal(ruleCacheKey(a, withTitle), ruleCacheKey(b, withTitle), "titles never enter the shared cache key");
  assert.deepEqual(resolveWindow(withTitle, a, CTX).ruleIds, ["t"]);
  assert.deepEqual(resolveWindow(withTitle, b, CTX).ruleIds, []);

  // Bounded cache: many distinct windows never break correctness.
  for (let i = 0; i < 2000; ++i) resolveWindow(noTitle, meta({ appId: `app${i}` }), null);
  assert.ok(noTitle.compiled.ruleCache.size <= 512);
  assert.deepEqual(resolveWindow(noTitle, a, CTX).actions, { mode: "floating" });
});

test("a title change evaluates only title rules and does not churn the shared cache (CONFIGURATION §4)", () => {
  const s = json({ schemaVersion: 1, rules: [
    { id: "kde", match: { appId: { regex: "^org\\.kde\\..*$" } }, actions: { border: "none" } },
    { id: "pip", match: { title: { glob: "Picture-in-Picture*" } }, actions: { mode: "floating" } },
    { id: "konsole-busy", match: { appId: "org.kde.konsole", title: { regex: "^busy" } }, actions: { insert: "master" } },
  ] });
  for (let i = 0; i < 100; ++i) resolveWindow(s, meta({ appId: `app${i}` }), CTX);
  const cached = s.compiled.ruleCache.size;
  let appIdRegex = 0, titleRegex = 0;
  const test0 = RegExp.prototype.test;
  RegExp.prototype.test = function (this: RegExp, v: string) {
    if (this.source === "^org\\.kde\\..*$") appIdRegex++;
    if (this.source === "^busy") titleRegex++;
    return test0.call(this, v);
  };
  let last;
  try {
    for (let i = 0; i < 1000; ++i) last = resolveWindow(s, meta({ appId: "org.kde.konsole", resourceName: "konsole", title: `~ : top ${i}` }), CTX);
  } finally {
    RegExp.prototype.test = test0;
  }
  assert.equal(appIdRegex, 1, "the appId regex runs once for unchanged app metadata");
  assert.equal(titleRegex, 1000, "the title rule (whose other matchers passed) sees every title");
  assert.ok(s.compiled.ruleCache.size <= cached + 1, `title churn adds no cache entries (${s.compiled.ruleCache.size})`);
  assert.deepEqual(last!.ruleIds, ["kde"]);
  assert.deepEqual(last!.actions, { border: "none" });
  // Priority/declaration order is kept when title and title-free rules interleave.
  const busy = resolveWindow(s, meta({ appId: "org.kde.konsole", resourceName: "konsole", title: "busy: make" }), CTX);
  assert.deepEqual(busy.ruleIds, ["kde", "konsole-busy"]);
  assert.deepEqual(busy.actions, { border: "none", insert: "master" });
  assert.deepEqual(busy.reasons, { border: "rule kde", insert: "rule konsole-busy" });
  const pip = resolveWindow(s, meta({ appId: "org.mozilla.firefox", title: "Picture-in-Picture" }), CTX);
  assert.deepEqual(pip.ruleIds, ["pip"]);
  assert.ok(Object.isFrozen(busy) && Object.isFrozen(busy.actions) && Object.isFrozen(busy.ruleIds));
  // A built-in exclusion still wins over a matching title rule, with the attempt explained.
  const osd = resolveWindow(s, meta({ kind: "osd", title: "Picture-in-Picture" }), CTX);
  assert.deepEqual(osd.actions, { mode: "excluded" });
  assert.deepEqual(osd.ruleIds, ["kde", "pip"]);
  assert.deepEqual(osd.reasons, { mode: "builtin kind:osd; ignored rule pip", border: "ignored (builtin kind:osd): rule kde" });
});

test("rule context matchers: output, desktop name/id, activity, in priority order (T25, Q02)", () => {
  const s = json({ schemaVersion: 1, rules: [
    { id: "dp2-float", match: { outputName: { glob: "DP-*" } }, actions: { mode: "floating" } },
    { id: "writing-kate", match: { appId: "org.kde.kate", desktopName: "Writing" }, actions: { border: "none", mode: "tiled" } },
    { id: "by-desktop-id", match: { desktopId: "d-uuid-2" }, actions: { insert: "master" } },
    { id: "by-activity", priority: -1, match: { activityId: { regex: "^a-uuid-" } }, actions: { insert: "end", border: "normal" } },
    { id: "kate-min", match: { appId: "org.kde.kate" }, actions: { minSize: { width: 600 } } },
  ] });
  const kate = meta({ appId: "org.kde.kate", resourceName: "kate" });
  const main = resolveWindow(s, kate, CTX);
  assert.deepEqual(main.ruleIds, ["by-activity", "kate-min"], "only the activity matcher passes on HDMI-A-1/Main");
  assert.deepEqual(main.actions, { insert: "end", border: "normal", minSize: { width: 600, height: 0 } });
  const writing = resolveWindow(s, kate, { ...CTX, desktopName: "Writing", desktopId: "d-uuid-2" });
  assert.deepEqual(writing.ruleIds, ["by-activity", "writing-kate", "by-desktop-id", "kate-min"]);
  assert.deepEqual(writing.actions, { insert: "master", border: "none", mode: "tiled", minSize: { width: 600, height: 0 } });
  assert.deepEqual(writing.reasons, { insert: "rule by-desktop-id", border: "rule writing-kate", mode: "rule writing-kate",
                                      minSize: "rule kate-min" });
  const dp2 = resolveWindow(s, kate, { ...CTX, outputName: "DP-2", desktopName: "Writing" });
  assert.equal(dp2.actions.mode, "tiled", "a later rule wins per field over the output rule");
  assert.deepEqual(dp2.ruleIds, ["by-activity", "dp2-float", "writing-kate", "kate-min"]);
  assert.equal(resolveWindow(s, meta(), { ...CTX, outputName: "DP-2" }).actions.mode, "floating");
  // No single context (all desktops, several activities): context rules never apply.
  assert.deepEqual(resolveWindow(s, kate, null).ruleIds, ["kate-min"]);
  // Context matchers with a built-in exclusion: the exclusion still wins, the attempt is explained.
  const dock = resolveWindow(s, meta({ kind: "dock" }), { ...CTX, outputName: "DP-1" });
  assert.deepEqual(dock.actions, { mode: "excluded" });
  assert.equal(dock.reasons.mode, "builtin kind:dock; ignored rule dp2-float");
});

test("rule context matchers are memoized per context, metadata matchers per metadata (T25, CONFIGURATION §4)", () => {
  const s = json({ schemaVersion: 1, rules: [
    { id: "kde", match: { appId: { regex: "^org\\.kde\\." } }, actions: { border: "none" } },
    { id: "dp", match: { outputName: { regex: "^DP-" } }, actions: { mode: "floating" } },
    { id: "writing", match: { desktopName: { regex: "^Writing$" }, appId: { glob: "org.kde.*" } }, actions: { insert: "master" } },
  ] });
  const counts = { app: 0, out: 0, desk: 0 };
  const test0 = RegExp.prototype.test;
  RegExp.prototype.test = function (this: RegExp, v: string) {
    if (this.source === "^org\\.kde\\.") counts.app++;
    if (this.source === "^DP-") counts.out++;
    if (this.source === "^Writing$") counts.desk++;
    return test0.call(this, v);
  };
  const konsole = (title: string) => meta({ appId: "org.kde.konsole", resourceName: "konsole", title });
  const dp1: ContextInfo = { ...CTX, outputName: "DP-1", desktopName: "Writing" };
  let first, again, other;
  try {
    first = resolveWindow(s, konsole("a"), dp1);
    for (let i = 0; i < 500; ++i) again = resolveWindow(s, konsole(`t${i}`), dp1);
    assert.deepEqual(counts, { app: 1, out: 1, desk: 1 }, "unchanged metadata and context: every matcher ran once");
    assert.equal(again, first, "the per-context result is memoized (identical object)");
    // Metadata changes in the same context: metadata matchers run per new metadata, context matchers never.
    for (let i = 0; i < 50; ++i) resolveWindow(s, meta({ appId: `org.kde.app${i}`, resourceName: `app${i}` }), dp1);
    assert.deepEqual(counts, { app: 51, out: 1, desk: 1 }, "a metadata change re-runs no context matcher");
    // Membership change (another context): only the context matchers run, once per new context.
    other = resolveWindow(s, konsole("b"), CTX);
    for (let i = 0; i < 20; ++i) resolveWindow(s, konsole(`u${i}`), CTX);
    assert.deepEqual(counts, { app: 51, out: 2, desk: 2 }, "a context change re-runs no metadata matcher");
  } finally {
    RegExp.prototype.test = test0;
  }
  assert.deepEqual(first!.ruleIds, ["kde", "dp", "writing"]);
  assert.deepEqual(first!.actions, { border: "none", mode: "floating", insert: "master" });
  assert.deepEqual(other!.ruleIds, ["kde"]);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first!.actions));
  // A context + title rule combination: context from the memo, title re-tested per call.
  const t = json({ schemaVersion: 1, rules: [
    { id: "dp-busy", match: { outputName: "DP-1", title: { glob: "busy*" } }, actions: { mode: "floating" } }] });
  assert.deepEqual(resolveWindow(t, konsole("busy: make"), dp1).ruleIds, ["dp-busy"]);
  assert.deepEqual(resolveWindow(t, konsole("idle"), dp1).ruleIds, []);
  assert.deepEqual(resolveWindow(t, konsole("busy: make"), CTX).ruleIds, []);
  // Bounded memo tables.
  for (let i = 0; i < 300; ++i) resolveWindow(s, konsole("x"), { ...CTX, desktopId: `d${i}` });
  assert.ok(s.compiled.ruleContextCache.size <= 64);
  assert.deepEqual(resolveWindow(s, konsole("x"), dp1).ruleIds, ["kde", "dp", "writing"]);
});

test("rule actions: minSize validation and actionable errors for unsupported actions (T25)", () => {
  const s = json({ schemaVersion: 1, rules: [
    { id: "w", match: { appId: "a" }, actions: { minSize: { width: 640, height: 400 } } },
    { id: "h", match: { appId: "b" }, actions: { minSize: { height: 300 } } }] });
  assert.deepEqual(resolveWindow(s, meta({ appId: "a" }), CTX).actions.minSize, { width: 640, height: 400 });
  assert.deepEqual(resolveWindow(s, meta({ appId: "b" }), CTX).actions.minSize, { width: 0, height: 300 });
  const e = docErrors({ schemaVersion: 1, rules: [
    { id: "a", match: { appId: "a" }, actions: { minSize: {} } },
    { id: "b", match: { appId: "a" }, actions: { minSize: { width: 0, depth: 2 } } },
    { id: "c", match: { appId: "a" }, actions: { minSize: { width: 1.5, height: 9000 } } },
    { id: "d", match: { appId: "a" }, actions: { layout: "monocle" } },
    { id: "e", match: { appId: "a" }, actions: { desktop: "Writing", output: "DP-1" } },
    { id: "f", match: { appId: "a" }, actions: { overflow: "float-new" } },
    { id: "g", match: { outputName: { glob: "DP-*", regex: "x" }, activityId: 3 }, actions: { mode: "floating" } },
    { id: "h", match: { desktopName: { regex: "(" } }, actions: { mode: "floating" } },
  ] });
  for (const p of [
    "rules[0].actions.minSize: give width, height or both",
    "rules[1].actions.minSize.width: must be an integer in 1..8192",
    "rules[1].actions.minSize.depth: unknown key",
    "rules[2].actions.minSize.width: must be an integer in 1..8192",
    "rules[2].actions.minSize.height: must be an integer in 1..8192",
    "rules[3].actions.layout: not a window action: a layout belongs to an output or desktop; use overrides[].set.layout",
    "rules[4].actions.desktop: not supported: Plastile does not move windows",
    "rules[4].actions.output: not supported: Plastile does not move windows",
    "rules[5].actions.overflow: not supported per window: float-new is the only overflow policy",
    "rules[6].match.outputName: matcher needs exactly one of",
    "rules[6].match.activityId: must be a string",
    "rules[7].match.desktopName.regex: invalid regex",
  ]) hasError(e, p);
  assert.ok(e.some((x) => x.includes("KWin window rule")), "placement errors name the KWin alternative");
  assert.ok(!e.some((x) => x.endsWith("unknown key") && /actions\.(layout|desktop|output|overflow)/.test(x)),
    "documented-but-unsupported actions are explained, not reported as unknown");
});

test("usesDesktopNames reports whether a desktop rename can change any resolution", () => {
  assert.equal(json({ schemaVersion: 1, rules: [{ id: "r", match: { desktopId: "x" }, actions: { mode: "floating" } }] }).usesDesktopNames, false);
  assert.equal(json({ schemaVersion: 1, rules: [{ id: "r", match: { desktopName: "x" }, actions: { mode: "floating" } }] }).usesDesktopNames, true);
  assert.equal(json({ schemaVersion: 1, overrides: [{ id: "o", match: { desktopName: "x" }, set: { layout: "bsp" } }] }).usesDesktopNames, true);
  assert.equal(ok(compileConfig({}, 1)).usesDesktopNames, false);
});

test("warnings for inert entries do not block activation", () => {
  const r = compileConfig({ configJson: JSON.stringify({
    schemaVersion: 1,
    overrides: [{ id: "o", match: { outputName: "DP-1" }, set: {} }],
    rules: [{ id: "r", match: { appId: "a" }, actions: {} }],
  }) }, 1);
  assert.ok(r.ok);
  assert.deepEqual(r.warnings.map(formatError), ["overrides[0].set: empty set has no effect", "rules[0].actions: empty actions have no effect"]);
});

test("256-rule config: compile and resolve timings (Node, informational)", (t) => {
  const rules = [];
  for (let i = 0; i < 256; ++i) {
    rules.push(i % 2 === 0
      ? { id: `exact-${i}`, priority: i % 7, match: { appId: `com.example.app${i}` }, actions: { mode: "floating" } }
      : { id: `glob-${i}`, priority: i % 5, match: { appId: { glob: `com.example.*.tool${i}` }, windowType: ["normal", "dialog"] }, actions: { border: "none" } });
  }
  const text = JSON.stringify({ schemaVersion: 1, rules });
  let t0 = performance.now();
  const r = compileConfig({ configJson: text }, 1);
  const compileMs = performance.now() - t0;
  const s = ok(r);
  assert.equal(s.compiled.rules.length, 256);

  const N = 400;
  const metas = Array.from({ length: N }, (_, i) => meta({ appId: i % 3 === 0 ? `com.example.app${i % 256}` : `com.example.x.tool${i % 256}` }));
  t0 = performance.now();
  for (const m of metas) resolveWindow(s, m, CTX);
  const uncachedMs = (performance.now() - t0) / N;
  const R = 20000;
  t0 = performance.now();
  for (let i = 0; i < R; ++i) resolveWindow(s, metas[i % 256], CTX);
  const cachedMs = (performance.now() - t0) / R;

  assert.deepEqual(resolveWindow(s, meta({ appId: "com.example.app4" }), CTX).ruleIds, ["exact-4"]);
  assert.deepEqual(resolveWindow(s, meta({ appId: "com.example.a.b.tool5" }), CTX).ruleIds, ["glob-5"]);
  t.diagnostic(`compile ${compileMs.toFixed(3)} ms; resolveWindow uncached ${(uncachedMs * 1000).toFixed(2)} µs/call, ` +
    `cached ${(cachedMs * 1000).toFixed(3)} µs/call (Node ${process.version}; not a QV4 measurement)`);
  assert.ok(cachedMs < 0.05, `cached resolve ${cachedMs} ms`);
  assert.ok(compileMs < 250, `compile ${compileMs} ms`);
});
