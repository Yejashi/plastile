// Validation primitives shared by the flat-key and JSON schema readers.
// Every check records an error with its path and returns null instead of throwing.

import type { ValidationError } from "./types.ts";

export const MAX_STRING = 512;
export const MAX_PATTERN = 256;
export const MAX_RULES = 256;
export const MAX_OVERRIDES = 64;
export const MAX_ERRORS = 100;
export const MAX_JSON_LENGTH = 524288; // 512 KiB of configJson text
export const MAX_GAP = 200;
export const MAX_MASTER_COUNT = 8;
export const MAX_RATIO_STEP = 0.5;
export const MIN_TRACE = 64;
export const MAX_TRACE = 65536;

export interface Sink {
  readonly errors: ValidationError[];
  readonly warnings: ValidationError[];
}

export function sink(): Sink {
  return { errors: [], warnings: [] };
}

export function err(s: Sink, path: string, message: string): null {
  if (s.errors.length < MAX_ERRORS) s.errors.push({ path, message });
  else if (s.errors.length === MAX_ERRORS) s.errors.push({ path: "", message: "too many errors; further errors suppressed" });
  return null;
}

export function warn(s: Sink, path: string, message: string): void {
  if (s.warnings.length < MAX_ERRORS) s.warnings.push({ path, message });
}

export function at(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

export function idx(path: string, i: number): string {
  return `${path}[${i}]`;
}

export function has(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function expected(s: Sink, path: string, what: string, v: unknown): null {
  return err(s, path, v === null ? `must be ${what} (null is not allowed; omit the field to inherit)` : `must be ${what}`);
}

/**
 * Plain object check; each key outside `keys` is its own error. The object is still
 * returned so validation continues and reports every problem in one pass.
 */
export function objectWith(s: Sink, v: unknown, path: string, keys: readonly string[]): Record<string, unknown> | null {
  if (!isPlainObject(v)) return expected(s, path || "configJson", "an object", v);
  for (const k of Object.keys(v)) {
    if (keys.indexOf(k) < 0) err(s, at(path, k), "unknown key");
  }
  return v;
}

export function finite(s: Sink, v: unknown, path: string): number | null {
  if (typeof v !== "number") return expected(s, path, "a finite number", v);
  if (!isFinite(v)) return err(s, path, "must be a finite number");
  return v;
}

export function intIn(s: Sink, v: number | null, path: string, min: number, max: number): number | null {
  if (v === null) return null;
  if (!(v % 1 === 0) || v < min || v > max) return err(s, path, `must be an integer in ${min}..${max}`);
  return v;
}

/** Ratio strictly inside (0, 1). */
export function openRatio(s: Sink, v: number | null, path: string): number | null {
  if (v === null) return null;
  if (!(v > 0 && v < 1)) return err(s, path, "must be strictly between 0 and 1");
  return v;
}

/** Resize step in (0, MAX_RATIO_STEP]. */
export function ratioStep(s: Sink, v: number | null, path: string): number | null {
  if (v === null) return null;
  if (!(v > 0 && v <= MAX_RATIO_STEP)) return err(s, path, `must be greater than 0 and at most ${MAX_RATIO_STEP}`);
  return v;
}

export function bool(s: Sink, v: unknown, path: string): boolean | null {
  return typeof v === "boolean" ? v : expected(s, path, "a boolean", v);
}

export function str(s: Sink, v: unknown, path: string, max = MAX_STRING): string | null {
  if (typeof v !== "string") return expected(s, path, "a string", v);
  if (v.length > max) return err(s, path, `longer than ${max} characters`);
  return v;
}

export function oneOf<T extends string>(s: Sink, v: unknown, path: string, values: readonly T[]): T | null {
  if (typeof v === "string" && (values as readonly string[]).indexOf(v) >= 0) return v as T;
  return expected(s, path, `one of ${values.map((x) => `"${x}"`).join(", ")}`, v);
}
