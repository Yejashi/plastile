// The persisted state snapshot (T27, ADR-013): a small, versioned, validated JSON document of
// layout preferences per context and the user's float rectangles per application, each with a
// same-session hint naming the window it was taken from (schema 2). Pure: no I/O.
// Anything invalid rejects the whole snapshot, so a damaged file means defaults, never a half
// applied one (CONFIGURATION §8).

import type { Rect } from "../core/geometry.ts";
import type { ContextKey, LayoutKind } from "../core/types.ts";
import { migrate } from "./migrate.ts";
import type { AppIdentity } from "./match.ts";

export const SCHEMA_VERSION = 2;
/** Bounds of what is kept and accepted (the engine keeps at most 64 retained contexts as well). */
export const MAX_CONTEXTS = 64;
export const MAX_FLOATS = 64;
/** Longest state text parsed at all (a full snapshot is about 25 KB). */
export const MAX_TEXT = 256 * 1024;
const MAX_ID = 512;
/** Longest window hint accepted (a KWin internalId is a 38-character braced UUID). */
export const MAX_HINT = 128;
const MAX_COORD = 1e6;
const LAYOUTS: readonly LayoutKind[] = ["master-stack", "bsp", "monocle", "floating", "scrolling", "zones"];
const MAX_MASTER_COUNT = 8;

export interface ContextEntry {
  readonly outputKey: string;
  readonly desktopId: string;
  readonly activity: string;
  readonly layout: LayoutKind | null;
  readonly masterStack: { readonly ratio: number; readonly masterCount: number } | null;
}

export interface FloatEntry {
  readonly appId: string;
  readonly resourceName: string;
  readonly role: string;
  readonly rect: Rect;
  readonly outputKey: string;
  readonly area: Rect;
  /**
   * The id of the window the rectangle was taken from (KWin's internalId), or "". A same-session
   * hint, never identity: KWin gives every window a new random id, so after a KWin restart or an
   * application relaunch it names no live window (ADR-020 addendum, schema 2).
   */
  readonly windowHint: string;
}

export interface Snapshot {
  readonly schemaVersion: number;
  readonly generation: number;
  readonly savedAt: string;
  readonly contexts: readonly ContextEntry[];
  readonly floats: readonly FloatEntry[];
}

/** What the engine reports (Engine.contextPreferences / floatPreferences), structurally. */
export interface ContextPrefsIn {
  readonly key: ContextKey;
  readonly prefs: { readonly layout: LayoutKind | null; readonly masterStack: { readonly ratio: number; readonly masterCount: number } | null };
}
export interface FloatPrefIn {
  readonly app: AppIdentity;
  readonly float: { readonly rect: Rect; readonly output: string; readonly area: Rect };
  /** The window the preference was taken from ("" for none). */
  readonly window: string;
}

export type Parsed =
  | { readonly ok: true; readonly snapshot: Snapshot; readonly migratedFrom: number }
  | { readonly ok: false; readonly reason: string; readonly future: boolean };

/**
 * The snapshot of the engine's preferences. Both lists are taken in the engine's order, most
 * important first (live contexts, then the most recently collected; the newest floats), and cut
 * at MAX_CONTEXTS and MAX_FLOATS.
 */
export function buildSnapshot(contexts: readonly ContextPrefsIn[], floats: readonly FloatPrefIn[], generation: number,
  savedAt: string): Snapshot {
  return {
    schemaVersion: SCHEMA_VERSION, generation, savedAt,
    contexts: contexts.slice(0, MAX_CONTEXTS).map((c) => ({
      outputKey: c.key.output, desktopId: c.key.desktop, activity: c.key.activity, layout: c.prefs.layout,
      masterStack: c.prefs.masterStack ? { ratio: c.prefs.masterStack.ratio, masterCount: c.prefs.masterStack.masterCount } : null,
    })),
    floats: floats.slice(0, MAX_FLOATS).map((f) => ({
      appId: f.app.appId, resourceName: f.app.resourceName, role: f.app.role, rect: plainRect(f.float.rect),
      outputKey: f.float.output, area: plainRect(f.float.area), windowHint: f.window,
    })),
  };
}

