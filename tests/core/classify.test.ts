// T16: pure classification tests (BEHAVIOR §1): built-in exclusions > type/constraint
// defaults > rules, with source/reason/ruleIds recorded for explanations.

import test from "node:test";
import assert from "node:assert/strict";
import { classify, EXCLUDED_APPS, EXCLUDED_KINDS, FLOATING_APPS, TINY_REASON, type ClassifyInput, type RuleView } from "../../src/core/classify.ts";
import type { Constraints, Decision, Membership, WindowKind, WindowMeta } from "../../src/core/types.ts";
import { FREE, meta } from "./mockHost.ts";

const ONE: Membership = { output: "O1", desktops: ["D1"], onAllDesktops: false, activities: ["A1"] };
const FIXED: Constraints = { minFrame: { width: 400, height: 300 }, maxFrame: { width: 400, height: 300 }, fixed: true };

function input(m: Partial<WindowMeta> = {}, x: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    meta: meta(m.appId ?? "org.example.editor", m), membership: ONE, constraints: FREE,
    frameSize: { width: 800, height: 600 }, singleContext: true, rule: null, ...x,
  };
}

function rule(mode: RuleView["mode"], ...ruleIds: string[]): RuleView {
  return { mode, ruleIds: ruleIds.length ? ruleIds : ["r1"] };
}

function is(dec: Decision, mode: Decision["mode"], source: Decision["source"], ruleIds: readonly string[] = []): void {
  assert.equal(dec.mode, mode, `mode (${JSON.stringify(dec)})`);
  assert.equal(dec.source, source, `source (${JSON.stringify(dec)})`);
  assert.deepEqual([...dec.ruleIds], [...ruleIds], `ruleIds (${JSON.stringify(dec)})`);
  assert.equal(typeof dec.reason, "string");
  assert.ok(dec.reason.length > 0, "reason is non-empty");
}

test("a normal resizable single-context window tiles by default", () => {
  const dec = classify(input());
  is(dec, "tiled", "default");
  assert.deepEqual(Object.keys(dec).sort(), ["mode", "reason", "ruleIds", "source"]);
});

test("every EXCLUDED_KINDS kind is excluded by type, and a tiling rule cannot change it", () => {
  assert.ok(EXCLUDED_KINDS.size >= 11);
  for (const kind of EXCLUDED_KINDS) {
    const dec = classify(input({ kind }));
    is(dec, "excluded", "type");
    assert.match(dec.reason, new RegExp(kind));
    is(classify(input({ kind }, { rule: rule("tiled", "force") })), "excluded", "type");
  }
});

test("special and unmanaged windows are excluded by type", () => {
  is(classify(input({ special: true })), "excluded", "type");
  assert.match(classify(input({ special: true })).reason, /special/);
  is(classify(input({ managed: false })), "excluded", "type");
});

test("Plastile's own UI is a built-in exclusion that outranks everything", () => {
  const dec = classify(input({ own: true, kind: "dialog" }, { rule: rule("tiled") }));
  is(dec, "excluded", "builtin");
  assert.match(dec.reason, /Plastile/);
});

test("tiny helper surfaces (<= 2 px in either dimension) are excluded; unknown size is not", () => {
  for (const frameSize of [{ width: 1, height: 600 }, { width: 800, height: 2 }, { width: 0, height: 0 }]) {
    is(classify(input({}, { frameSize })), "excluded", "builtin");
  }
  is(classify(input({}, { frameSize: { width: 3, height: 3 } })), "tiled", "default");
  is(classify(input({}, { frameSize: null })), "tiled", "default");
});

test("every EXCLUDED_APPS app id is excluded as built-in, even with a tiling rule", () => {
  assert.ok(EXCLUDED_APPS.has("org.kde.krunner") && EXCLUDED_APPS.has("org.kde.plasmashell"));
  for (const appId of EXCLUDED_APPS) {
    const dec = classify(input({ appId }));
    is(dec, "excluded", "builtin");
    assert.match(dec.reason, new RegExp(appId.replace(/\./g, "\\.")));
    is(classify(input({ appId }, { rule: rule("tiled", "tile-all") })), "excluded", "builtin");
    is(classify(input({ appId }, { rule: rule("floating", "float-all") })), "excluded", "builtin");
  }
});

