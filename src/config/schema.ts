// Schema readers: flat KConfig keys and the JSON document (CONFIGURATION §2, §5).
// They normalize into patches and uncompiled-order lists; errors carry exact paths.

import type { Edges } from "../core/geometry.ts";
import type {
  BspSettings, LayoutKind, MasterStackSettings, MaximizedOnOpen, ScrollingSettings, WindowKind, ZoneLayout, ZoneRect,
} from "../core/types.ts";
import { canonical, MAX_ZONE_LAYOUTS, MAX_ZONES, MIN_ZONE_FRACTION } from "../core/layouts/zones.ts";
import { compileStringMatcher } from "./matchers.ts";
import type { CompiledOverride, CompiledRule, DiagnosticsLevel, RuleActions, SettingsPatch, StringMatcher } from "./types.ts";
import {
  MAX_GAP, MAX_JSON_LENGTH, MAX_MASTER_COUNT, MAX_MIN_SIZE, MAX_OVERRIDES, MAX_RULES, MAX_TRACE, MIN_TRACE,
  at, bool, err, expected, finite, has, idx, intIn, objectWith, oneOf, openRatio, ratioStep, str, warn, type Sink,
} from "./validate.ts";

export const LAYOUTS: readonly LayoutKind[] = ["master-stack", "bsp", "monocle", "floating", "scrolling", "zones"];
export const SCROLL_POLICY: readonly ScrollingSettings["policy"][] = ["lazy", "centered"];
/** Width presets the width-cycle command steps through: at most this many. */
export const MAX_WIDTH_PRESETS = 8;
/** Longest zone layout id (declared before its first use: QV4 warns otherwise; tests/core/bundle.test.ts). */
export const MAX_ZONE_ID = 64;
export const MS_INSERT: readonly MasterStackSettings["insert"][] = ["after-focus", "end", "master"];
export const BSP_INSERT: readonly BspSettings["insert"][] = ["focused", "last"];
export const BSP_AXIS: readonly BspSettings["axis"][] = ["alternate", "longest", "horizontal", "vertical"];
export const DIAGNOSTICS: readonly DiagnosticsLevel[] = ["off", "error", "warn", "info", "debug"];
/** A window that arrives maximized: un-maximized and tiled, or left maximized (ADR-021). */
export const MAXIMIZED_ON_OPEN: readonly MaximizedOnOpen[] = ["tile", "keep"];
export const WINDOW_KINDS: readonly WindowKind[] = [
  "normal", "dialog", "utility", "toolbar", "menu", "splash", "dock", "desktop",
  "notification", "tooltip", "popup", "osd", "applet-popup", "dnd-icon", "other",
];
const MODES: readonly NonNullable<RuleActions["mode"]>[] = ["tiled", "floating", "excluded"];
const BORDERS: readonly NonNullable<RuleActions["border"]>[] = ["normal", "none", "keep"];
const EDGES: readonly (keyof Edges)[] = ["top", "right", "bottom", "left"];

/** Matcher fields for the window's context, shared by overrides and rules (CONFIGURATION §4). */
const CONTEXT_MATCH = ["outputName", "desktopName", "desktopId", "activityId"];

const PLACEMENT = "not supported: Plastile does not move windows to another output, desktop or activity on its own. " +
  "Use a KWin window rule (System Settings, Window Rules: Screen, Virtual Desktop, Activities); Plastile then tiles " +
  "the window where KWin placed it, and a rule here can match that place with outputName, desktopName or activityId";

/**
 * Rule actions named in CONFIGURATION §4 that this version does not implement, each with
 * what to use instead. Reported as errors rather than "unknown key", so the fix is in the message.
 */
const UNSUPPORTED_ACTIONS: Readonly<Record<string, string>> = {
  layout: "not a window action: a layout belongs to an output or desktop; use overrides[].set.layout with a match",
  output: PLACEMENT, outputName: PLACEMENT, screen: PLACEMENT, desktop: PLACEMENT, desktopName: PLACEMENT,
  desktopId: PLACEMENT, activity: PLACEMENT, activityId: PLACEMENT,
  overflow: "not supported per window: float-new is the only overflow policy in this version; " +
    "use minSize to float a window instead of giving it a tile smaller than it can use",
};