function plainRect(r: Rect): Rect {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** The stored text: keys in a fixed order, so equal content gives equal text. */
export function serialize(s: Snapshot): string {
  return JSON.stringify(s);
}

/**
 * A stored text's content: what follows its generation and time (`,"contexts":...,"floats":...}`).
 * Two texts with the same content need no new write. It is a slice of the text itself, because a
 * second JSON.stringify of a full snapshot (about 25 KB) costs about 0.5 ms on KWin's thread in
 * QV4 (measured, probes/persistence/cost). For texts from serialize() it is equal exactly when
 * the contexts and floats are; a text written otherwise (edited by hand, other key order) can
 * only differ, which costs one unneeded save, never a skipped one.
 */
export function contentOf(text: string): string {
  const i = text.indexOf(',"contexts":');
  return i < 0 ? text : text.slice(i);
}

/** Parse, migrate and validate stored text. */
export function parse(text: string): Parsed {
  if (typeof text !== "string" || text.length === 0) return bad("empty");
  if (text.length > MAX_TEXT) return bad(`longer than ${MAX_TEXT} characters`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (_e) {
    return bad("not valid JSON (truncated or damaged)");
  }
  const m = migrate(raw, SCHEMA_VERSION);
  if (!m.ok) return { ok: false, reason: m.reason, future: m.future };
  const v = validate(m.value);
  return v.ok ? { ok: true, snapshot: v.snapshot, migratedFrom: m.from } : v;
}

/**
 * Validate a current-version snapshot object; any invalid field rejects the whole snapshot.
 *
 * A field's path (`contexts[3].masterStack.ratio`) is built only when it is reported: a full
 * snapshot has about 1500 fields, and building every path took most of the 2.3 ms that
 * validation cost on KWin's thread in QV4 (measured, probes/persistence/cost). A path is a list
 * name, an index (-1 for none) and a field suffix.
 */
export function validate(raw: unknown): Parsed {
  const errs: string[] = [];
  const o = record(raw, "snapshot", -1, "", TOP_KEYS, errs);
  if (!o) return bad(errs[0]);
  if (o.schemaVersion !== SCHEMA_VERSION) errs.push(`schemaVersion: expected ${SCHEMA_VERSION}`);
  const generation = o.generation;
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 0 || generation > Number.MAX_SAFE_INTEGER) {
    errs.push("generation: must be a non-negative integer");
  }
  if (typeof o.savedAt !== "string" || o.savedAt.length > 64) errs.push("savedAt: must be a string of at most 64 characters");
  const contexts: ContextEntry[] = [];
  const floats: FloatEntry[] = [];
  const cs = o.contexts;
  if (!Array.isArray(cs) || cs.length > MAX_CONTEXTS) errs.push(`contexts: must be an array of at most ${MAX_CONTEXTS}`);
  else {
    const keys = new Set<string>();
    for (let i = 0; i < cs.length; ++i) {
      const e = record(cs[i], "contexts", i, "", CONTEXT_KEYS, errs);
      if (!e) continue;
      const outputKey = id(e.outputKey, "contexts", i, ".outputKey", errs), desktopId = id(e.desktopId, "contexts", i, ".desktopId", errs);
      const activity = id(e.activity, "contexts", i, ".activity", errs);
      let layout: LayoutKind | null = null;
      if (e.layout !== null) {
        if (LAYOUTS.indexOf(e.layout as LayoutKind) < 0) errs.push(`${at("contexts", i, ".layout")}: must be null or one of ${LAYOUTS.join(", ")}`);
        else layout = e.layout as LayoutKind;
      }
      let masterStack: ContextEntry["masterStack"] = null;
      if (e.masterStack !== null) {
        const ms = record(e.masterStack, "contexts", i, ".masterStack", MASTER_KEYS, errs);
        if (ms) {
          const ratio = ms.ratio, count = ms.masterCount;
          if (typeof ratio !== "number" || !(ratio > 0 && ratio < 1)) {
            errs.push(`${at("contexts", i, ".masterStack.ratio")}: must be strictly between 0 and 1`);
          }
          if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > MAX_MASTER_COUNT) {
            errs.push(`${at("contexts", i, ".masterStack.masterCount")}: must be an integer from 0 to ${MAX_MASTER_COUNT}`);
          }
          if (typeof ratio === "number" && typeof count === "number") masterStack = { ratio, masterCount: count };
        }
      }
      const k = outputKey + "␟" + desktopId + "␟" + activity;
      if (keys.has(k)) errs.push(`${at("contexts", i, "")}: duplicate context`);
      keys.add(k);
      contexts.push({ outputKey, desktopId, activity, layout, masterStack });
    }
  }
  const fs = o.floats;
  if (!Array.isArray(fs) || fs.length > MAX_FLOATS) errs.push(`floats: must be an array of at most ${MAX_FLOATS}`);
  else {
    const keys = new Set<string>();
    for (let i = 0; i < fs.length; ++i) {
      const e = record(fs[i], "floats", i, "", FLOAT_KEYS, errs);
      if (!e) continue;
      const appId = id(e.appId, "floats", i, ".appId", errs);
      const resourceName = text(e.resourceName, "floats", i, ".resourceName", errs), role = text(e.role, "floats", i, ".role", errs);
      const r = rectField(e.rect, "floats", i, ".rect", errs), area = rectField(e.area, "floats", i, ".area", errs);
      const outputKey = id(e.outputKey, "floats", i, ".outputKey", errs);
      const windowHint = e.windowHint;
      if (typeof windowHint !== "string" || windowHint.length > MAX_HINT) {
        errs.push(`${at("floats", i, ".windowHint")}: must be a string of at most ${MAX_HINT} characters`);
      }
      // Length-prefixed, so distinct identities never share a key.
      const k = appId.length + ":" + appId + resourceName.length + ":" + resourceName + role;
      if (keys.has(k)) errs.push(`${at("floats", i, "")}: duplicate application identity`);
      keys.add(k);
      if (r && area && typeof windowHint === "string") floats.push({ appId, resourceName, role, rect: r, outputKey, area, windowHint });
    }
  }
  if (errs.length > 0) return bad(errs[0] + (errs.length > 1 ? ` (and ${errs.length - 1} more)` : ""));
  return {
    ok: true, migratedFrom: SCHEMA_VERSION,
    snapshot: { schemaVersion: SCHEMA_VERSION, generation: generation as number, savedAt: o.savedAt as string, contexts, floats },
  };
}

