// String matchers: exact (default), anchored glob, or explicit regex (CONFIGURATION §4).
//
// Regexes are compiled once at activation. A synchronous RegExp match cannot be interrupted
// inside KWin, so patterns are length-bounded, only the `i` flag is accepted (no `g`/`y`, so
// test() is stateless), and subjects are truncated to MAX_SUBJECT before matching. Globs use
// an iterative matcher rather than a generated regex to avoid backtracking blowups.

import type { StringMatcher } from "./types.ts";
import { MAX_PATTERN, MAX_STRING, at, err, expected, has, isPlainObject, objectWith, str, type Sink } from "./validate.ts";

/** Metadata strings longer than this are matched (and cached) by their prefix. */
export const MAX_SUBJECT = 1024;

export function subject(s: string): string {
  return s.length > MAX_SUBJECT ? s.slice(0, MAX_SUBJECT) : s;
}

/** Accepts "text", {exact}, {glob}, or {regex, flags?}. */
export function compileStringMatcher(s: Sink, v: unknown, path: string): StringMatcher | null {
  if (typeof v === "string") {
    const value = str(s, v, path);
    return value === null ? null : { type: "exact", value };
  }
  if (!isPlainObject(v)) return expected(s, path, "a string or an {exact|glob|regex} matcher", v);
  const keys = Object.keys(v);
  const kind = keys.filter((k) => k === "exact" || k === "glob" || k === "regex");
  if (kind.length !== 1) return err(s, path, "matcher needs exactly one of exact, glob, regex");
  if (kind[0] === "exact") {
    if (!objectWith(s, v, path, ["exact"])) return null;
    const value = str(s, v.exact, at(path, "exact"));
    return value === null ? null : { type: "exact", value };
  }
  if (kind[0] === "glob") {
    if (!objectWith(s, v, path, ["glob"])) return null;
    const pattern = str(s, v.glob, at(path, "glob"));
    if (pattern === null) return null;
    // Wildcard-free globs are exact comparisons.
    return pattern.indexOf("*") < 0 && pattern.indexOf("?") < 0 ? { type: "exact", value: pattern } : { type: "glob", pattern };
  }
  if (!objectWith(s, v, path, ["regex", "flags"])) return null;
  const source = str(s, v.regex, at(path, "regex"), MAX_STRING);
  if (source === null) return null;
  if (source.length > MAX_PATTERN) return err(s, at(path, "regex"), `pattern longer than ${MAX_PATTERN} characters`);
  let flags = "";
  if (has(v, "flags")) {
    const f = str(s, v.flags, at(path, "flags"), 8);
    if (f === null) return null;
    if (f !== "" && f !== "i") return err(s, at(path, "flags"), `unsupported flags "${f}" (only "i" is allowed)`);
    flags = f;
  }
  try {
    return { type: "regex", re: new RegExp(source, flags) };
  } catch (e) {
    return err(s, at(path, "regex"), `invalid regex: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function matchString(m: StringMatcher, value: string): boolean {
  switch (m.type) {
    case "exact": return m.value === value;
    case "glob": return globMatch(m.pattern, value);
    case "regex": return m.re.test(value);
  }
}

/** Anchored, case-sensitive glob: `*` any run (including empty), `?` one UTF-16 unit; no escapes. */
export function globMatch(pattern: string, value: string): boolean {
  const STAR = 42, QMARK = 63;
  const pn = pattern.length, vn = value.length;
  let p = 0, v = 0, star = -1, mark = 0;
  while (v < vn) {
    const pc = p < pn ? pattern.charCodeAt(p) : -1;
    if (pc === STAR) { star = p++; mark = v; }
    else if (pc === QMARK || (pc >= 0 && pc === value.charCodeAt(v))) { ++p; ++v; }
    else if (star >= 0) { p = star + 1; v = ++mark; }
    else return false;
  }
  while (p < pn && pattern.charCodeAt(p) === STAR) ++p;
  return p === pn;
}
