// The settings dialog schema (package/contents/config/main.xml) and the runtime's
// flat-key parser must agree on keys, defaults and enum vocabulary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileConfig, FLAT_KEYS } from "../../src/config/index.ts";
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
  for (const id of ids) assert.match(id, /^plastile\.[a-z]+\.[a-z-]+$/);
  const seqs = COMMANDS.map((c) => c.sequence).filter((s) => s !== "");
  assert.equal(new Set(seqs).size, seqs.length, "no two commands share a default binding");
});
