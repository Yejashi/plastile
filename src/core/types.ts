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

export type LayoutKind = "master-stack" | "bsp" | "monocle" | "floating";

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

/** Effective per-context settings after precedence resolution (M5 provides them). */
export interface ContextSettings {
  readonly enabled: boolean;
  readonly layout: LayoutKind;
  readonly gaps: GapSettings;
  readonly masterStack: MasterStackSettings;
  readonly bsp: BspSettings;
  readonly overflow: "float-new";
  readonly singleWindowGaps: boolean;
  /** Send to desktop/output also shows that desktop there and activates the window (T24). */
  readonly followOnSend: boolean;
}

export interface Result<T = undefined> {
  readonly ok: boolean;
  readonly value?: T;
  readonly reason?: string;
}

export type Area = Rect;