test("every FLOATING_APPS app id floats as built-in", () => {
  assert.ok(FLOATING_APPS.has("xdg-desktop-portal-kde"));
  for (const appId of FLOATING_APPS) {
    const dec = classify(input({ appId }));
    is(dec, "floating", "builtin");
    assert.match(dec.reason, new RegExp(appId.replace(/\./g, "\\.")));
  }
});

test("dialog, utility, transient and modal windows float by type", () => {
  const cases: Array<[Partial<WindowMeta>, RegExp]> = [
    [{ kind: "dialog" }, /dialog/],
    [{ kind: "utility" }, /utility/],
    [{ transient: true, transientFor: "W1" }, /transient/],
    [{ modal: true, transient: true, transientFor: "W1" }, /modal/],
    [{ modal: true }, /modal/],
    [{ kind: "other" }, /other/],
  ];
  for (const [patch, reason] of cases) {
    const dec = classify(input(patch));
    is(dec, "floating", "type");
    assert.match(dec.reason, reason);
  }
});

test("fixed-size or non-resizeable normal windows float by constraint", () => {
  is(classify(input({}, { constraints: FIXED })), "floating", "constraint");
  is(classify(input({ resizeable: false })), "floating", "constraint");
});

test("a tiling rule on a fixed window floats by constraint and keeps the rule ids", () => {
  const r = rule("tiled", "tile-editors", "tile-all");
  const a = classify(input({}, { constraints: FIXED, rule: r }));
  is(a, "floating", "constraint", ["tile-editors", "tile-all"]);
  assert.match(a.reason, /rule/);
  is(classify(input({ resizeable: false }, { rule: r })), "floating", "constraint", ["tile-editors", "tile-all"]);
});

test("rule modes beat type defaults and carry their ids", () => {
  is(classify(input({}, { rule: rule("excluded", "hide-it") })), "excluded", "rule", ["hide-it"]);
  is(classify(input({}, { rule: rule("floating", "float-it") })), "floating", "rule", ["float-it"]);
  is(classify(input({ kind: "dialog" }, { rule: rule("tiled", "tile-dialog") })), "tiled", "rule", ["tile-dialog"]);
  is(classify(input({ kind: "dialog" }, { rule: rule("excluded", "x") })), "excluded", "rule", ["x"]);
  // Built-in floating helpers can be tiled or excluded by an explicit rule (they are defaults, not exclusions).
  is(classify(input({ appId: "xdg-desktop-portal-kde" }, { rule: rule("tiled", "t") })), "tiled", "rule", ["t"]);
});

test("a rule without a mode (e.g. border only) leaves the default decision and adds no ids", () => {
  const r: RuleView = { ruleIds: ["borders"] };
  is(classify(input({}, { rule: r })), "tiled", "default");
  is(classify(input({ kind: "dialog" }, { rule: r })), "floating", "type");
});

test("multi-context windows float by membership with the matching reason, regardless of tiling rules", () => {
  const cases: Array<[Membership, RegExp]> = [
    [{ output: "O1", desktops: [], onAllDesktops: true, activities: ["A1"] }, /all desktops/],
    [{ output: "O1", desktops: ["D1", "D2"], onAllDesktops: false, activities: ["A1"] }, /several desktops/],
    [{ output: null, desktops: ["D1"], onAllDesktops: false, activities: ["A1"] }, /no output/],
    [{ output: "O1", desktops: ["D1"], onAllDesktops: false, activities: ["A1", "A2"] }, /several activities/],
  ];
  for (const [membership, reason] of cases) {
    const dec = classify(input({}, { membership, singleContext: false }));
    is(dec, "floating", "membership");
    assert.match(dec.reason, reason);
    is(classify(input({}, { membership, singleContext: false, rule: rule("tiled", "t") })), "floating", "membership");
    // Exclusion (built-in or by rule) still wins over the membership float.
    is(classify(input({}, { membership, singleContext: false, rule: rule("excluded", "x") })), "excluded", "rule", ["x"]);
    is(classify(input({ appId: "org.kde.krunner" }, { membership, singleContext: false })), "excluded", "builtin");
  }
});

