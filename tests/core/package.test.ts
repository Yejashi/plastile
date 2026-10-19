// The settings dialog schema (package/contents/config/main.xml) and the runtime's
// flat-key parser must agree on keys, defaults and enum vocabulary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileConfig, DEFAULT_DIAGNOSTICS, DEFAULT_OSD, FLAT_KEYS } from "../../src/config/index.ts";
import { DIAGNOSTICS, MAXIMIZED_ON_OPEN } from "../../src/config/schema.ts";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.ts";
import { COMMANDS } from "../../src/core/commands.ts";

const xml = readFileSync(new URL("../../package/contents/config/main.xml", import.meta.url), "utf8");
const entries = [...xml.matchAll(/<entry name="([^"]+)" type="([^"]+)">([\s\S]*?)<\/entry>/g)]
  .map((m) => ({ name: m[1], type: m[2], body: m[3],
    default: /<default>([^<]*)<\/default>/.exec(m[3])?.[1] ?? "",
    choices: [...m[3].matchAll(/<choice name="([^"]+)"\/>/g)].map((c) => c[1]) }));

test("schema keys equal the runtime flat keys", () => {
  assert.deepEqual(entries.map((e) => e.name).sort(), [...FLAT_KEYS].sort());
});

test("schema defaults equal the runtime defaults", () => {
  const d = Object.fromEntries(entries.map((e) => [e.name, e.default]));
  assert.equal(d.layout, DEFAULT_SETTINGS.layout);
  assert.equal(Number(d.gapInner), DEFAULT_SETTINGS.gaps.inner);
  assert.equal(Number(d.gapOuter), DEFAULT_SETTINGS.gaps.outer.top);
  assert.equal(Number(d.masterRatio), DEFAULT_SETTINGS.masterStack.ratio);
  assert.equal(Number(d.masterCount), DEFAULT_SETTINGS.masterStack.masterCount);
  assert.equal(d.masterInsert, DEFAULT_SETTINGS.masterStack.insert);
  assert.equal(d.bspInsert, DEFAULT_SETTINGS.bsp.insert);
  assert.equal(d.bspAxis, DEFAULT_SETTINGS.bsp.axis);
  assert.equal(d.singleWindowGaps === "true", DEFAULT_SETTINGS.singleWindowGaps);
  assert.equal(Number(d.ratioStep), DEFAULT_SETTINGS.masterStack.ratioStep);
  assert.equal(d.diagnostics, DEFAULT_DIAGNOSTICS);
  assert.equal(d.osd === "true", DEFAULT_OSD);
  assert.equal(d.maximizedOnOpen, DEFAULT_SETTINGS.maximizedOnOpen);
  const empty = compileConfig({}, 1);
  assert.ok(empty.ok && empty.snapshot.osd === DEFAULT_OSD && empty.snapshot.diagnostics === DEFAULT_DIAGNOSTICS);
});

test("the log level choices are the runtime's, in order (error hides notices; off hides everything)", () => {
  assert.deepEqual(entries.find((e) => e.name === "diagnostics")!.choices, [...DIAGNOSTICS]);
  assert.deepEqual([...DIAGNOSTICS], ["off", "error", "warn", "info", "debug"]);
  const off = compileConfig({ osd: "false" }, 1);
  assert.ok(off.ok && off.snapshot.osd === false);
  assert.ok(!compileConfig({ osd: "maybe" }, 1).ok, "osd is validated");
});

test("the settings dialog (config.ui) has one widget per schema entry, and every combo box lists its choices", () => {
  const ui = readFileSync(new URL("../../package/contents/ui/config.ui", import.meta.url), "utf8");
  const widgets = [...ui.matchAll(/<widget class="([^"]+)" name="kcfg_([^"]+)">([\s\S]*?)<\/widget>/g)]
    .map((m) => ({ cls: m[1], name: m[2], items: (m[3].match(/<item>/g) ?? []).length }));
  assert.deepEqual(widgets.map((w) => w.name).sort(), entries.map((e) => e.name).sort());
  for (const e of entries) {
    const w = widgets.find((x) => x.name === e.name)!;
    if (e.type === "Enum") assert.equal(w.items, e.choices.length, `${e.name}: one combo item per choice, in the same order`);
    if (e.type === "Bool") assert.equal(w.cls, "QCheckBox", `${e.name}: a check box`);
  }
});

test("ADR-021: the maximizedOnOpen choices are the runtime's, default first; the flat key and the JSON patch both set it", () => {
  assert.deepEqual(entries.find((e) => e.name === "maximizedOnOpen")!.choices, [...MAXIMIZED_ON_OPEN]);
  assert.equal(MAXIMIZED_ON_OPEN[0], DEFAULT_SETTINGS.maximizedOnOpen);
  const keep = compileConfig({ maximizedOnOpen: "keep" }, 1);
  assert.ok(keep.ok && keep.snapshot.defaults.maximizedOnOpen === "keep");
  const json = compileConfig({ configJson: JSON.stringify({ schemaVersion: 1, defaults: { maximizedOnOpen: "keep" } }) }, 1);
  assert.ok(json.ok && json.snapshot.defaults.maximizedOnOpen === "keep");
  const bad = compileConfig({ maximizedOnOpen: "float" }, 1);
  assert.ok(!bad.ok && bad.errors.some((e) => e.path === "maximizedOnOpen"), "validated before activation");
});

test("every schema value (defaults and enum choices) is accepted by the runtime", () => {
  for (const e of entries) {
    const values = e.choices.length ? e.choices : [e.default];
    for (const v of values) {
      const r = compileConfig({ [e.name]: v }, 1);
      assert.ok(r.ok, `${e.name}=${v}: ${r.ok ? "" : JSON.stringify(r.errors)}`);
    }
  }
});

test("command ids are unique and stable-looking", () => {
  const ids = COMMANDS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  // A trailing number names one of a numbered set (plastile.zone.assign-1 … assign-9).
  for (const id of ids) assert.match(id, /^plastile\.[a-z]+\.[a-z][a-z-]*(-[1-9])?$/);
  const seqs = COMMANDS.map((c) => c.sequence).filter((s) => s !== "");
  assert.equal(new Set(seqs).size, seqs.length, "no two commands share a default binding");
});

test("default bindings avoid Shift+punctuation and measured collisions (docs/user/SHORTCUTS.md)", () => {
  // Shift changes the produced key symbol (US: Shift+= is "+", Shift+- is "_"), so such a
  // sequence never arrives as registered: Meta+Shift+= and Meta+Shift+- were measured not to
  // reach Plastile with real input in nested KWin 6.7.5.
  // Taken by stock software: Spectacle (Meta+Shift+S, measured in the registry), KWin Zoom
  // and Magnifier (Meta+=, Meta++, Meta+-; observed source: src/plugins/zoom/zoom.cpp:54-57).
  const taken = new Set(["Meta+Shift+S", "Meta+=", "Meta++", "Meta+-"]);
  for (const c of COMMANDS) {
    if (c.sequence === "") continue;
    const parts = c.sequence.endsWith("++") ? [...c.sequence.slice(0, -2).split("+"), "+"] : c.sequence.split("+");
    const key = parts[parts.length - 1];
    const mods = parts.slice(0, -1);
    assert.ok(!(mods.includes("Shift") && key.length === 1 && !/[A-Za-z0-9]/.test(key)),
      `${c.id}: ${c.sequence} combines Shift with punctuation`);
    assert.ok(!taken.has(c.sequence), `${c.id}: ${c.sequence} collides with a stock binding`);
    assert.ok(mods.length > 0 && mods.every((m) => m === "Meta" || m === "Shift" || m === "Ctrl" || m === "Alt"),
      `${c.id}: ${c.sequence} has an unexpected modifier`);
  }
});