export interface DiagnosticsPatch {
  level?: DiagnosticsLevel;
  traceCapacity?: number;
}

// ---- flat keys ----

export const FLAT_KEYS: readonly string[] = [
  "layout", "gapInner", "gapOuter", "masterRatio", "masterCount", "masterInsert", "bspInsert", "bspAxis",
  "singleWindowGaps", "ratioStep", "maximizedOnOpen", "traceCapacity", "diagnostics", "osd", "configJson",
];

export interface FlatInput {
  readonly patch: SettingsPatch;
  readonly diagnostics: DiagnosticsPatch;
  /** The `osd` key; null when not set. */
  readonly osd: boolean | null;
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
  let osd: boolean | null = null;
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
  if ((v = get("maximizedOnOpen")) !== undefined) {
    const x = oneOf(s, v, "maximizedOnOpen", MAXIMIZED_ON_OPEN);
    if (x !== null) patch.maximizedOnOpen = x;
  }
  if ((v = get("traceCapacity")) !== undefined &&
      (n = intIn(s, flatNumber(s, v, "traceCapacity"), "traceCapacity", MIN_TRACE, MAX_TRACE)) !== null) {
    diagnostics.traceCapacity = n;
  }
  if ((v = get("diagnostics")) !== undefined) {
    const x = oneOf(s, v, "diagnostics", DIAGNOSTICS);
    if (x !== null) diagnostics.level = x;
  }
  if ((v = get("osd")) !== undefined) osd = flatBool(s, v, "osd");
  if ((v = get("configJson")) !== undefined) {
    if (typeof v !== "string") expected(s, "configJson", "a JSON string", v);
    else if (v.length > MAX_JSON_LENGTH) err(s, "configJson", `longer than ${MAX_JSON_LENGTH} characters`);
    else json = v;
  }
  return { patch, diagnostics, osd, json };
}

// ---- settings patch (JSON `defaults` and override `set`) ----

const SETTINGS_KEYS = [
  "enabled", "layout", "gaps", "masterStack", "bsp", "scrolling", "zones", "overflow", "singleWindowGaps",
  "followOnSend", "focusWrap", "liveResize", "maximizedOnOpen", "multiContextWindows", "animation",
];

function unsupported(s: Sink, v: unknown, path: string, only: unknown, hint = ""): void {
  if (v !== only) err(s, path, `not supported in this version (only ${JSON.stringify(only)} is accepted)${hint}`);
}

// ADR-023: Plastile never animates geometry; motion is the separate, optional KWin effect.
const ANIMATION_HINT = "; Plastile moves windows at once, and window motion is the optional 'Plastile Motion' " +
  "desktop effect (System Settings > Desktop Effects)";

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
  if (has(o, "scrolling")) p.scrolling = readScrolling(s, o.scrolling, at(path, "scrolling"));
  if (has(o, "zones")) {
    // Which zone layout a zones context uses; checked against the known ids in compileConfig.
    const zp = at(path, "zones");
    const z = objectWith(s, o.zones, zp, ["layout"]);
    if (z) {
      const zones: { layout?: string } = {};
      if (has(z, "layout")) {
        const id = str(s, z.layout, at(zp, "layout"), MAX_ZONE_ID);
        if (id === "") err(s, at(zp, "layout"), "must not be empty");
        else if (id !== null) zones.layout = id;
      }
      p.zones = zones;
    }
  }
  if (has(o, "followOnSend")) { const x = bool(s, o.followOnSend, at(path, "followOnSend")); if (x !== null) p.followOnSend = x; }
  if (has(o, "focusWrap")) { const x = bool(s, o.focusWrap, at(path, "focusWrap")); if (x !== null) p.focusWrap = x; }
  if (has(o, "liveResize")) { const x = bool(s, o.liveResize, at(path, "liveResize")); if (x !== null) p.liveResize = x; }
  if (has(o, "maximizedOnOpen")) {
    const x = oneOf(s, o.maximizedOnOpen, at(path, "maximizedOnOpen"), MAXIMIZED_ON_OPEN);
    if (x !== null) p.maximizedOnOpen = x;
  }
  // Accepted for forward compatibility with the documented example, only at their inert values. `animation` stays
  // inert for good (ADR-023): the effect cannot be told anything by the script, and Plastile never writes kwinrc.
  if (has(o, "multiContextWindows")) unsupported(s, o.multiContextWindows, at(path, "multiContextWindows"), "float");
  if (has(o, "animation")) {
    const ap = at(path, "animation");
    const a = objectWith(s, o.animation, ap, ["enabled", "durationMs"]);
    if (a) {
      if (has(a, "enabled")) unsupported(s, a.enabled, at(ap, "enabled"), false, ANIMATION_HINT);
      if (has(a, "durationMs")) unsupported(s, a.durationMs, at(ap, "durationMs"), 0, ANIMATION_HINT);
    }
  }
  return p;
}