test("titles are not identity: a normal window titled 'Dialog' stays tiled", () => {
  for (const title of ["Dialog", "Open File — Dialog", "Preferences", "KRunner"]) {
    is(classify(input({ title })), "tiled", "default");
  }
  // Nor does a role string make a window a dialog.
  is(classify(input({ role: "dialog" })), "tiled", "default");
});

test("misleading ids are not identity: app-id lists match exactly, an excluded kind outranks the id, tiny size applies to any id", () => {
  // A normal app whose resource name / class looks like a shell surface or helper: only appId
  // is matched, and only exactly.
  is(classify(input({ appId: "org.example.editor", resourceName: "plasmashell" })), "tiled", "default");
  is(classify(input({ appId: "org.example.editor", resourceName: "xdg-desktop-portal-kde" })), "tiled", "default");
  // Prefixes, extensions and substrings of listed ids are different applications.
  const near = ["org.kde.plasma", "plasma", "org.kde.krun", "kwin_", "kscreenlocker", "org.kde",
    "org.kde.plasmashell.settings", "org.kde.krunner-config", "org.kde.kwinrules", "kwin_wayland_wrapper",
    "xwaylandvideobridge2", "my-plasmashell", "org.kde.plasmashel"];
  for (const appId of near) {
    assert.ok(!EXCLUDED_APPS.has(appId) && !FLOATING_APPS.has(appId), `${appId} must not be listed`);
    is(classify(input({ appId })), "tiled", "default");
  }
  const helperish = ["xdg-desktop-portal", "xdg-desktop-portal-kde-helper", "org.kde.polkit-kde-authentication-agent",
    "org.kde.plasma.emojier.extra", "kdeconnect"];
  for (const appId of helperish) is(classify(input({ appId })), "tiled", "default");
  // A listed id on a different kind: an excluded kind is reported by type before the app id;
  // otherwise the app exclusion outranks the kind's float default and a tiling rule.
  is(classify(input({ appId: "org.kde.plasmashell", kind: "dock" })), "excluded", "type");
  is(classify(input({ appId: "xdg-desktop-portal-kde", kind: "popup" })), "excluded", "type");
  const shellDialog = classify(input({ appId: "org.kde.plasmashell", kind: "dialog" }, { rule: rule("tiled", "t") }));
  is(shellDialog, "excluded", "builtin");
  assert.match(shellDialog.reason, /org\.kde\.plasmashell/);
  is(classify(input({ appId: "org.kde.krunner", kind: "utility", transient: true, transientFor: "W1" })), "excluded", "builtin");
  // A helper-listed id on a dialog floats as the built-in helper (the list is checked before type).
  is(classify(input({ appId: "org.kde.polkit-kde-authentication-agent-1", kind: "dialog" })), "floating", "builtin");
  // A listed shell id at helper size is explained by the app id; an ordinary id at that size by the tiny rule.
  assert.match(classify(input({ appId: "kwin_wayland" }, { frameSize: { width: 1, height: 1 } })).reason, /kwin_wayland/);
  const tiny = classify(input({ appId: "org.example.editor", title: "Editor" }, { frameSize: { width: 1, height: 1 } }));
  is(tiny, "excluded", "builtin");
  assert.equal(tiny.reason, TINY_REASON);
});

test("precedence summary: own > kind > special > app exclusion > tiny > rule exclusion > membership > rule mode > helper app > type > constraint", () => {
  const kinds: WindowKind[] = ["dock", "dialog", "normal"];
  const seen = kinds.map((kind) => classify(input({ kind, own: true })).source);
  assert.deepEqual(seen, ["builtin", "builtin", "builtin"]);
  is(classify(input({ kind: "dock", special: true, appId: "org.kde.krunner" })), "excluded", "type");
  is(classify(input({ appId: "org.kde.krunner" }, { frameSize: { width: 1, height: 1 } })), "excluded", "builtin");
  is(classify(input({}, { frameSize: { width: 1, height: 1 }, rule: rule("excluded", "x") })), "excluded", "builtin");
  is(classify(input({ kind: "dialog" }, { constraints: FIXED })), "floating", "type");
  is(classify(input({ appId: "xdg-desktop-portal-kde", kind: "dialog" })), "floating", "builtin");
});
