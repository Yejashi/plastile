// Monocle: every participant gets the full area; one selected member is raised.
// Peers are stacked, never minimized (BEHAVIOR §6), so taskbar and restore
// behaviour stay ordinary and dialogs keep KWin's own stacking above parents.

import { inset } from "../geometry.ts";
import type { ContextSettings, WindowId } from "../types.ts";
import type { CommandOutcome, Layout, LayoutCommand, SolveInput } from "./layout.ts";
import { solveWithOverflow, type Attempt } from "./masterStack.ts";

export interface MonocleState {
  /** Most recently selected member; the engine updates it from focus. */
  readonly selected: WindowId | null;
}

function attempt(ids: readonly WindowId[], input: SolveInput): Attempt {
  const slots = new Map();
  const notes: string[] = [];
  const a = ids.length === 1 && !input.settings.singleWindowGaps ? input.area : inset(input.area, input.settings.gaps.outer);
  for (const id of ids) {
    const min = input.constraints.get(id)?.minFrame;
    if (min && (min.width > a.width || min.height > a.height)) {
      return { slots, failure: `${id} needs ${min.width}x${min.height}, area is ${a.width}x${a.height}`, notes };
    }
    slots.set(id, a);
  }
  return { slots, failure: null, notes };
}

export const monocle: Layout<MonocleState> = {
  kind: "monocle",
  initial(_settings: ContextSettings): MonocleState { return { selected: null }; },
  insert(state) { return state; },
  remove(state, id) { return state.selected === id ? { selected: null } : state; },
  rebuild(state) { return state; },
  solve(state, input) {
    const r = solveWithOverflow(input.ids, input, (ids) => attempt(ids, input));
    const pick = input.focused !== null && r.slots.has(input.focused) ? input.focused
      : state.selected !== null && r.slots.has(state.selected) ? state.selected
      : input.ids.find((id) => r.slots.has(id)) ?? null;
    return { slots: r.slots, overflow: r.overflow, notes: r.notes, raise: pick === null ? [] : [pick] };
  },
  command(state: MonocleState, cmd: LayoutCommand): CommandOutcome<MonocleState> {
    return { state, changed: false, reason: `${cmd.kind} not supported by monocle` };
  },
};

/** Floating layout: Plastile places nothing; windows keep ordinary KDE behaviour. */
export interface FloatingState { readonly _: null }

export const floating: Layout<FloatingState> = {
  kind: "floating",
  initial() { return { _: null }; },
  insert(state) { return state; },
  remove(state) { return state; },
  rebuild(state) { return state; },
  solve() { return { slots: new Map(), overflow: [], notes: [], raise: [] }; },
  command(state, cmd) { return { state, changed: false, reason: `${cmd.kind} not supported by floating` }; },
};
