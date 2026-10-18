// Activation transaction: read → validate → normalize → compile matchers → immutable snapshot
// (CONFIGURATION §5). On failure nothing is published; the caller keeps its previous revision.

import { DEFAULT_SETTINGS } from "../core/defaults.ts";
import { applyPatch, cloneSettings, freezeSettings, isEmptyPatch } from "./patch.ts";
import { mergeZoneLayouts, readDocument, readFlat, type Ordered } from "./schema.ts";
import type { CompileResult, ConfigSnapshot, DiagnosticsLevel } from "./types.ts";
import { err, sink } from "./validate.ts";

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
    if (doc && doc.zoneLayouts) {
      // Zone layouts are one list for every context; contexts select one by id (zones.layout).
      defaults = { ...defaults, zones: { layout: defaults.zones.layout, layouts: mergeZoneLayouts(defaults.zones.layouts, doc.zoneLayouts) } };
    }
    if (!isEmptyPatch(f.patch)) { defaults = applyPatch(defaults, f.patch); chain.push("flat"); }
    if (doc && doc.defaults && !isEmptyPatch(doc.defaults)) { defaults = applyPatch(defaults, doc.defaults); chain.push("json.defaults"); }
    if (doc) {
      const known = defaults.zones.layouts.map((l) => l.id);
      const check = (id: string | undefined, path: string): void => {
        if (id !== undefined && known.indexOf(id) < 0) {
          err(s, path, `unknown zone layout "${id}" (known: ${known.join(", ")}; add it to zoneLayouts)`);
        }
      };
      check(doc.defaults?.zones?.layout, "defaults.zones.layout");
      for (const o of doc.overrides) check(o.item.set.zones?.layout, `overrides[${o.index}].set.zones.layout`);
      if (s.errors.length > 0) return { ok: false, errors: s.errors };
    }

    const diag = doc ? doc.diagnostics : {};
    const rules = doc ? ordered(doc.rules) : [];
    const overrides = doc ? ordered(doc.overrides) : [];
    let usesTitleRules = false, usesDesktopNames = false;
    for (const r of rules) {
      if (r.title) usesTitleRules = true;
      if (r.desktopName) usesDesktopNames = true;
    }
    for (const o of overrides) if (o.desktopName) usesDesktopNames = true;

    const snapshot: ConfigSnapshot = Object.freeze({
      revision,
      defaults: freezeSettings(defaults),
      traceCapacity: diag.traceCapacity !== undefined ? diag.traceCapacity
        : f.diagnostics.traceCapacity !== undefined ? f.diagnostics.traceCapacity : DEFAULT_TRACE_CAPACITY,
      diagnostics: diag.level !== undefined ? diag.level
        : f.diagnostics.level !== undefined ? f.diagnostics.level : DEFAULT_DIAGNOSTICS,
      usesTitleRules,
      usesDesktopNames,
      compiled: Object.freeze({
        overrides: Object.freeze(overrides),
        rules: Object.freeze(rules),
        contextualRules: Object.freeze(rules.filter((r) => r.contextual)),
        baseChain: Object.freeze(chain),
        ruleCache: new Map(),
        contextCache: new Map(),
        ruleContextCache: new Map(),
      }),
    });
    return { ok: true, snapshot, warnings: s.warnings };
  } catch (e) {
    return { ok: false, errors: [{ path: "", message: `internal error: ${e instanceof Error ? e.message : String(e)}` }] };
  }
}
