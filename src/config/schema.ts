// Schema readers: flat KConfig keys and the JSON document (CONFIGURATION §2, §5).
// They normalize into patches and uncompiled-order lists; errors carry exact paths.

import type { Edges } from "../core/geometry.ts";
import type { BspSettings, LayoutKind, MasterStackSettings, WindowKind } from "../core/types.ts";
import { compileStringMatcher } from "./matchers.ts";
import type { CompiledOverride, CompiledRule, DiagnosticsLevel, RuleActions, SettingsPatch, StringMatcher } from "./types.ts";
import {
  MAX_GAP, MAX_JSON_LENGTH, MAX_MASTER_COUNT, MAX_OVERRIDES, MAX_RULES, MAX_TRACE, MIN_TRACE,
  at, bool, err, expected, finite, has, idx, intIn, objectWith, oneOf, openRatio, ratioStep, str, warn, type Sink,
} from "./validate.ts";

export const LAYOUTS: readonly LayoutKind[] = ["master-stack", "bsp", "monocle", "floating"];
export const MS_INSERT: readonly MasterStackSettings["insert"][] = ["after-focus", "end", "master"];
export const BSP_INSERT: readonly BspSettings["insert"][] = ["focused", "last"];
export const BSP_AXIS: readonly BspSettings["axis"][] = ["alternate", "longest", "horizontal", "vertical"];
export const DIAGNOSTICS: readonly DiagnosticsLevel[] = ["off", "warn", "info", "debug"];
export const WINDOW_KINDS: readonly WindowKind[] = [
  "normal", "dialog", "utility", "toolbar", "menu", "splash", "dock", "desktop",
  "notification", "tooltip", "popup", "osd", "applet-popup", "dnd-icon", "other",
];
const MODES: readonly NonNullable<RuleActions["mode"]>[] = ["tiled", "floating", "excluded"];
const BORDERS: readonly NonNullable<RuleActions["border"]>[] = ["normal", "none", "keep"];
const EDGES: readonly (keyof Edges)[] = ["top", "right", "bottom", "left"];

export interface DiagnosticsPatch {
  level?: DiagnosticsLevel;
  traceCapacity?: number;
}

// ---- flat keys ----

export const FLAT_KEYS: readonly string[] = [
  "layout", "gapInner", "gapOuter", "masterRatio", "masterCount", "masterInsert", "bspInsert", "bspAxis",
  "singleWindowGaps", "ratioStep", "traceCapacity", "diagnostics", "configJson",
];

export interface FlatInput {
  readonly patch: SettingsPatch;
  readonly diagnostics: DiagnosticsPatch;
  readonly json: string | null;
}

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** KConfig values may arrive as strings; numbers come only from plain decimal text. */
function flatNumber(s: Sink, v: unknown, key: string): number | null {
  if (typeof v === "string") {
    const t = v.trim();
    return NUMERIC.test(t) ? Number(t) : err(s, key, `must be a number (got "${v.length > 32 ? v.slice(0, 32) + "…" : v}")`);
  }
  return finite(s, v, key);
}

function flatBool(s: Sink, v: unknown, key: string): boolean | null {
  if (v === "true") return true;
  if (v === "false") return false;
  return typeof v === "boolean" ? v : err(s, key, 'must be true or false');
}

