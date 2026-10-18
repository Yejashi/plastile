// Resolution against a compiled snapshot: no parsing or regex compilation happens here.
// Results are memoized in bounded tables inside the snapshot and returned frozen.

import type { ContextSettings, WindowKind, WindowMeta } from "../core/types.ts";
import { matchString, subject } from "./matchers.ts";
import { applyPatch, freezeSettings } from "./patch.ts";
import type { CompiledConfig, CompiledRule, ConfigSnapshot, ContextInfo, RuleActions, RuleBase, StringMatcher, WindowRuleResult } from "./types.ts";
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

/**
 * Shared-cache key: everything title-free rule matching and built-in exclusion read. Titles
 * never enter it, so a busy title neither misses nor evicts other windows' entries (Q03,
 * CONFIGURATION §4). `_snap` is kept for callers of the earlier signature.
 */
export function ruleCacheKey(meta: WindowMeta, _snap?: ConfigSnapshot): string {
  const flags = (meta.transient ? "t" : "-") + (meta.special ? "s" : "-") + (meta.own ? "o" : "-");
  return `${meta.kind}|${flags}|${part(subject(meta.appId))}${part(subject(meta.resourceName))}`;
}

function builtinBlock(meta: WindowMeta): string | null {
  if (meta.own) return "own";
  if (BUILTIN_EXCLUDED_KINDS.indexOf(meta.kind) >= 0) return `kind:${meta.kind}`;
  if (meta.special) return "special";
  return null;
}

/** Title-free matching, memoized: each rule's appId/resourceName/type matchers run once per metadata. */
function ruleBase(c: CompiledConfig, meta: WindowMeta): RuleBase {
  const key = ruleCacheKey(meta);
  const hit = c.ruleCache.get(key);
  if (hit) return hit;
  const appId = subject(meta.appId), resourceName = subject(meta.resourceName);
  const matched: CompiledRule[] = [];
  let titled = false;
  for (const r of c.rules) {
    if (r.windowType && !r.windowType.has(meta.kind)) continue;
    if (r.transient !== null && r.transient !== meta.transient) continue;
    if (!opt(r.appId, appId) || !opt(r.resourceName, resourceName)) continue;
    matched.push(r);
    if (r.title !== null) titled = true;
  }
  const base: RuleBase = Object.freeze({ matched: Object.freeze(matched), result: titled ? null : build(matched, meta) });
  if (c.ruleCache.size >= RULE_CACHE_LIMIT) c.ruleCache.clear();
  c.ruleCache.set(key, base);
  return base;
}

/** Apply matched rules in order (later rules win per field); a built-in exclusion overrides them. */
function build(rules: readonly CompiledRule[], meta: WindowMeta): WindowRuleResult {
  const actions: { mode?: RuleActions["mode"]; border?: RuleActions["border"]; insert?: RuleActions["insert"] } = {};
  const reasons: Record<string, string> = {};
  const ruleIds: string[] = [];
  for (const r of rules) {
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
  return Object.freeze(result);
}

/**
 * Context-independent today (rules have no context matchers yet); `_ctx` is reserved for them.
 * Without title rules among the candidates the cached result is returned as is. Otherwise only
 * the title matchers of rules whose other matchers already passed run against the current
 * title (CONFIGURATION §4: "Title change; evaluate only rules that use title"); per-title
 * results are not cached.
 */
export function resolveWindow(snap: ConfigSnapshot, meta: WindowMeta, _ctx: ContextInfo | null): WindowRuleResult {
  const base = ruleBase(snap.compiled, meta);
  if (base.result) return base.result;
  const title = subject(meta.title);
  const rules: CompiledRule[] = [];
  for (const r of base.matched) if (r.title === null || matchString(r.title, title)) rules.push(r);
  return build(rules, meta);
}
