// Ports between the pure engine and its host. The KWin adapter implements them
// with live objects; tests implement them with a mock compositor.

import type { Rect } from "./geometry.ts";
import type { ActivityId, Constraints, DesktopId, Membership, OutputId, WindowId, WindowMeta, WindowStates } from "./types.ts";

/** Everything the engine learns about a window, captured at event time. */
export interface WindowSnapshot {
  readonly id: WindowId;
  readonly gen: number;
  readonly meta: WindowMeta;
  readonly membership: Membership;
  readonly states: WindowStates;
  readonly constraints: Constraints;
  readonly frame: Rect;
  /** A native KWin tile association exists (quick tile or tile editor). */
  readonly nativeTile: boolean;
}

/** How an output's id was derived: EDID triple, connector name, or EDID plus connector for identical monitors. */
export type OutputIdentity = "edid" | "connector" | "ambiguous";

export interface OutputInfo {
  /** Stable identity key (context keys use it); independent of enumeration order (E16). */
  readonly id: OutputId;
  /** Connector name, for user-facing matching (overrides' outputName) and messages. */
  readonly name: string;
  readonly geometry: Rect;
  readonly scale: number;
  readonly identity?: OutputIdentity;
}

export interface FrameWrite {
  readonly before: Rect;
  readonly after: Rect;
}

/** Operations on the host compositor. All are synchronous and non-blocking. */
export interface HostPort {
  /** Request a frame. Returns frames read before/after, or null if the window is gone. */
  applyFrame(id: WindowId, gen: number, target: Rect): FrameWrite | null;
  /** Current observed frame, or null if gone. */
  frame(id: WindowId, gen: number): Rect | null;
  activate(id: WindowId, gen: number): boolean;
  raise(id: WindowId, gen: number): boolean;
  /** Release a native tile association so the engine owns geometry. */
  releaseNativeTile(id: WindowId, gen: number): boolean;
  setNoBorder(id: WindowId, gen: number, noBorder: boolean): boolean;
  noBorder(id: WindowId, gen: number): boolean | null;
  /** Send to another output/desktop (membership change arrives later as an event). */
  sendToOutput(id: WindowId, gen: number, output: OutputId): boolean;
  sendToDesktop(id: WindowId, gen: number, desktop: DesktopId): boolean;
  activeWindow(): WindowId | null;
  activeOutput(): OutputId | null;
  outputs(): readonly OutputInfo[];
  /** Panel-aware usable area for a context; null when temporarily invalid. */
  workArea(output: OutputId, desktop: DesktopId): Rect | null;
  /** Desktop currently shown on an output. */
  visibleDesktop(output: OutputId): DesktopId | null;
  desktops(): readonly DesktopId[];
  currentActivity(): ActivityId;
  /** Number of activities known (<=1 collapses the activity dimension). */
  activityCount(): number;
}

/** Scheduling, time and logging services. */
export interface RuntimeServices {
  /** Monotonic-ish milliseconds (Date.now() in KWin: 1 ms resolution). */
  now(): number;
  /** Defer a stable zero-argument function to the next event-loop turn (coalesces by identity). */
  callLater(fn: () => void): void;
  /** One-shot deadline; returns a cancel function. Used only while work is outstanding. */
  deadline(ms: number, fn: () => void): () => void;
  log(level: "error" | "warn" | "info" | "debug", message: string, data?: unknown): void;
}
