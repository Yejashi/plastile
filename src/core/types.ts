// Core vocabulary shared by the model, layouts, scheduler and adapters.
// Everything here is plain data: no live KWin objects cross this boundary.

import type { Rect, Size } from "./geometry.ts";

export type WindowId = string;
export type ContextId = string;
export type OutputId = string;
export type DesktopId = string;
export type ActivityId = string;

/** Full layout context identity (ADR-009). Never inferred later from global state. */
export interface ContextKey {
  readonly output: OutputId;
  readonly desktop: DesktopId;
  readonly activity: ActivityId;
}

export function contextId(k: ContextKey): ContextId {
  return `${k.output}␟${k.desktop}␟${k.activity}`;
}

export function sameContext(a: ContextKey | null, b: ContextKey | null): boolean {
  return !!a && !!b && a.output === b.output && a.desktop === b.desktop && a.activity === b.activity;
}

/** Window type as normalized by the adapter. */
export type WindowKind =
  | "normal" | "dialog" | "utility" | "toolbar" | "menu" | "splash" | "dock" | "desktop"
  | "notification" | "tooltip" | "popup" | "osd" | "applet-popup" | "dnd-icon" | "other";

/** Metadata snapshot taken by the adapter at event time. */
export interface WindowMeta {
  readonly appId: string;          // normalized: Wayland app_id or X11 resource class
  readonly resourceName: string;
  readonly title: string;
  readonly role: string;
  readonly kind: WindowKind;
  readonly transient: boolean;
  readonly transientFor: WindowId | null;
  readonly modal: boolean;
  readonly special: boolean;        // KWin specialWindow
  readonly managed: boolean;
  readonly resizeable: boolean;
  readonly moveable: boolean;
  readonly skipTaskbar: boolean;
  readonly pid: number;
  readonly own: boolean;            // Plastile's own UI surfaces
}

/** Desktop/activity/output membership snapshot. */
export interface Membership {
  readonly output: OutputId | null;
  readonly desktops: readonly DesktopId[];   // empty when on all desktops
  readonly onAllDesktops: boolean;
  readonly activities: readonly ActivityId[]; // empty when on all activities
}

/** KWin-owned states that suspend ordinary placement (orthogonal, may overlap). */
export type Suspension = "minimized" | "fullscreen" | "maximized" | "interactive" | "hidden";

export interface WindowStates {
  readonly minimized: boolean;
  readonly fullscreen: boolean;
  readonly maximized: boolean;
  readonly interactive: "none" | "move" | "resize";
  readonly hidden: boolean;
}

/** Frame-space constraints. minFrame includes decoration margins (minSize is client-space). */
export interface Constraints {
  readonly minFrame: Size;
  readonly maxFrame: Size;           // Infinity when unconstrained
  readonly fixed: boolean;
}

export type PlacementMode = "pending" | "excluded" | "floating" | "tiled" | "native";

export type DecisionSource = "type" | "builtin" | "rule" | "constraint" | "user" | "membership" | "native" | "default";

export interface Decision {
  readonly mode: "excluded" | "floating" | "tiled";
  readonly source: DecisionSource;
  readonly reason: string;
  readonly ruleIds: readonly string[];
}

export type LayoutKind = "master-stack" | "bsp" | "monocle" | "floating" | "scrolling" | "zones";

export interface GapSettings {
  readonly inner: number;
  readonly outer: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };
}

export interface MasterStackSettings {
  readonly ratio: number;
  readonly masterCount: number;
  readonly insert: "after-focus" | "end" | "master";
  readonly ratioStep: number;
}

export interface BspSettings {
  readonly insert: "focused" | "last";
  readonly axis: "alternate" | "longest" | "horizontal" | "vertical";
  readonly initialRatio: number;
  readonly ratioStep: number;
}

/** Scrolling layout (experimental, ADR-014, docs/design/SCROLLING.md). */
export interface ScrollingSettings {
  /** "centered": the focused column is centred when it fits; "lazy": scroll just enough to show it. */
  readonly policy: "centered" | "lazy";
  /** Width of a new column as a fraction of the usable width, (0, 1]. */
  readonly defaultWidth: number;
  /** Fractions the width-cycle command steps through, ascending, each in (0, 1]. */
  readonly widthPresets: readonly number[];
}

/** One zone: a rectangle in fractions of the work area after outer gaps (docs/design/ZONES.md §1). */
export interface ZoneRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ZoneLayout {
  readonly id: string;
  readonly zones: readonly ZoneRect[];
}

/** Zones layout (experimental, ADR-014, docs/design/ZONES.md). */
export interface ZoneSettings {
  /** Id of the zone layout a zones context uses unless a command chose another (`zones.layout`). */
  readonly layout: string;
  /** Every zone layout: the built-ins, then the configured `zoneLayouts` (a configured id replaces a built-in). */
  readonly layouts: readonly ZoneLayout[];
}

/** Effective per-context settings after precedence resolution (M5 provides them). */
export interface ContextSettings {
  readonly enabled: boolean;
  readonly layout: LayoutKind;
  readonly gaps: GapSettings;
  readonly masterStack: MasterStackSettings;
  readonly bsp: BspSettings;
  readonly scrolling: ScrollingSettings;
  readonly zones: ZoneSettings;
  readonly overflow: "float-new";
  readonly singleWindowGaps: boolean;
  /** Send to desktop/output also shows that desktop there and activates the window (T24). */
  readonly followOnSend: boolean;
  /** Directional focus continues from the opposite end of the row/column in this context (never another output). */
  readonly focusWrap: boolean;
  /** Peers follow an interactive resize live, at most one solve per flush (BEHAVIOR §8); off: on release only. */
  readonly liveResize: boolean;
  /**
   * A window that arrives maximized (the application or KWin chose it, not the user): "tile"
   * un-maximizes it once, before it joins the layout; "keep" honours the maximize (ADR-021).
   */
  readonly maximizedOnOpen: MaximizedOnOpen;
}

export type MaximizedOnOpen = "tile" | "keep";

export interface Result<T = undefined> {
  readonly ok: boolean;
  readonly value?: T;
  readonly reason?: string;
}

export type Area = Rect;
