// Configuration vocabulary (CONFIGURATION §2-§5, ADR-008).
// A snapshot is immutable validated data; nothing here is parsed or compiled at resolve time.

import type { Edges } from "../core/geometry.ts";
import type { BspSettings, ContextSettings, LayoutKind, MasterStackSettings, ScrollingSettings, WindowKind } from "../core/types.ts";

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
  /** Minimum usable frame size for the window's tile (logical px, 0 = no preference); a smaller slot overflows. */
  readonly minSize?: { readonly width: number; readonly height: number };
  /** Zones layout (experimental): assign the window to this zone (1-based) when it joins a zones context. */
  readonly zone?: number;
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

/** Log threshold. Notices (start, stop, a layout a command chose, pause) show at every level but error and off. */
export type DiagnosticsLevel = "off" | "error" | "warn" | "info" | "debug";

export interface ConfigSnapshot {
  readonly revision: number;
  /** Fully resolved global settings (builtin < flat < json.defaults). */
  readonly defaults: ContextSettings;
  readonly traceCapacity: number;
  readonly diagnostics: DiagnosticsLevel;
  /** Plasma's on-screen display for a layout a command chose and for pause/resume (flat key `osd`). */
  readonly osd: boolean;
  /** False lets the engine skip rule re-evaluation on title changes (Q03). */
  readonly usesTitleRules: boolean;
  /** Some override or rule matches desktop names: a desktop rename must re-resolve. */
  readonly usesDesktopNames: boolean;
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
  scrolling?: Partial<ScrollingSettings>;
  /** Only the selection: the zone layouts themselves come from the top-level `zoneLayouts`. */
  zones?: { layout?: string };
  overflow?: "float-new";
  singleWindowGaps?: boolean;
  followOnSend?: boolean;
  focusWrap?: boolean;
  liveResize?: boolean;
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
  /** Context matchers (CONFIGURATION §4), tested against the window's single context only. */
  readonly outputName: StringMatcher | null;
  readonly desktopName: StringMatcher | null;
  readonly desktopId: StringMatcher | null;
  readonly activityId: StringMatcher | null;
  /** At least one context matcher is set. */
  readonly contextual: boolean;
  readonly actions: RuleActions;
}

/**
 * Metadata part of a window's rule resolution: the shared cache entry. Neither titles nor
 * contexts enter it, so a title or membership change re-runs only the matchers that read them.
 */
export interface RuleBase {
  /** Rules whose metadata matchers passed, in application order; some may still test the title or context. */
  readonly matched: readonly CompiledRule[];
  /** The final result when none of `matched` tests the title or the context; null otherwise. */
  readonly result: WindowRuleResult | null;
  readonly titled: boolean;
  readonly contextual: boolean;
  /** Without title rules: results per context key (bounded; mutated only by resolveWindow). */
  readonly byContext: Map<string, WindowRuleResult> | null;
}

export interface CompiledConfig {
  /** Sorted by priority ascending, then declaration order. */
  readonly overrides: readonly CompiledOverride[];
  readonly rules: readonly CompiledRule[];
  /** The rules with context matchers, in application order. */
  readonly contextualRules: readonly CompiledRule[];
  /** Base explanation chain for `defaults`, e.g. ["builtin", "flat", "json.defaults"]. */
  readonly baseChain: readonly string[];
  /** Bounded memo tables; mutated only by resolve functions, cleared when full. */
  readonly ruleCache: Map<string, RuleBase>;
  readonly contextCache: Map<string, { readonly settings: ContextSettings; readonly chain: readonly string[] }>;
  /** Per context key: the contextual rules whose context matchers pass there. */
  readonly ruleContextCache: Map<string, ReadonlySet<CompiledRule>>;
}