/** undefined, null and empty strings mean "not set" (KConfig default for a missing key). */
function absent(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

export function readFlat(s: Sink, flat: Readonly<Record<string, unknown>>): FlatInput {
  const patch: SettingsPatch = {};
  const diagnostics: DiagnosticsPatch = {};
  let json: string | null = null;
  for (const key of Object.keys(flat)) {
    if (FLAT_KEYS.indexOf(key) < 0) warn(s, key, "unknown key ignored");
  }
  const get = (k: string): unknown => (has(flat, k) && !absent(flat[k]) ? flat[k] : undefined);
  let v: unknown;
  let n: number | null;

  if ((v = get("layout")) !== undefined) {
    const x = oneOf(s, v, "layout", LAYOUTS);
    if (x !== null) patch.layout = x;
  }
  if ((v = get("gapInner")) !== undefined && (n = intIn(s, flatNumber(s, v, "gapInner"), "gapInner", 0, MAX_GAP)) !== null) {
    patch.gaps = { ...patch.gaps, inner: n };
  }
  if ((v = get("gapOuter")) !== undefined && (n = intIn(s, flatNumber(s, v, "gapOuter"), "gapOuter", 0, MAX_GAP)) !== null) {
    patch.gaps = { ...patch.gaps, outer: { top: n, right: n, bottom: n, left: n } };
  }
  if ((v = get("masterRatio")) !== undefined && (n = openRatio(s, flatNumber(s, v, "masterRatio"), "masterRatio")) !== null) {
    patch.masterStack = { ...patch.masterStack, ratio: n };
  }
  if ((v = get("masterCount")) !== undefined &&
      (n = intIn(s, flatNumber(s, v, "masterCount"), "masterCount", 0, MAX_MASTER_COUNT)) !== null) {
    patch.masterStack = { ...patch.masterStack, masterCount: n };
  }
  if ((v = get("masterInsert")) !== undefined) {
    const x = oneOf(s, v, "masterInsert", MS_INSERT);
    if (x !== null) patch.masterStack = { ...patch.masterStack, insert: x };
  }
  if ((v = get("bspInsert")) !== undefined) {
    const x = oneOf(s, v, "bspInsert", BSP_INSERT);
    if (x !== null) patch.bsp = { ...patch.bsp, insert: x };
  }
  if ((v = get("bspAxis")) !== undefined) {
    const x = oneOf(s, v, "bspAxis", BSP_AXIS);
    if (x !== null) patch.bsp = { ...patch.bsp, axis: x };
  }
  if ((v = get("singleWindowGaps")) !== undefined) {
    const x = flatBool(s, v, "singleWindowGaps");
    if (x !== null) patch.singleWindowGaps = x;
  }
  // One flat step drives both layouts; the JSON document can set them separately.
  if ((v = get("ratioStep")) !== undefined && (n = ratioStep(s, flatNumber(s, v, "ratioStep"), "ratioStep")) !== null) {
    patch.masterStack = { ...patch.masterStack, ratioStep: n };
    patch.bsp = { ...patch.bsp, ratioStep: n };
  }
  if ((v = get("traceCapacity")) !== undefined &&
      (n = intIn(s, flatNumber(s, v, "traceCapacity"), "traceCapacity", MIN_TRACE, MAX_TRACE)) !== null) {
    diagnostics.traceCapacity = n;
  }
  if ((v = get("diagnostics")) !== undefined) {
    const x = oneOf(s, v, "diagnostics", DIAGNOSTICS);
    if (x !== null) diagnostics.level = x;
  }
  if ((v = get("configJson")) !== undefined) {
    if (typeof v !== "string") expected(s, "configJson", "a JSON string", v);
    else if (v.length > MAX_JSON_LENGTH) err(s, "configJson", `longer than ${MAX_JSON_LENGTH} characters`);
    else json = v;
  }
  return { patch, diagnostics, json };
}

// ---- settings patch (JSON `defaults` and override `set`) ----

const SETTINGS_KEYS = [
  "enabled", "layout", "gaps", "masterStack", "bsp", "overflow", "singleWindowGaps",
  "followOnSend", "multiContextWindows", "animation",
];

function unsupported(s: Sink, v: unknown, path: string, only: unknown): void {
  if (v !== only) err(s, path, `not supported in this version (only ${JSON.stringify(only)} is accepted)`);
}

export function readPatch(s: Sink, v: unknown, path: string): SettingsPatch {
  const p: SettingsPatch = {};
  const o = objectWith(s, v, path, SETTINGS_KEYS);
  if (!o) return p;
  if (has(o, "enabled")) { const x = bool(s, o.enabled, at(path, "enabled")); if (x !== null) p.enabled = x; }
  if (has(o, "layout")) { const x = oneOf(s, o.layout, at(path, "layout"), LAYOUTS); if (x !== null) p.layout = x; }
  if (has(o, "overflow")) { const x = oneOf(s, o.overflow, at(path, "overflow"), ["float-new"] as const); if (x !== null) p.overflow = x; }
  if (has(o, "singleWindowGaps")) {
    const x = bool(s, o.singleWindowGaps, at(path, "singleWindowGaps"));
    if (x !== null) p.singleWindowGaps = x;
  }
  if (has(o, "gaps")) {
    const gp = at(path, "gaps");
    const g = objectWith(s, o.gaps, gp, ["inner", "outer"]);
    if (g) {
      const gaps: NonNullable<SettingsPatch["gaps"]> = {};
      if (has(g, "inner")) {
        const x = intIn(s, finite(s, g.inner, at(gp, "inner")), at(gp, "inner"), 0, MAX_GAP);
        if (x !== null) gaps.inner = x;
      }
      if (has(g, "outer")) {
        const op = at(gp, "outer");
        if (typeof g.outer === "number") {
          const x = intIn(s, finite(s, g.outer, op), op, 0, MAX_GAP);
          if (x !== null) gaps.outer = { top: x, right: x, bottom: x, left: x };
        } else if (typeof g.outer === "object" && g.outer !== null && !Array.isArray(g.outer)) {
          const e = objectWith(s, g.outer, op, EDGES);
          if (e) {
            const outer: { top?: number; right?: number; bottom?: number; left?: number } = {};
            for (const k of EDGES) {
              if (!has(e, k)) continue;
              const x = intIn(s, finite(s, e[k], at(op, k)), at(op, k), 0, MAX_GAP);
              if (x !== null) outer[k] = x;
            }
            gaps.outer = outer;
          }
        } else expected(s, op, "a number or a {top,right,bottom,left} object", g.outer);
      }
      p.gaps = gaps;
    }
  }
  if (has(o, "masterStack")) {
    const mp = at(path, "masterStack");
    const m = objectWith(s, o.masterStack, mp, ["ratio", "masterCount", "insert", "ratioStep"]);
    if (m) {
      const ms: { ratio?: number; masterCount?: number; insert?: MasterStackSettings["insert"]; ratioStep?: number } = {};
      let x: number | null;
      if (has(m, "ratio") && (x = openRatio(s, finite(s, m.ratio, at(mp, "ratio")), at(mp, "ratio"))) !== null) ms.ratio = x;
      if (has(m, "masterCount") &&
          (x = intIn(s, finite(s, m.masterCount, at(mp, "masterCount")), at(mp, "masterCount"), 0, MAX_MASTER_COUNT)) !== null) {
        ms.masterCount = x;
      }
      if (has(m, "insert")) { const i = oneOf(s, m.insert, at(mp, "insert"), MS_INSERT); if (i !== null) ms.insert = i; }
      if (has(m, "ratioStep") && (x = ratioStep(s, finite(s, m.ratioStep, at(mp, "ratioStep")), at(mp, "ratioStep"))) !== null) {
        ms.ratioStep = x;
      }
      p.masterStack = ms;
    }
  }
  if (has(o, "bsp")) {
    const bp = at(path, "bsp");
    const b = objectWith(s, o.bsp, bp, ["insert", "axis", "initialRatio", "ratioStep"]);
    if (b) {
      const bs: { insert?: BspSettings["insert"]; axis?: BspSettings["axis"]; initialRatio?: number; ratioStep?: number } = {};
      let x: number | null;
      if (has(b, "insert")) { const i = oneOf(s, b.insert, at(bp, "insert"), BSP_INSERT); if (i !== null) bs.insert = i; }
      if (has(b, "axis")) { const a = oneOf(s, b.axis, at(bp, "axis"), BSP_AXIS); if (a !== null) bs.axis = a; }
      if (has(b, "initialRatio") &&
          (x = openRatio(s, finite(s, b.initialRatio, at(bp, "initialRatio")), at(bp, "initialRatio"))) !== null) {
        bs.initialRatio = x;
      }
      if (has(b, "ratioStep") && (x = ratioStep(s, finite(s, b.ratioStep, at(bp, "ratioStep")), at(bp, "ratioStep"))) !== null) {
        bs.ratioStep = x;
      }
      p.bsp = bs;
    }
  }
  // Accepted for forward compatibility with the documented example, only at their inert values.
  if (has(o, "followOnSend")) unsupported(s, o.followOnSend, at(path, "followOnSend"), false);
  if (has(o, "multiContextWindows")) unsupported(s, o.multiContextWindows, at(path, "multiContextWindows"), "float");
  if (has(o, "animation")) {
    const ap = at(path, "animation");
    const a = objectWith(s, o.animation, ap, ["enabled", "durationMs"]);
    if (a) {
      if (has(a, "enabled")) unsupported(s, a.enabled, at(ap, "enabled"), false);
      if (has(a, "durationMs")) unsupported(s, a.durationMs, at(ap, "durationMs"), 0);
    }
  }
  return p;
}

// ---- JSON document ----

export interface Ordered<T> {
  readonly item: T;
  readonly priority: number;
  readonly index: number;
}

export interface DocumentInput {
  readonly defaults: SettingsPatch | null;
  readonly overrides: readonly Ordered<CompiledOverride>[];
  readonly rules: readonly Ordered<CompiledRule>[];
  readonly diagnostics: DiagnosticsPatch;
}

const EMPTY_DOC: DocumentInput = { defaults: null, overrides: [], rules: [], diagnostics: {} };

export function readDocument(s: Sink, text: string): DocumentInput {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    err(s, "configJson", `invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    return EMPTY_DOC;
  }
  const o = objectWith(s, raw, "", ["schemaVersion", "defaults", "overrides", "rules", "diagnostics"]);
  if (!o) return EMPTY_DOC;
  if (!has(o, "schemaVersion")) err(s, "schemaVersion", "required");
  else if (o.schemaVersion !== 1) err(s, "schemaVersion", `unsupported schema version ${JSON.stringify(o.schemaVersion)} (supported: 1)`);

  const defaults = has(o, "defaults") ? readPatch(s, o.defaults, "defaults") : null;
  const overrides = has(o, "overrides") ? readList(s, o.overrides, "overrides", MAX_OVERRIDES, readOverride) : [];
  const rules = has(o, "rules") ? readList(s, o.rules, "rules", MAX_RULES, readRule) : [];
  const diagnostics: DiagnosticsPatch = {};
  if (has(o, "diagnostics")) {
    const d = objectWith(s, o.diagnostics, "diagnostics", ["level", "traceCapacity"]);
    if (d) {
      if (has(d, "level")) { const l = oneOf(s, d.level, "diagnostics.level", DIAGNOSTICS); if (l !== null) diagnostics.level = l; }
      if (has(d, "traceCapacity")) {
        const t = intIn(s, finite(s, d.traceCapacity, "diagnostics.traceCapacity"), "diagnostics.traceCapacity", MIN_TRACE, MAX_TRACE);
        if (t !== null) diagnostics.traceCapacity = t;
      }
    }
  }
  return { defaults, overrides, rules, diagnostics };
}

type ItemReader<T> = (s: Sink, o: Record<string, unknown>, path: string, id: string) => T | null;

/** Bounded list of {id, priority?, ...} items with unique ids. */
function readList<T>(s: Sink, v: unknown, path: string, max: number, read: ItemReader<T>): Ordered<T>[] {
  if (!Array.isArray(v)) { expected(s, path, "an array", v); return []; }
  if (v.length > max) { err(s, path, `at most ${max} entries allowed (got ${v.length})`); return []; }
  const out: Ordered<T>[] = [];
  const seen: Record<string, string> = Object.create(null);
  for (let i = 0; i < v.length; ++i) {
    const ip = idx(path, i);
    const e = v[i];
    if (typeof e !== "object" || e === null || Array.isArray(e)) { expected(s, ip, "an object", e); continue; }
    const rec = e as Record<string, unknown>;
    let id: string | null = null;
    if (!has(rec, "id")) err(s, at(ip, "id"), "required");
    else if ((id = str(s, rec.id, at(ip, "id"))) !== null && id === "") id = err(s, at(ip, "id"), "must not be empty");
    if (id !== null) {
      if (seen[id] !== undefined) err(s, at(ip, "id"), `duplicate id "${id}" (also at ${seen[id]})`);
      else seen[id] = ip;
    }
    let priority = 0;
    if (has(rec, "priority")) { const p = finite(s, rec.priority, at(ip, "priority")); if (p !== null) priority = p; }
    const item = read(s, rec, ip, id !== null ? id : "");
    if (item !== null && id !== null) out.push({ item, priority, index: i });
  }
  return out;
}

function optMatcher(s: Sink, m: Record<string, unknown>, path: string, key: string): StringMatcher | null {
  return has(m, key) ? compileStringMatcher(s, m[key], at(path, key)) : null;
}

function readOverride(s: Sink, o: Record<string, unknown>, path: string, id: string): CompiledOverride | null {
  if (!objectWith(s, o, path, ["id", "priority", "match", "set"])) return null;
  const errorsBefore = s.errors.length;
  const mp = at(path, "match");
  if (!has(o, "match")) return err(s, mp, "required");
  const m = objectWith(s, o.match, mp, ["outputName", "desktopName", "desktopId", "activityId"]);
  if (!m) return null;
  if (Object.keys(m).length === 0) return err(s, mp, "empty match would apply everywhere; use defaults instead");
  const outputName = optMatcher(s, m, mp, "outputName");
  const desktopName = optMatcher(s, m, mp, "desktopName");
  const desktopId = optMatcher(s, m, mp, "desktopId");
  const activityId = optMatcher(s, m, mp, "activityId");
  if (!has(o, "set")) return err(s, at(path, "set"), "required");
  const set = readPatch(s, o.set, at(path, "set"));
  if (s.errors.length !== errorsBefore) return null;
  if (Object.keys(set).length === 0) warn(s, at(path, "set"), "empty set has no effect");
  return { id, outputName, desktopName, desktopId, activityId, set };
}

function readRule(s: Sink, o: Record<string, unknown>, path: string, id: string): CompiledRule | null {
  if (!objectWith(s, o, path, ["id", "priority", "match", "actions"])) return null;
  const errorsBefore = s.errors.length;
  const mp = at(path, "match");
  if (!has(o, "match")) return err(s, mp, "required");
  const m = objectWith(s, o.match, mp, ["appId", "resourceName", "title", "windowType", "transient"]);
  if (!m) return null;
  if (Object.keys(m).length === 0) return err(s, mp, "empty match would apply to every window; give at least one field");
  const appId = optMatcher(s, m, mp, "appId");
  const resourceName = optMatcher(s, m, mp, "resourceName");
  const title = optMatcher(s, m, mp, "title");
  let windowType: Set<WindowKind> | null = null;
  if (has(m, "windowType")) {
    const tp = at(mp, "windowType");
    const list = Array.isArray(m.windowType) ? m.windowType : [m.windowType];
    if (list.length === 0 || list.length > WINDOW_KINDS.length) err(s, tp, `must name 1..${WINDOW_KINDS.length} window types`);
    else {
      windowType = new Set<WindowKind>();
      for (let i = 0; i < list.length; ++i) {
        const k = oneOf(s, list[i], Array.isArray(m.windowType) ? idx(tp, i) : tp, WINDOW_KINDS);
        if (k !== null) windowType.add(k);
      }
    }
  }
  let transient: boolean | null = null;
  if (has(m, "transient")) transient = bool(s, m.transient, at(mp, "transient"));

  const ap = at(path, "actions");
  if (!has(o, "actions")) return err(s, ap, "required");
  const a = objectWith(s, o.actions, ap, ["mode", "border", "insert"]);
  if (!a) return null;
  const actions: { mode?: RuleActions["mode"]; border?: RuleActions["border"]; insert?: RuleActions["insert"] } = {};
  if (has(a, "mode")) { const x = oneOf(s, a.mode, at(ap, "mode"), MODES); if (x !== null) actions.mode = x; }
  if (has(a, "border")) { const x = oneOf(s, a.border, at(ap, "border"), BORDERS); if (x !== null) actions.border = x; }
  if (has(a, "insert")) { const x = oneOf(s, a.insert, at(ap, "insert"), MS_INSERT); if (x !== null) actions.insert = x; }
  if (s.errors.length !== errorsBefore) return null;
  if (Object.keys(actions).length === 0) warn(s, ap, "empty actions have no effect");
  return { id, appId, resourceName, title, windowType, transient, actions };
}
