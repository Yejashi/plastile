// Pure layout contract. Layouts never touch KWin; they map value inputs to slots.

import type { Rect } from "../geometry.ts";
import type { Constraints, ContextSettings, WindowId } from "../types.ts";

export interface SolveInput {
  /** Usable area (work area) before outer gaps. */
  readonly area: Rect;
  /** Participating tiled windows in context order (suspended windows excluded). */
  readonly ids: readonly WindowId[];
  /** Every member of the context in order, including suspended ones (for structural layouts). */
  readonly members: readonly WindowId[];
  readonly constraints: ReadonlyMap<WindowId, Constraints>;
  readonly settings: ContextSettings;
  readonly focused: WindowId | null;
  /** Insertion sequence per id: larger is newer (overflow picks the newest). */
  readonly insertedAt: ReadonlyMap<WindowId, number>;
  /** Every output's geometry (scrolling: parking places must intersect none of them). */
  readonly outputs?: readonly Rect[];
  /** Geometry of the context's own output (scrolling: parking stays nearest to it). */
  readonly output?: Rect | null;
}

export interface SolveResult {
  /** Frame targets for windows that receive a tile. */
  readonly slots: Map<WindowId, Rect>;
  /** Windows that cannot fit: the caller applies the overflow policy (float-new). */
  readonly overflow: WindowId[];
  /** Human-readable explanations: clamps, overflow reasons. */
  readonly notes: string[];
  /** Windows that should be stacked on top (monocle selection). */
  readonly raise: WindowId[];
  /**
   * Work-area rectangles before parking (scrolling only): where each window would be if the
   * area were unbounded. Directional focus and swap use them; ordinary layouts leave it unset.
   */
  readonly virtual?: Map<WindowId, Rect>;
  /** Windows placed outside every output (scrolling only). */
  readonly parked?: readonly WindowId[];
}

export type LayoutCommand =
  | { readonly kind: "ratio"; readonly delta: number }
  | { readonly kind: "master-count"; readonly delta: number }
  | { readonly kind: "equalize" }
  | { readonly kind: "rotate"; readonly clockwise: boolean }
  | { readonly kind: "mirror"; readonly axis: "horizontal" | "vertical" }
  | { readonly kind: "resize-boundary"; readonly id: WindowId; readonly edge: "left" | "right" | "top" | "bottom"; readonly delta: number };

export interface CommandOutcome<S> {
  readonly state: S;
  readonly changed: boolean;
  readonly reason?: string;
}

export interface Layout<S> {
  readonly kind: string;
  initial(settings: ContextSettings): S;
  /** Called when a member joins; `after` is the insertion anchor (focused member) or null. */
  insert(state: S, id: WindowId, after: WindowId | null, input: SolveInput): S;
  remove(state: S, id: WindowId): S;
  /** Rebuild structural state from an order (layout switch, recovery). */
  rebuild(state: S, members: readonly WindowId[], input: SolveInput): S;
  solve(state: S, input: SolveInput): SolveResult;
  command(state: S, cmd: LayoutCommand, input: SolveInput): CommandOutcome<S>;
  /**
   * Adjust view state so `focus` is shown before solving (scrolling viewport). Returns the
   * same object when nothing changed. Layouts without a view leave it unset.
   */
  reveal?(state: S, focus: WindowId | null, input: SolveInput): S;
  /** Swap two members' positions (layouts with structure may override order semantics). */
  swap?(state: S, a: WindowId, b: WindowId): S;
}

export function emptyResult(): SolveResult {
  return { slots: new Map(), overflow: [], notes: [], raise: [] };
}