/** A column width as a fraction of the usable width: (0, 1]. */
function widthFraction(s: Sink, v: unknown, path: string): number | null {
  const x = finite(s, v, path);
  if (x === null) return null;
  return x > 0 && x <= 1 ? x : err(s, path, "must be greater than 0 and at most 1");
}

/** Scrolling layout settings (experimental, docs/design/SCROLLING.md). */
function readScrolling(s: Sink, v: unknown, path: string): Partial<ScrollingSettings> {
  const out: { policy?: ScrollingSettings["policy"]; defaultWidth?: number; widthPresets?: readonly number[] } = {};
  const o = objectWith(s, v, path, ["policy", "defaultWidth", "widthPresets"]);
  if (!o) return out;
  if (has(o, "policy")) { const x = oneOf(s, o.policy, at(path, "policy"), SCROLL_POLICY); if (x !== null) out.policy = x; }
  if (has(o, "defaultWidth")) {
    const x = widthFraction(s, o.defaultWidth, at(path, "defaultWidth"));
    if (x !== null) out.defaultWidth = x;
  }
  if (has(o, "widthPresets")) {
    const pp = at(path, "widthPresets");
    const list = o.widthPresets;
    if (!Array.isArray(list)) expected(s, pp, "an array of fractions", list);
    else if (list.length === 0 || list.length > MAX_WIDTH_PRESETS) err(s, pp, `must hold 1..${MAX_WIDTH_PRESETS} fractions`);
    else {
      const presets: number[] = [];
      let ok = true;
      for (let i = 0; i < list.length; ++i) {
        const x = widthFraction(s, list[i], idx(pp, i));
        if (x === null) { ok = false; continue; }
        if (presets.length > 0 && x <= presets[presets.length - 1]) {
          err(s, idx(pp, i), "presets must be strictly ascending");
          ok = false;
        }
        presets.push(x);
      }
      if (ok) out.widthPresets = presets;
    }
  }
  return out;
}

// ---- zone layouts (experimental, docs/design/ZONES.md §1) ----

const ZONE_FIELDS = ["x", "y", "width", "height"];

