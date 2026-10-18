// Stable command vocabulary (CONFIGURATION §6). One shortcut per command id.
//
// Default bindings avoid the Plasma 6 defaults found on the reference machine
// (Meta+arrows quick tile, Meta+PgUp/PgDn, Meta+T tile editor, Meta+W overview,
// Meta+L lock, Meta+Ctrl+arrows desktop switching, Meta+Alt+arrows window focus,
// Meta+1..9 task manager), Spectacle's Meta+Shift+S and KWin Zoom's Meta+=/Meta+-.
// They are Meta+Shift+<letter>, Meta+Shift+Space/Return and Meta+Ctrl+<letter or
// = or ->; never Shift with punctuation, which changes the key symbol (Shift+= is
// "+" on a US layout). Every default was measured to reach Plastile with real key
// events in nested KWin 6.7.5 (tests/integration/scenarios_shortcuts.py, US keymap);
// other layouts and installed software can still claim a sequence. Users rebind in
// System Settings; existing user bindings are preserved by KGlobalAccel.

export interface CommandSpec {
  readonly id: string;
  readonly text: string;
  readonly sequence: string; // default key sequence ("" = unbound)
}

export const COMMANDS: readonly CommandSpec[] = [
  { id: "plastile.focus.left", text: "Plastile: Focus left", sequence: "Meta+Shift+H" },
  { id: "plastile.focus.down", text: "Plastile: Focus down", sequence: "Meta+Shift+J" },
  { id: "plastile.focus.up", text: "Plastile: Focus up", sequence: "Meta+Shift+K" },
  { id: "plastile.focus.right", text: "Plastile: Focus right", sequence: "Meta+Shift+L" },
  { id: "plastile.focus.next", text: "Plastile: Focus next", sequence: "Meta+Shift+N" },
  { id: "plastile.focus.previous", text: "Plastile: Focus previous", sequence: "Meta+Shift+P" },
  { id: "plastile.focus.master", text: "Plastile: Focus master", sequence: "" },
  // Cross-output focus (BEHAVIOR §7): unbound, like every command added after the measured defaults.
  { id: "plastile.focus.output-next", text: "Plastile: Focus next output", sequence: "" },
  { id: "plastile.focus.output-previous", text: "Plastile: Focus previous output", sequence: "" },
  { id: "plastile.swap.left", text: "Plastile: Swap with window to the left", sequence: "Meta+Ctrl+H" },
  { id: "plastile.swap.down", text: "Plastile: Swap with window below", sequence: "Meta+Ctrl+J" },
  { id: "plastile.swap.up", text: "Plastile: Swap with window above", sequence: "Meta+Ctrl+K" },
  { id: "plastile.swap.right", text: "Plastile: Swap with window to the right", sequence: "Meta+Ctrl+L" },
  { id: "plastile.swap.next", text: "Plastile: Swap with next window", sequence: "" },
  { id: "plastile.swap.previous", text: "Plastile: Swap with previous window", sequence: "" },
  { id: "plastile.swap.master", text: "Plastile: Swap with master", sequence: "Meta+Shift+Return" },
  { id: "plastile.move.left", text: "Plastile: Move tile left (reinsert)", sequence: "" },
  { id: "plastile.move.down", text: "Plastile: Move tile down (reinsert)", sequence: "" },
  { id: "plastile.move.up", text: "Plastile: Move tile up (reinsert)", sequence: "" },
  { id: "plastile.move.right", text: "Plastile: Move tile right (reinsert)", sequence: "" },
  { id: "plastile.move.output-next", text: "Plastile: Send window to next output", sequence: "Meta+Shift+O" },
  { id: "plastile.move.output-previous", text: "Plastile: Send window to previous output", sequence: "" },
  { id: "plastile.move.desktop-next", text: "Plastile: Send window to next desktop", sequence: "" },
  { id: "plastile.move.desktop-previous", text: "Plastile: Send window to previous desktop", sequence: "" },
  { id: "plastile.resize.grow", text: "Plastile: Grow focused tile", sequence: "Meta+Ctrl+=" },
  { id: "plastile.resize.shrink", text: "Plastile: Shrink focused tile", sequence: "Meta+Ctrl+-" },
  { id: "plastile.resize.equalize", text: "Plastile: Equalize sizes", sequence: "" },
  { id: "plastile.master.increase", text: "Plastile: More master windows", sequence: "Meta+Shift+I" },
  { id: "plastile.master.decrease", text: "Plastile: Fewer master windows", sequence: "Meta+Shift+D" },
  { id: "plastile.layout.next", text: "Plastile: Next layout", sequence: "Meta+Shift+Space" },
  { id: "plastile.layout.previous", text: "Plastile: Previous layout", sequence: "" },
  { id: "plastile.layout.master-stack", text: "Plastile: Master/stack layout", sequence: "" },
  { id: "plastile.layout.bsp", text: "Plastile: BSP layout", sequence: "" },
  { id: "plastile.layout.monocle", text: "Plastile: Monocle layout", sequence: "Meta+Shift+M" },
  { id: "plastile.layout.floating", text: "Plastile: Floating layout (no tiling here)", sequence: "" },
  { id: "plastile.layout.scrolling", text: "Plastile: Scrolling layout (experimental)", sequence: "" },
  { id: "plastile.layout.rotate-clockwise", text: "Plastile: Rotate layout clockwise", sequence: "" },
  { id: "plastile.layout.rotate-counterclockwise", text: "Plastile: Rotate layout counterclockwise", sequence: "" },
  { id: "plastile.layout.mirror-horizontal", text: "Plastile: Mirror layout horizontally", sequence: "" },
  { id: "plastile.layout.mirror-vertical", text: "Plastile: Mirror layout vertically", sequence: "" },
  // Scrolling layout (experimental, docs/design/SCROLLING.md): unbound, so no default can
  // collide with software already installed; users bind them in System Settings.
  { id: "plastile.scroll.consume", text: "Plastile: Scrolling: move window into the column on the left", sequence: "" },
  { id: "plastile.scroll.expel", text: "Plastile: Scrolling: move window out into its own column", sequence: "" },
  { id: "plastile.scroll.width-cycle", text: "Plastile: Scrolling: cycle column width", sequence: "" },
  { id: "plastile.scroll.center", text: "Plastile: Scrolling: centre focused column", sequence: "" },
  { id: "plastile.window.toggle-float", text: "Plastile: Toggle floating", sequence: "Meta+Shift+F" },
  { id: "plastile.window.adopt-native", text: "Plastile: Adopt natively tiled window", sequence: "" },
  { id: "plastile.context.reset", text: "Plastile: Reset this layout", sequence: "" },
  { id: "plastile.runtime.toggle-suspend", text: "Plastile: Suspend/resume tiling", sequence: "Meta+Ctrl+S" },
  { id: "plastile.runtime.reconcile", text: "Plastile: Reconcile with live windows", sequence: "" },
  { id: "plastile.runtime.reload-config", text: "Plastile: Reload configuration", sequence: "" },
  { id: "plastile.inspect.explain-window", text: "Plastile: Explain active window (log)", sequence: "" },
  { id: "plastile.inspect.counters", text: "Plastile: Log counters", sequence: "" },
  { id: "plastile.inspect.dump-trace", text: "Plastile: Log trace", sequence: "" },
];

export const COMMAND_IDS: ReadonlySet<string> = new Set(COMMANDS.map((c) => c.id));

export type CommandStatus = "accepted" | "rejected" | "noop";

export interface CommandResult {
  readonly command: string;
  readonly status: CommandStatus;
  readonly reason?: string;
  readonly targets: readonly string[];
  readonly revision: number;
  /** Whether a placement request was issued. Accepted does not mean committed or presented. */
  readonly requested: boolean;
}
