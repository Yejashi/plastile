// Activation transaction: read → validate → normalize → compile matchers → immutable snapshot
// (CONFIGURATION §5). On failure nothing is published; the caller keeps its previous revision.

import { DEFAULT_SETTINGS } from "../core/defaults.ts";
import { applyPatch, cloneSettings, freezeSettings, isEmptyPatch } from "./patch.ts";
import { readDocument, readFlat, type Ordered } from "./schema.ts";
import type { CompileResult, ConfigSnapshot, DiagnosticsLevel } from "./types.ts";
import { sink } from "./validate.ts";

export const DEFAULT_TRACE_CAPACITY = 2048;
export const DEFAULT_DIAGNOSTICS: DiagnosticsLevel = "warn";

/** Priority ascending, then declaration order (explicit tiebreak; sort stability is not assumed). */
function ordered<T>(list: readonly Ordered<T>[]): T[] {
  return list.slice().sort((a, b) => a.priority - b.priority || a.index - b.index).map((o) => o.item);
}

/** Never throws: every problem, including unexpected exceptions, becomes an error entry. */
export function compileConfig(flat: Readonly<Record<string, unknown>>, revision: number): CompileResult {
  try {
    const s = sink();
    const f = readFlat(s, flat);
    const doc = f.json !== null ? readDocument(s, f.json) : null;
    if (s.errors.length > 0) return { ok: false, errors: s.errors };

    const chain = ["builtin"];
    let defaults = cloneSettings(DEFAULT_SETTINGS);
    if (!isEmptyPatch(f.patch)) { defaults = applyPatch(defaults, f.patch); chain.push("flat"); }
    if (doc && doc.defaults && !isEmptyPatch(doc.defaults)) { defaults = applyPatch(defaults, doc.defaults); chain.push("json.defaults"); }

    const diag = doc ? doc.diagnostics : {};
    const rules = doc ? ordered(doc.rules) : [];
    let usesTitleRules = false;
    for (const r of rules) if (r.title) usesTitleRules = true;

    const snapshot: ConfigSnapshot = Object.freeze({
      revision,
      defaults: freezeSettings(defaults),
      traceCapacity: diag.traceCapacity !== undefined ? diag.traceCapacity
        : f.diagnostics.traceCapacity !== undefined ? f.diagnostics.traceCapacity : DEFAULT_TRACE_CAPACITY,
      diagnostics: diag.level !== undefined ? diag.level
        : f.diagnostics.level !== undefined ? f.diagnostics.level : DEFAULT_DIAGNOSTICS,
      usesTitleRules,
      compiled: Object.freeze({
        overrides: Object.freeze(doc ? ordered(doc.overrides) : []),
        rules: Object.freeze(rules),
        baseChain: Object.freeze(chain),
        ruleCache: new Map(),
        contextCache: new Map(),
      }),
    });
    return { ok: true, snapshot, warnings: s.warnings };
  } catch (e) {
    return { ok: false, errors: [{ path: "", message: `internal error: ${e instanceof Error ? e.message : String(e)}` }] };
  }
}
