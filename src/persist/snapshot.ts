// The persisted state snapshot (T27, ADR-013): a small, versioned, validated JSON document of
// layout preferences per context and the user's float rectangles per application. Pure: no I/O.
// Anything invalid rejects the whole snapshot, so a damaged file means defaults, never a half
// applied one (CONFIGURATION §8).

import type { Rect } from "../core/geometry.ts";
import type { ContextKey, LayoutKind } from "../core/types.ts";
import { migrate } from "./migrate.ts";
import type { AppIdentity } from "./match.ts";

export const SCHEMA_VERSION = 1;
/** Bounds of what is kept and accepted (the engine keeps at most 64 retained contexts as well). */
export const MAX_CONTEXTS = 64;
export const MAX_FLOATS = 64;
/** Longest state text parsed at all (a full snapshot is about 25 KB). */
export const MAX_TEXT = 256 * 1024;
const MAX_ID = 512;
const MAX_COORD = 1e6;
const LAYOUTS: readonly LayoutKind[] = ["master-stack", "bsp", "monocle", "floating"];
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
      outputKey: f.float.output, area: plainRect(f.float.area),
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

/** Content without generation and time: two snapshots with the same key need no new write. */
export function contentKey(s: Snapshot): string {
  return JSON.stringify([s.contexts, s.floats]);
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

/** Validate a current-version snapshot object; any invalid field rejects the whole snapshot. */
export function validate(raw: unknown): Parsed {
  const errs: string[] = [];
  const o = record(raw, "snapshot", ["schemaVersion", "generation", "savedAt", "contexts", "floats"], errs);
  if (!o) return bad(errs[0]);
  if (o.schemaVersion !== SCHEMA_VERSION) errs.push(`schemaVersion: expected ${SCHEMA_VERSION}`);
  const generation = o.generation;
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 0 || generation > Number.MAX_SAFE_INTEGER) {
    errs.push("generation: must be a non-negative integer");
  }
  if (typeof o.savedAt !== "string" || o.savedAt.length > 64) errs.push("savedAt: must be a string of at most 64 characters");
  const contexts: ContextEntry[] = [];
  const floats: FloatEntry[] = [];
  if (!Array.isArray(o.contexts) || o.contexts.length > MAX_CONTEXTS) errs.push(`contexts: must be an array of at most ${MAX_CONTEXTS}`);
  else {
    const keys = new Set<string>();
    o.contexts.forEach((c: unknown, i: number) => {
      const p = `contexts[${i}]`;
      const e = record(c, p, ["outputKey", "desktopId", "activity", "layout", "masterStack"], errs);
      if (!e) return;
      const outputKey = id(e.outputKey, `${p}.outputKey`, errs), desktopId = id(e.desktopId, `${p}.desktopId`, errs);
      const activity = id(e.activity, `${p}.activity`, errs);
      let layout: LayoutKind | null = null;
      if (e.layout !== null) {
        if (LAYOUTS.indexOf(e.layout as LayoutKind) < 0) errs.push(`${p}.layout: must be null or one of ${LAYOUTS.join(", ")}`);
        else layout = e.layout as LayoutKind;
      }
      let masterStack: ContextEntry["masterStack"] = null;
      if (e.masterStack !== null) {
        const ms = record(e.masterStack, `${p}.masterStack`, ["ratio", "masterCount"], errs);
        if (ms) {
          const ratio = ms.ratio, count = ms.masterCount;
          if (typeof ratio !== "number" || !(ratio > 0 && ratio < 1)) errs.push(`${p}.masterStack.ratio: must be strictly between 0 and 1`);
          if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > MAX_MASTER_COUNT) {
            errs.push(`${p}.masterStack.masterCount: must be an integer from 0 to ${MAX_MASTER_COUNT}`);
          }
          if (typeof ratio === "number" && typeof count === "number") masterStack = { ratio, masterCount: count };
        }
      }
      const k = `${outputKey}␟${desktopId}␟${activity}`;
      if (keys.has(k)) errs.push(`${p}: duplicate context`);
      keys.add(k);
      contexts.push({ outputKey, desktopId, activity, layout, masterStack });
    });
  }
  if (!Array.isArray(o.floats) || o.floats.length > MAX_FLOATS) errs.push(`floats: must be an array of at most ${MAX_FLOATS}`);
  else {
    const keys = new Set<string>();
    o.floats.forEach((f: unknown, i: number) => {
      const p = `floats[${i}]`;
      const e = record(f, p, ["appId", "resourceName", "role", "rect", "outputKey", "area"], errs);
      if (!e) return;
      const appId = id(e.appId, `${p}.appId`, errs);
      const resourceName = text(e.resourceName, `${p}.resourceName`, errs), role = text(e.role, `${p}.role`, errs);
      const r = rectField(e.rect, `${p}.rect`, errs), area = rectField(e.area, `${p}.area`, errs);
      const outputKey = id(e.outputKey, `${p}.outputKey`, errs);
      const k = JSON.stringify([appId, resourceName, role]);
      if (keys.has(k)) errs.push(`${p}: duplicate application identity`);
      keys.add(k);
      if (r && area) floats.push({ appId, resourceName, role, rect: r, outputKey, area });
    });
  }
  if (errs.length > 0) return bad(errs[0] + (errs.length > 1 ? ` (and ${errs.length - 1} more)` : ""));
  return {
    ok: true, migratedFrom: SCHEMA_VERSION,
    snapshot: { schemaVersion: SCHEMA_VERSION, generation: generation as number, savedAt: o.savedAt as string, contexts, floats },
  };
}

function bad(reason: string): Parsed {
  return { ok: false, reason, future: false };
}

function record(v: unknown, path: string, keys: readonly string[], errs: string[]): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) { errs.push(`${path}: must be an object`); return null; }
  const o = v as Record<string, unknown>;
  let ok = true;
  for (const k of Object.keys(o)) if (keys.indexOf(k) < 0) { errs.push(`${path}.${k}: unknown key`); ok = false; }
  for (const k of keys) if (!(k in o)) { errs.push(`${path}.${k}: missing`); ok = false; }
  return ok ? o : null;
}

function id(v: unknown, path: string, errs: string[]): string {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_ID) { errs.push(`${path}: must be a non-empty string of at most ${MAX_ID} characters`); return ""; }
  return v;
}

function text(v: unknown, path: string, errs: string[]): string {
  if (typeof v !== "string" || v.length > MAX_ID) { errs.push(`${path}: must be a string of at most ${MAX_ID} characters`); return ""; }
  return v;
}

function rectField(v: unknown, path: string, errs: string[]): Rect | null {
  const o = record(v, path, ["x", "y", "width", "height"], errs);
  if (!o) return null;
  const n = (k: string, lo: number, hi: number): number | null => {
    const x = o[k];
    if (typeof x !== "number" || !Number.isFinite(x) || x < lo || x > hi) { errs.push(`${path}.${k}: must be a number from ${lo} to ${hi}`); return null; }
    return x;
  };
  const x = n("x", -MAX_COORD, MAX_COORD), y = n("y", -MAX_COORD, MAX_COORD);
  const width = n("width", 1, MAX_COORD), height = n("height", 1, MAX_COORD);
  return x === null || y === null || width === null || height === null ? null : { x, y, width, height };
}
