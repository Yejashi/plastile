// Resolution against a compiled snapshot: no parsing or regex compilation happens here.
// Results are memoized in bounded tables inside the snapshot and returned frozen.

import type { ContextSettings, WindowKind, WindowMeta } from "../core/types.ts";
import { matchString, subject } from "./matchers.ts";
import { applyPatch, freezeSettings } from "./patch.ts";
import type { ConfigSnapshot, ContextInfo, RuleActions, StringMatcher, WindowRuleResult } from "./types.ts";
import { EXCLUDED_KINDS } from "../core/classify.ts";

export const RULE_CACHE_LIMIT = 512;
export const CONTEXT_CACHE_LIMIT = 64;

/** Built-in exclusions (CONFIGURATION §3): rules can never make these ordinary tiles.
 *  The classifier owns the list; this is a re-export for config explanations. */
export const BUILTIN_EXCLUDED_KINDS: readonly WindowKind[] = Array.from(EXCLUDED_KINDS);

export interface ContextResolution {
  readonly settings: ContextSettings;
  /** e.g. ["builtin", "flat", "json.defaults", "override wide-display"] */
  readonly chain: readonly string[];
}

function part(s: string): string {
  return `${s.length}:${s}`;
}

function opt(m: StringMatcher | null, value: string): boolean {
  return m === null || matchString(m, value);
}

export function resolveContext(snap: ConfigSnapshot, ctx: ContextInfo): ContextResolution {
  const c = snap.compiled;
  if (c.overrides.length === 0) return { settings: snap.defaults, chain: c.baseChain };
  const outputName = subject(ctx.outputName), desktopName = subject(ctx.desktopName);
  const desktopId = subject(ctx.desktopId), activityId = subject(ctx.activityId);
  const key = part(outputName) + part(desktopName) + part(desktopId) + part(activityId);
  const hit = c.contextCache.get(key);
  if (hit) return hit;

  let settings = snap.defaults;
  let chain: string[] | null = null;
  for (const o of c.overrides) {
    if (!opt(o.outputName, outputName) || !opt(o.desktopName, desktopName) ||
        !opt(o.desktopId, desktopId) || !opt(o.activityId, activityId)) continue;
    settings = applyPatch(settings, o.set);
    if (!chain) chain = c.baseChain.slice();
    chain.push(`override ${o.id}`);
  }
  const out: ContextResolution = Object.freeze(chain
    ? { settings: freezeSettings(settings), chain: Object.freeze(chain) }
    : { settings: snap.defaults, chain: c.baseChain });
  if (c.contextCache.size >= CONTEXT_CACHE_LIMIT) c.contextCache.clear();
  c.contextCache.set(key, out);
  return out;
}

/** Everything rule matching and built-in exclusion read; the title only when a rule uses it (Q03). */
export function ruleCacheKey(meta: WindowMeta, snap: ConfigSnapshot): string {
  const flags = (meta.transient ? "t" : "-") + (meta.special ? "s" : "-") + (meta.own ? "o" : "-");
  const key = `${meta.kind}|${flags}|${part(subject(meta.appId))}${part(subject(meta.resourceName))}`;
  return snap.usesTitleRules ? key + subject(meta.title) : key;
}

function builtinBlock(meta: WindowMeta): string | null {
  if (meta.own) return "own";
  if (BUILTIN_EXCLUDED_KINDS.indexOf(meta.kind) >= 0) return `kind:${meta.kind}`;
  if (meta.special) return "special";
  return null;
}

/** Context-independent today (rules have no context matchers yet); `_ctx` is reserved for them. */
export function resolveWindow(snap: ConfigSnapshot, meta: WindowMeta, _ctx: ContextInfo | null): WindowRuleResult {
  const c = snap.compiled;
  const key = ruleCacheKey(meta, snap);
  const hit = c.ruleCache.get(key);
  if (hit) return hit;

  const appId = subject(meta.appId), resourceName = subject(meta.resourceName);
  const title = snap.usesTitleRules ? subject(meta.title) : "";
  const actions: { mode?: RuleActions["mode"]; border?: RuleActions["border"]; insert?: RuleActions["insert"] } = {};
  const reasons: Record<string, string> = {};
  const ruleIds: string[] = [];
  for (const r of c.rules) {
    if (r.windowType && !r.windowType.has(meta.kind)) continue;
    if (r.transient !== null && r.transient !== meta.transient) continue;
    if (!opt(r.appId, appId) || !opt(r.resourceName, resourceName) || !opt(r.title, title)) continue;
    ruleIds.push(r.id);
    const a = r.actions;
    if (a.mode !== undefined) { actions.mode = a.mode; reasons.mode = `rule ${r.id}`; }
    if (a.border !== undefined) { actions.border = a.border; reasons.border = `rule ${r.id}`; }
    if (a.insert !== undefined) { actions.insert = a.insert; reasons.insert = `rule ${r.id}`; }
  }

  const blockedBy = builtinBlock(meta);
  let result: WindowRuleResult;
  if (blockedBy === null) {
    result = { actions: Object.freeze(actions), ruleIds: Object.freeze(ruleIds), reasons: Object.freeze(reasons), blockedBy };
  } else {
    // The exclusion wins; attempted rule actions stay visible in the explanation.
    const blocked: Record<string, string> = { mode: `builtin ${blockedBy}` };
    for (const f of Object.keys(reasons)) {
      blocked[f] = f === "mode" ? `builtin ${blockedBy}; ignored ${reasons[f]}` : `ignored (builtin ${blockedBy}): ${reasons[f]}`;
    }
    result = { actions: Object.freeze({ mode: "excluded" as const }), ruleIds: Object.freeze(ruleIds), reasons: Object.freeze(blocked), blockedBy };
  }
  Object.freeze(result);
  if (c.ruleCache.size >= RULE_CACHE_LIMIT) c.ruleCache.clear();
  c.ruleCache.set(key, result);
  return result;
}