function readZone(s: Sink, v: unknown, path: string): ZoneRect | null {
  const o = objectWith(s, v, path, ZONE_FIELDS);
  if (!o) return null;
  const before = s.errors.length;
  const val: Record<string, number> = {};
  for (const k of ZONE_FIELDS) {
    if (!has(o, k)) { err(s, at(path, k), "required (a fraction of the usable area, 0..1)"); continue; }
    const x = finite(s, o[k], at(path, k));
    if (x === null) continue;
    if (k === "x" || k === "y") {
      if (x < 0 || x > 1) { err(s, at(path, k), "must be between 0 and 1 (a fraction of the usable area)"); continue; }
    } else if (x < MIN_ZONE_FRACTION || x > 1) {
      err(s, at(path, k), `must be at least ${MIN_ZONE_FRACTION} and at most 1 (a fraction of the usable ${k})`);
      continue;
    }
    val[k] = canonical(x);
  }
  if (s.errors.length !== before) return null;
  // Fractions on a 1e-6 grid: 0.3333 + 0.6667 ends exactly at the edge.
  if (canonical(val.x + val.width) > 1) {
    return err(s, path, `x + width is ${canonical(val.x + val.width)}; the zone must end at the right edge (1) or before it`);
  }
  if (canonical(val.y + val.height) > 1) {
    return err(s, path, `y + height is ${canonical(val.y + val.height)}; the zone must end at the bottom edge (1) or before it`);
  }
  return { x: val.x, y: val.y, width: val.width, height: val.height };
}

/** The top-level `zoneLayouts` list: at most 16 layouts of 1..32 zones, unique non-empty ids. */
export function readZoneLayouts(s: Sink, v: unknown, path: string): ZoneLayout[] {
  if (!Array.isArray(v)) { expected(s, path, "an array of zone layouts", v); return []; }
  if (v.length > MAX_ZONE_LAYOUTS) { err(s, path, `at most ${MAX_ZONE_LAYOUTS} zone layouts allowed (got ${v.length})`); return []; }
  const out: ZoneLayout[] = [];
  const seen: Record<string, string> = Object.create(null);
  for (let i = 0; i < v.length; ++i) {
    const ip = idx(path, i);
    const o = objectWith(s, v[i], ip, ["id", "zones"]);
    if (!o) continue;
    const before = s.errors.length;
    let id: string | null = null;
    if (!has(o, "id")) err(s, at(ip, "id"), "required");
    else if ((id = str(s, o.id, at(ip, "id"), MAX_ZONE_ID)) !== null && id === "") id = err(s, at(ip, "id"), "must not be empty");
    if (id !== null) {
      if (seen[id] !== undefined) err(s, at(ip, "id"), `duplicate id "${id}" (also at ${seen[id]})`);
      else seen[id] = ip;
    }
    const zp = at(ip, "zones");
    const list: ZoneRect[] = [];
    if (!has(o, "zones")) err(s, zp, "required");
    else if (!Array.isArray(o.zones)) expected(s, zp, "an array of zones", o.zones);
    else if (o.zones.length === 0 || o.zones.length > MAX_ZONES) err(s, zp, `must hold 1..${MAX_ZONES} zones (got ${o.zones.length})`);
    else for (let k = 0; k < o.zones.length; ++k) { const z = readZone(s, o.zones[k], idx(zp, k)); if (z) list.push(z); }
    if (s.errors.length === before && id !== null) out.push({ id, zones: list });
  }
  return out;
}

/** Built-ins first; a configured layout with a built-in's id replaces it in place, the others follow. */
export function mergeZoneLayouts(builtin: readonly ZoneLayout[], configured: readonly ZoneLayout[]): ZoneLayout[] {
  const out = builtin.map((b) => configured.find((c) => c.id === b.id) ?? b);
  for (const c of configured) if (!builtin.some((b) => b.id === c.id)) out.push(c);
  return out;
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
  /** Configured zone layouts (null when the document has none). */
  readonly zoneLayouts: readonly ZoneLayout[] | null;
}

const EMPTY_DOC: DocumentInput = { defaults: null, overrides: [], rules: [], diagnostics: {}, zoneLayouts: null };