const TOP_KEYS = ["schemaVersion", "generation", "savedAt", "contexts", "floats"];
const CONTEXT_KEYS = ["outputKey", "desktopId", "activity", "layout", "masterStack"];
const MASTER_KEYS = ["ratio", "masterCount"];
const FLOAT_KEYS = ["appId", "resourceName", "role", "rect", "outputKey", "area", "windowHint"];
const RECT_KEYS = ["x", "y", "width", "height"];

function bad(reason: string): Parsed {
  return { ok: false, reason, future: false };
}

/** A reported field path: `list[i]field`, or `list` + `field` without an index. */
function at(list: string, i: number, field: string): string {
  return i < 0 ? list + field : `${list}[${i}]${field}`;
}

function record(v: unknown, list: string, i: number, field: string, keys: readonly string[], errs: string[]): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) { errs.push(`${at(list, i, field)}: must be an object`); return null; }
  const o = v as Record<string, unknown>;
  const own = Object.keys(o);
  if (own.length === keys.length) {
    let all = true;
    for (let j = 0; j < keys.length; ++j) if (!(keys[j] in o)) { all = false; break; }
    if (all) return o; // exactly the expected keys
  }
  const path = at(list, i, field);
  let ok = true;
  for (const k of own) if (keys.indexOf(k) < 0) { errs.push(`${path}.${k}: unknown key`); ok = false; }
  for (const k of keys) if (!(k in o)) { errs.push(`${path}.${k}: missing`); ok = false; }
  return ok ? o : null;
}

function id(v: unknown, list: string, i: number, field: string, errs: string[]): string {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_ID) {
    errs.push(`${at(list, i, field)}: must be a non-empty string of at most ${MAX_ID} characters`);
    return "";
  }
  return v;
}

function text(v: unknown, list: string, i: number, field: string, errs: string[]): string {
  if (typeof v !== "string" || v.length > MAX_ID) { errs.push(`${at(list, i, field)}: must be a string of at most ${MAX_ID} characters`); return ""; }
  return v;
}

function num(o: Record<string, unknown>, k: string, lo: number, hi: number, list: string, i: number, field: string,
  errs: string[]): number | null {
  const x = o[k];
  if (typeof x !== "number" || !Number.isFinite(x) || x < lo || x > hi) {
    errs.push(`${at(list, i, field)}.${k}: must be a number from ${lo} to ${hi}`);
    return null;
  }
  return x;
}

function rectField(v: unknown, list: string, i: number, field: string, errs: string[]): Rect | null {
  const o = record(v, list, i, field, RECT_KEYS, errs);
  if (!o) return null;
  const x = num(o, "x", -MAX_COORD, MAX_COORD, list, i, field, errs), y = num(o, "y", -MAX_COORD, MAX_COORD, list, i, field, errs);
  const width = num(o, "width", 1, MAX_COORD, list, i, field, errs), height = num(o, "height", 1, MAX_COORD, list, i, field, errs);
  return x === null || y === null || width === null || height === null ? null : { x, y, width, height };
}
