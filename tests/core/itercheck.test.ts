// The build's iteration guard (tools/itercheck.ts, run by tools/build.mjs): for...of in src/ only
// over arrays and strings, never over a Map, a Set or one of their iterators, whose QV4 iteration
// skips an entry when the loop deletes one (docs/validation/PERFORMANCE.md §7.1). The guard is
// type-aware, so these cases name the collection through aliases, parameters and properties.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkProject, checkSource, formatHazard, RULE } from "../../tools/itercheck.ts";

const ROOT = resolve(import.meta.dirname, "../..");

function found(code: string): string[] {
  return checkSource(code).map((h) => `${h.line}:${h.kind}`);
}

test("src/ walks no Map, Set or iterator with for...of (the build fails otherwise)", () => {
  assert.deepEqual(checkProject(ROOT).map(formatHazard), []);
});

test("rejected: for...of over a Map, a Set, their iterators and anything typed as an iterable", () => {
  const code = [
    "const m = new Map<string, number>();",                                   // 1
    "const s = new Set<string>();",                                           // 2
    "for (const e of m) void e;",                                             // 3 Map
    "for (const [k, v] of m) void k, v;",                                     // 4 destructured entries
    "for (const k of m.keys()) void k;",                                      // 5
    "for (const v of m.values()) void v;",                                    // 6
    "for (const e of m.entries()) void e;",                                   // 7
    "for (const x of s) void x;",                                             // 8 Set
    "for (const x of s.values()) void x;",                                    // 9
    "function f(r: ReadonlyMap<string, number>, q: ReadonlySet<number>) {",   // 10
    "  for (const e of r) void e;",                                           // 11 a parameter
    "  for (const x of q) void x;",                                           // 12
    "}",                                                                      // 13
    "type Plan = Map<string, number>;",                                       // 14
    "class C { plan: Plan = new Map(); get live() { return this.plan; }",     // 15
    "  run() { for (const e of this.plan) void e; for (const e of this.live) void e; } }", // 16 property, getter
    "function g<T>(xs: Iterable<T>, ys: IterableIterator<T>) { for (const x of xs) void x; for (const y of ys) void y; }", // 17
    "function h<T extends Set<string>>(t: T) { for (const x of t) void x; }",  // 18 a type parameter
    "function u(x: string[] | Set<string>) { for (const y of x) void y; }",   // 19 a union with a Set
    "const copy = Array.from(m, ([k]) => k);",                                // 20 a callback during the iteration
    "export { f, C, g, h, u, copy, s };",
  ].join("\n");
  assert.deepEqual(found(code), [
    "3:for-of", "4:for-of", "5:for-of", "6:for-of", "7:for-of", "8:for-of", "9:for-of", "11:for-of", "12:for-of",
    "16:for-of", "16:for-of", "17:for-of", "17:for-of", "18:for-of", "19:for-of", "20:array-from-callback",
  ]);
});

test("rejected: the same walk written without for...of (next() loops, yield*, Array.from by another name)", () => {
  // Each of these skips an entry in QV4 when the code between the steps deletes one (probes/perf/qv4iter).
  const code = [
    "const m = new Map<string, number>();",                                          // 1
    "const s = new Set<string>();",                                                  // 2
    "const it = m.values();",                                                        // 3
    "for (let r = it.next(); !r.done; r = it.next()) void r.value;",                 // 4 two next() calls
    "class W { i = s.values(); step() { return this.i.next(); } }",                  // 5 an iterator in a property
    "function* g() { yield* s; }",                                                   // 6
    "const A = Array;",                                                              // 7
    "const a = A.from(s, (x) => x);",                                                // 8 an alias of Array
    "const b = Array['from'](m, ([k]) => k);",                                       // 9 element access
    "const { from } = Array;",                                                       // 10
    "const c = from(s, (x) => x);",                                                  // 11 a destructured from
    "const d = Array.from.call(null, s, (x: string) => x);",                         // 12 not a direct call
    "const f = Array.from;",                                                         // 13 a value
    "const t = Int16Array.from(s, (x) => x.length);",                                // 14 a typed array's from
    "export { W, g, a, b, c, d, f, t };",
  ].join("\n");
  assert.deepEqual(found(code), [
    "4:iterator-next", "4:iterator-next", "5:iterator-next", "6:yield-star", "8:array-from-callback",
    "9:array-from-callback", "11:array-from-callback", "12:array-from-indirect", "13:array-from-indirect",
    "14:array-from-callback",
  ]);
});

test("allowed: one step from a fresh iterator, yield* and Array.from over arrays", () => {
  const code = [
    "const m = new Map<string, number>();",
    "const first = m.keys().next().value, second = (m.values()).next();",
    "function* g(xs: number[]) { yield* xs; yield* 'ab'; }",
    "const ys = Array.from([1, 2], (x) => x + 1), zs = Array.from(m.keys()), ws = Int16Array.from([1, 2], (x) => x);",
    "export { first, second, g, ys, zs, ws };",
  ].join("\n");
  assert.deepEqual(found(code), []);
});

test("allowed: arrays, tuples, strings, snapshots without a callback, and forEach", () => {
  const code = [
    "const m = new Map<string, number>();",
    "const s = new Set<string>();",
    "const xs: number[] = [], ro: readonly string[] = [], tup: [string, number] = ['a', 1];",
    "for (const x of xs) void x;",
    "for (const x of ro) void x;",
    "for (const x of tup) void x;",
    "for (const c of 'abc') void c;",
    "for (const k of Object.keys({ a: 1 })) void k;",
    "for (const [k, v] of Object.entries({ a: 1 })) void k, v;",
    "for (const k of [...m.keys()]) void k;",
    "for (const x of Array.from(s)) void x;",
    "for (const [k, v] of Array.from(m)) void k, v;",
    "const keys = Array.from(m.keys()).map((k) => k + '!');",
    "const pairs = [...m], items = [...s], fresh = new Map(m), dup = new Set(s);",
    "m.forEach((v, k) => { if (v > 1) m.delete(k); });",
    "s.forEach((x) => void x);",
    "function g<T extends readonly string[]>(t: T, u: number[] | readonly number[]) { for (const x of t) void x; for (const y of u) void y; }",
    "export { keys, pairs, items, fresh, dup, g };",
  ].join("\n");
  assert.deepEqual(found(code), []);
});

test("the build's message names the rule and the measurement", () => {
  const [h] = checkSource("const m = new Map<string, number>();\nfor (const k of m.keys()) void k;\nexport { m };");
  assert.equal(formatHazard(h), "src/case.ts:2:1: for...of over `m.keys()` (MapIterator<string>)");
  assert.match(RULE, /PERFORMANCE\.md §7\.1/);
  assert.match(RULE, /forEach/);
});

test("checkProject reads src/ only, through the project's own tsconfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "plastile-itercheck-"));
  try {
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tsconfig.runtime.json"), JSON.stringify({
      compilerOptions: { target: "ES2017", lib: ["ES2017"], strict: true, noEmit: true, types: [] },
      include: ["src/**/*.ts", "tests/**/*.ts"],
    }));
    writeFileSync(join(dir, "src/a.ts"), "export function a(s: Set<number>): number { let n = 0; for (const x of s) n += x; return n; }\n");
    writeFileSync(join(dir, "src/b.ts"), "export function b(xs: number[]): number { let n = 0; for (const x of xs) n += x; return n; }\n");
    writeFileSync(join(dir, "tests/t.ts"), "export function t(s: Set<number>): void { for (const x of s) void x; }\n");
    assert.deepEqual(checkProject(dir).map(formatHazard), ["src/a.ts:1:56: for...of over `s` (Set<number>)"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
