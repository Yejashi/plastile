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

/** Memo key for a context: every field a context matcher reads (never empty). */
function contextKey(ctx: ContextInfo): string {
  return part(subject(ctx.outputName)) + part(subject(ctx.desktopName)) + part(subject(ctx.desktopId)) +
    part(subject(ctx.activityId));
}

function contextMatches(m: { readonly outputName: StringMatcher | null; readonly desktopName: StringMatcher | null;
                             readonly desktopId: StringMatcher | null; readonly activityId: StringMatcher | null },
                        ctx: ContextInfo): boolean {
  return opt(m.outputName, subject(ctx.outputName)) && opt(m.desktopName, subject(ctx.desktopName)) &&
    opt(m.desktopId, subject(ctx.desktopId)) && opt(m.activityId, subject(ctx.activityId));
}

export function resolveContext(snap: ConfigSnapshot, ctx: ContextInfo): ContextResolution {
  const c = snap.compiled;
  if (c.overrides.length === 0) return { settings: snap.defaults, chain: c.baseChain };
  const key = contextKey(ctx);
  const hit = c.contextCache.get(key);
  if (hit) return hit;

  let settings = snap.defaults;
  let chain: string[] | null = null;
  for (const o of c.overrides) {
    if (!contextMatches(o, ctx)) continue;
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

/**
 * Metadata matching, memoized: each rule's appId/resourceName/type matchers run once per
 * metadata. Title and context matchers are not run here.
 */
function ruleBase(c: CompiledConfig, meta: WindowMeta): RuleBase {
  const key = ruleCacheKey(meta);
  const hit = c.ruleCache.get(key);
  if (hit) return hit;
  const appId = subject(meta.appId), resourceName = subject(meta.resourceName);
  const matched: CompiledRule[] = [];
  let titled = false, contextual = false;
  for (const r of c.rules) {
    if (r.windowType && !r.windowType.has(meta.kind)) continue;
    if (r.transient !== null && r.transient !== meta.transient) continue;
    if (!opt(r.appId, appId) || !opt(r.resourceName, resourceName)) continue;
    matched.push(r);
    if (r.title !== null) titled = true;
    if (r.contextual) contextual = true;
  }
  const base: RuleBase = Object.freeze({
    matched: Object.freeze(matched), result: titled || contextual ? null : build(matched, meta), titled, contextual,
    byContext: contextual && !titled ? new Map<string, WindowRuleResult>() : null,
  });
  if (c.ruleCache.size >= RULE_CACHE_LIMIT) c.ruleCache.clear();
  c.ruleCache.set(key, base);
  return base;
}

/**
 * The contextual rules whose output/desktop/activity matchers pass in one context, memoized
 * per context: a window joining a context re-runs no metadata matcher, and a metadata change
 * re-runs no context matcher (CONFIGURATION §4 cache invalidation).
 */
function contextPasses(c: CompiledConfig, ctx: ContextInfo, key: string): ReadonlySet<CompiledRule> {
  const hit = c.ruleContextCache.get(key);
  if (hit) return hit;
  const pass = new Set<CompiledRule>();
  for (const r of c.contextualRules) if (contextMatches(r, ctx)) pass.add(r);
  if (c.ruleContextCache.size >= CONTEXT_CACHE_LIMIT) c.ruleContextCache.clear();
  c.ruleContextCache.set(key, pass);
  return pass;
}

/** Apply matched rules in order (later rules win per field); a built-in exclusion overrides them. */
function build(rules: readonly CompiledRule[], meta: WindowMeta): WindowRuleResult {
  const actions: { mode?: RuleActions["mode"]; border?: RuleActions["border"]; insert?: RuleActions["insert"];
                   minSize?: RuleActions["minSize"]; zone?: number } = {};
  const reasons: Record<string, string> = {};
  const ruleIds: string[] = [];
  for (const r of rules) {
    ruleIds.push(r.id);
    const a = r.actions;
    if (a.mode !== undefined) { actions.mode = a.mode; reasons.mode = `rule ${r.id}`; }
    if (a.border !== undefined) { actions.border = a.border; reasons.border = `rule ${r.id}`; }
    if (a.insert !== undefined) { actions.insert = a.insert; reasons.insert = `rule ${r.id}`; }
    if (a.minSize !== undefined) { actions.minSize = a.minSize; reasons.minSize = `rule ${r.id}`; }
    if (a.zone !== undefined) { actions.zone = a.zone; reasons.zone = `rule ${r.id}`; }
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
 * Rules for a window in its context (`ctx`: null when the window has no single context; then
 * no rule with a context matcher applies). Without title or context rules among the
 * candidates the cached result is returned as is. Context matchers come from a per-context
 * memo, and a context-dependent result without title rules is memoized per context. Title
 * matchers run only for rules whose other matchers passed, against the current title
 * (CONFIGURATION §4: "Title change; evaluate only rules that use title"); per-title results
 * are not cached.
 */
export function resolveWindow(snap: ConfigSnapshot, meta: WindowMeta, ctx: ContextInfo | null): WindowRuleResult {
  const c = snap.compiled;
  const base = ruleBase(c, meta);
  if (base.result) return base.result;
  let rules = base.matched;
  if (base.contextual) {
    const key = ctx === null ? "" : contextKey(ctx);
    const byContext = base.byContext;
    if (byContext) {
      const hit = byContext.get(key);
      if (hit) return hit;
    }
    const pass = ctx === null ? null : contextPasses(c, ctx, key);
    const inContext: CompiledRule[] = [];
    for (const r of rules) if (!r.contextual || (pass !== null && pass.has(r))) inContext.push(r);
    if (byContext) {
      const out = build(inContext, meta);
      if (byContext.size >= CONTEXT_CACHE_LIMIT) byContext.clear();
      byContext.set(key, out);
      return out;
    }
    rules = inContext;
  }
  const title = subject(meta.title);
  const titled: CompiledRule[] = [];
  for (const r of rules) if (r.title === null || matchString(r.title, title)) titled.push(r);
  return build(titled, meta);
}
