// Schema migrations for the persisted state snapshot (T27, CONFIGURATION §8). Pure functions:
// one step per version, from version n to n + 1, applied in order up to the current version.
// A snapshot from a newer Plastile is rejected, never downgraded.

/** A raw snapshot object as parsed from JSON, before validation. */
export type RawSnapshot = Record<string, unknown>;

/** One migration: the snapshot of version n in, the same data in version n + 1 out. */
export type Step = (raw: RawSnapshot) => RawSnapshot;

/**
 * Steps by source version. Version 1 is the first schema that shipped, so there is nothing to
 * migrate yet; the next schema change adds `1: (v1) => v2` here with input/output fixtures in
 * tests/fixtures/persist/.
 */
export const MIGRATIONS: Readonly<Record<number, Step>> = {};

export type Migrated =
  | { readonly ok: true; readonly value: RawSnapshot; readonly from: number }
  | { readonly ok: false; readonly reason: string; readonly future: boolean };

/** Bring a parsed snapshot to `target`, or say why it cannot be. */
export function migrate(raw: unknown, target: number, steps: Readonly<Record<number, Step>> = MIGRATIONS): Migrated {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("not an object");
  const v = (raw as RawSnapshot).schemaVersion;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return fail("schemaVersion is missing or not a positive integer");
  if (v > target) return { ok: false, reason: `schema version ${v} is newer than this Plastile's ${target}`, future: true };
  let cur = raw as RawSnapshot;
  for (let n = v; n < target; ++n) {
    const step = steps[n];
    if (!step) return fail(`no migration from schema version ${n}`);
    cur = step(cur);
    if (typeof cur !== "object" || cur === null || cur.schemaVersion !== n + 1) return fail(`migration from version ${n} failed`);
  }
  return { ok: true, value: cur, from: v };
}

function fail(reason: string): Migrated {
  return { ok: false, reason, future: false };
}
