// Configuration vocabulary (CONFIGURATION §2-§5, ADR-008).
// A snapshot is immutable validated data; nothing here is parsed or compiled at resolve time.

import type { Edges } from "../core/geometry.ts";
import type { BspSettings, ContextSettings, LayoutKind, MasterStackSettings, WindowKind } from "../core/types.ts";

export interface ValidationError {
  readonly path: string;     // flat key ("gapInner"), "configJson", or JSON path ("rules[2].actions.colour")
  readonly message: string;
}

/** Context identity and names used by override matchers. */
export interface ContextInfo {
  readonly outputName: string;
  readonly desktopId: string;
  readonly desktopName: string;
  readonly activityId: string;
}

export interface RuleActions {
  readonly mode?: "tiled" | "floating" | "excluded";
  readonly border?: "normal" | "none" | "keep";
  readonly insert?: "end" | "after-focus" | "master";
}

export interface WindowRuleResult {
  /** Rule-derived actions only; type defaults (dialogs float) are the classifier's job. */
  readonly actions: RuleActions;
  /** Every matching rule in application order, including ones whose actions were overridden. */
  readonly ruleIds: readonly string[];
  /** action field -> "rule <id>" (or the built-in exclusion that blocked it). */
  readonly reasons: Readonly<Record<string, string>>;
  /** Built-in exclusion reason ("own", "kind:dock", "special"), if any. */
  readonly blockedBy: string | null;
}

export type DiagnosticsLevel = "off" | "warn" | "info" | "debug";

export interface ConfigSnapshot {
  readonly revision: number;
  /** Fully resolved global settings (builtin < flat < json.defaults). */
  readonly defaults: ContextSettings;
  readonly traceCapacity: number;
  readonly diagnostics: DiagnosticsLevel;
  /** False lets the engine skip rule re-evaluation on title changes (Q03). */
  readonly usesTitleRules: boolean;
  /** @internal compiled overrides/rules and caches; not part of the public contract. */
  readonly compiled: CompiledConfig;
}

export type CompileResult =
  | { readonly ok: true; readonly snapshot: ConfigSnapshot; readonly warnings: readonly ValidationError[] }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

// ---- internal compiled representation ----

/** Deep-partial settings; `outer` may be partial edges after number expansion. */
export interface SettingsPatch {
  enabled?: boolean;
  layout?: LayoutKind;
  gaps?: { inner?: number; outer?: Partial<Edges> };
  masterStack?: Partial<MasterStackSettings>;
  bsp?: Partial<BspSettings>;
  overflow?: "float-new";
  singleWindowGaps?: boolean;
}

export type StringMatcher =
  | { readonly type: "exact"; readonly value: string }
  | { readonly type: "glob"; readonly pattern: string }
  | { readonly type: "regex"; readonly re: RegExp };

export interface CompiledOverride {
  readonly id: string;
  readonly outputName: StringMatcher | null;
  readonly desktopName: StringMatcher | null;
  readonly desktopId: StringMatcher | null;
  readonly activityId: StringMatcher | null;
  readonly set: SettingsPatch;
}

export interface CompiledRule {
  readonly id: string;
  readonly appId: StringMatcher | null;
  readonly resourceName: StringMatcher | null;
  readonly title: StringMatcher | null;
  readonly windowType: ReadonlySet<WindowKind> | null;
  readonly transient: boolean | null;
  readonly actions: RuleActions;
}

/** Title-free part of a window's rule resolution: the shared cache entry (no titles in it). */
export interface RuleBase {
  /** Rules whose title-free matchers passed, in application order; some may still test the title. */
  readonly matched: readonly CompiledRule[];
  /** The final result when none of `matched` tests the title; null otherwise. */
  readonly result: WindowRuleResult | null;
}

export interface CompiledConfig {
  /** Sorted by priority ascending, then declaration order. */
  readonly overrides: readonly CompiledOverride[];
  readonly rules: readonly CompiledRule[];
  /** Base explanation chain for `defaults`, e.g. ["builtin", "flat", "json.defaults"]. */
  readonly baseChain: readonly string[];
  /** Bounded memo tables; mutated only by resolve functions, cleared when full. */
  readonly ruleCache: Map<string, RuleBase>;
  readonly contextCache: Map<string, { readonly settings: ContextSettings; readonly chain: readonly string[] }>;
}
