// What a configuration activation changed, so the engine invalidates only what depends on it
// (T26, BEHAVIOR §12: a gap/ratio change recomputes only affected contexts; a rule change
// reevaluates rule matches). Runs once per activation, never on the command path.

import type { ConfigSnapshot } from "./types.ts";

export interface ConfigDiff {
  /** Window rule matching may give other results: re-evaluate rules (reclassify). */
  readonly rules: boolean;
  /** Context settings may resolve differently (defaults or overrides): compare per context. */
  readonly settings: boolean;
  /** Diagnostics level or trace capacity. */
  readonly diagnostics: boolean;
}

/**
 * Compare two validated snapshots structurally. Compiled matchers compare by pattern and
 * flags and window-type sets by content, so recompiling an unchanged document reports no
 * change. Without a previous snapshot everything counts as changed.
 */
export function diffConfig(prev: ConfigSnapshot | null, next: ConfigSnapshot): ConfigDiff {
  if (prev === null) return { rules: true, settings: true, diagnostics: true };
  return {
    rules: canonical(prev.compiled.rules) !== canonical(next.compiled.rules),
    settings: canonical(prev.defaults) !== canonical(next.defaults) ||
      canonical(prev.compiled.overrides) !== canonical(next.compiled.overrides),
    diagnostics: prev.diagnostics !== next.diagnostics || prev.traceCapacity !== next.traceCapacity,
  };
}

function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    if (x instanceof RegExp) return `/${x.source}/${x.flags}`;
    if (x instanceof Set) return Array.from(x as Set<unknown>).map(String).sort();
    if (x === Infinity) return "Infinity";
    return x;
  });
}