export function readDocument(s: Sink, text: string): DocumentInput {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    err(s, "configJson", `invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    return EMPTY_DOC;
  }
  const o = objectWith(s, raw, "", ["schemaVersion", "defaults", "overrides", "rules", "diagnostics", "zoneLayouts"]);
  if (!o) return EMPTY_DOC;
  if (!has(o, "schemaVersion")) err(s, "schemaVersion", "required");
  else if (o.schemaVersion !== 1) err(s, "schemaVersion", `unsupported schema version ${JSON.stringify(o.schemaVersion)} (supported: 1)`);

  const defaults = has(o, "defaults") ? readPatch(s, o.defaults, "defaults") : null;
  const overrides = has(o, "overrides") ? readList(s, o.overrides, "overrides", MAX_OVERRIDES, readOverride) : [];
  const rules = has(o, "rules") ? readList(s, o.rules, "rules", MAX_RULES, readRule) : [];
  const zoneLayouts = has(o, "zoneLayouts") ? readZoneLayouts(s, o.zoneLayouts, "zoneLayouts") : null;
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
  return { defaults, overrides, rules, diagnostics, zoneLayouts };
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
  const m = objectWith(s, o.match, mp, CONTEXT_MATCH);
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
  const m = objectWith(s, o.match, mp, ["appId", "resourceName", "title", "windowType", "transient", ...CONTEXT_MATCH]);
  if (!m) return null;
  if (Object.keys(m).length === 0) return err(s, mp, "empty match would apply to every window; give at least one field");
  const appId = optMatcher(s, m, mp, "appId");
  const resourceName = optMatcher(s, m, mp, "resourceName");
  const title = optMatcher(s, m, mp, "title");
  const outputName = optMatcher(s, m, mp, "outputName");
  const desktopName = optMatcher(s, m, mp, "desktopName");
  const desktopId = optMatcher(s, m, mp, "desktopId");
  const activityId = optMatcher(s, m, mp, "activityId");
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
  const a = objectWith(s, o.actions, ap, ["mode", "border", "insert", "minSize", "zone", ...Object.keys(UNSUPPORTED_ACTIONS)]);
  if (!a) return null;
  for (const k of Object.keys(UNSUPPORTED_ACTIONS)) if (has(a, k)) err(s, at(ap, k), UNSUPPORTED_ACTIONS[k]);
  const actions: { mode?: RuleActions["mode"]; border?: RuleActions["border"]; insert?: RuleActions["insert"];
                   minSize?: RuleActions["minSize"]; zone?: number } = {};
  if (has(a, "mode")) { const x = oneOf(s, a.mode, at(ap, "mode"), MODES); if (x !== null) actions.mode = x; }
  if (has(a, "border")) { const x = oneOf(s, a.border, at(ap, "border"), BORDERS); if (x !== null) actions.border = x; }
  if (has(a, "insert")) { const x = oneOf(s, a.insert, at(ap, "insert"), MS_INSERT); if (x !== null) actions.insert = x; }
  if (has(a, "minSize")) {
    // Minimum usable slot: a frame size below which the tile is not worth having (overflow floats it).
    const zp = at(ap, "minSize");
    const z = objectWith(s, a.minSize, zp, ["width", "height"]);
    if (z) {
      const dim = (k: string): number | null =>
        has(z, k) ? intIn(s, finite(s, z[k], at(zp, k)), at(zp, k), 1, MAX_MIN_SIZE) : 0;
      const width = dim("width"), height = dim("height");
      if (!has(z, "width") && !has(z, "height")) err(s, zp, "give width, height or both (logical pixels)");
      else if (width !== null && height !== null) actions.minSize = { width, height };
    }
  }
  if (has(a, "zone")) {
    // Zones layout (experimental): the zone number a new window is assigned to, as in "Assign to zone N".
    const x = intIn(s, finite(s, a.zone, at(ap, "zone")), at(ap, "zone"), 1, MAX_ZONES);
    if (x !== null) actions.zone = x;
  }
  if (s.errors.length !== errorsBefore) return null;
  if (Object.keys(actions).length === 0) warn(s, ap, "empty actions have no effect");
  const contextual = outputName !== null || desktopName !== null || desktopId !== null || activityId !== null;
  return { id, appId, resourceName, title, windowType, transient, outputName, desktopName, desktopId, activityId, contextual,
           actions };
}
