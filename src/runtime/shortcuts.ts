// Shortcut conflict report (T26, CONFIGURATION §6, TEST_MATRIX Q08).
//
// Read-only: Plastile never assigns, removes or "steals" a binding. KWin's ShortcutHandler
// registers each command with KGlobalAccel's default autoloading, which keeps a binding the
// user already stored; KGlobalAccel also accepts a key that another action already holds
// (measured in nested KWin 6.7.5), so a default can silently collide. This module asks
// kglobalaccel for every component's shortcuts over D-Bus, once, off the command path, and
// reports keys that a Plastile command shares with another action.
//
// Script-visible surface: KWin's DBusCall (org.kde.kwin 3.0) passes arguments as QVariants,
// so methods that take a QKeySequence struct ((ai)) or a string list cannot be called from a
// script. Only argument-free methods are used: org.kde.KGlobalAccel.allComponents() and
// org.kde.kglobalaccel.Component.allShortcutInfos(). Their replies arrive through
// dbusToVariant as nested lists (measured, KWin 6.7.5): an info is
// [uniqueName, friendlyName, componentUnique, componentFriendly, contextUnique,
//  contextFriendly, keys, defaultKeys], each key one Qt key combination (modifiers | key).

import type { CommandSpec } from "../core/commands.ts";

export const KGLOBALACCEL = "org.kde.kglobalaccel";
/** Bounds: components queried and shortcut entries read per component. */
export const MAX_COMPONENTS = 64;
export const MAX_INFOS = 2048;

export interface BusCall {
  readonly service: string;
  readonly path: string;
  readonly iface: string;
  readonly method: string;
}

export type Bus = (call: BusCall, done: (reply: unknown[]) => void, fail: () => void) => void;

export interface ShortcutInfo {
  readonly action: string;
  readonly text: string;
  readonly component: string;
  readonly componentText: string;
  readonly keys: readonly number[];
}

export interface Conflict {
  /** e.g. "Meta+Shift+H" */
  readonly key: string;
  readonly command: string;
  readonly commandText: string;
  /** Other actions holding the same key. */
  readonly others: ReadonlyArray<{ readonly component: string; readonly action: string; readonly text: string }>;
}

export interface ShortcutReport {
  readonly state: "pending" | "done" | "unavailable";
  /** Why the check could not run (state "unavailable"). */
  readonly reason?: string;
  readonly components: number;
  readonly actions: number;
  readonly conflicts: readonly Conflict[];
}

// Qt::KeyboardModifier and Qt::Key values (qnamespace.h): stable since Qt 4.
const MODS: ReadonlyArray<[string, number]> = [["Meta", 0x10000000], ["Ctrl", 0x04000000], ["Alt", 0x08000000],
                                               ["Shift", 0x02000000]];
const MOD_MASK = 0x1e000000 | 0x20000000; // + Keypad
const NAMED: ReadonlyArray<[string, number]> = [
  ["Space", 0x20], ["Escape", 0x01000000], ["Tab", 0x01000001], ["Backspace", 0x01000003], ["Return", 0x01000004],
  ["Enter", 0x01000005], ["Ins", 0x01000006], ["Del", 0x01000007], ["Print", 0x01000009], ["Home", 0x01000010],
  ["End", 0x01000011], ["Left", 0x01000012], ["Up", 0x01000013], ["Right", 0x01000014], ["Down", 0x01000015],
  ["PgUp", 0x01000016], ["PgDown", 0x01000017],
];

/** Qt key combination for a single-chord sequence like "Meta+Shift+H"; null when not representable. */
export function keyCode(seq: string): number | null {
  if (seq === "") return null;
  const parts = seq.split("+");
  // "Meta++" (the plus key) splits into a trailing empty pair.
  if (parts.length >= 2 && parts[parts.length - 1] === "" && parts[parts.length - 2] === "") parts.splice(-2, 2, "+");
  let code = 0;
  for (let i = 0; i < parts.length - 1; ++i) {
    const m = MODS.find((x) => x[0] === parts[i]);
    if (!m) return null;
    code |= m[1];
  }
  const key = parts[parts.length - 1];
  if (key.length === 1) {
    const c = key.toUpperCase().charCodeAt(0);
    if (c < 0x20 || c > 0x7e) return null;
    return code | c;
  }
  const named = NAMED.find((x) => x[0] === key);
  if (named) return code | named[1];
  const f = /^F([1-9]|1[0-9]|2[0-4])$/.exec(key);
  return f ? code | (0x0100002f + Number(f[1])) : null;
}

/** Display text for a Qt key combination ("Meta+Shift+H"); unknown keys as hex. */
export function keyText(code: number): string {
  let out = "";
  for (const [name, bit] of MODS) if (code & bit) out += name + "+";
  const key = code & ~MOD_MASK;
  const named = NAMED.find((x) => x[1] === key);
  if (named) return out + named[0];
  if (key >= 0x01000030 && key <= 0x01000047) return out + "F" + (key - 0x0100002f);
  if (key >= 0x21 && key <= 0x7e) return out + String.fromCharCode(key);
  return out + "0x" + key.toString(16);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * A list from a D-Bus reply. QV4 hands a QVariantList to script code as an array-like
 * sequence object, not an Array (measured: Array.isArray is false, JSON.stringify prints
 * an array), so array-likes are accepted.
 */
function items(v: unknown): readonly unknown[] | null {
  if (Array.isArray(v)) return v;
  if (typeof v !== "object" || v === null) return null;
  const n = (v as { length?: unknown }).length;
  return typeof n === "number" && n >= 0 ? Array.prototype.slice.call(v, 0, Math.min(n, MAX_INFOS)) as unknown[] : null;
}

/** Defensive reading of an allShortcutInfos reply (reply[0] is the list); malformed entries are skipped. */
export function parseInfos(reply: unknown): ShortcutInfo[] {
  const outer = items(reply);
  const list = (outer && items(outer[0])) ?? [];
  const out: ShortcutInfo[] = [];
  const n = Math.min(list.length, MAX_INFOS);
  for (let i = 0; i < n; ++i) {
    const e = items(list[i]);
    const ks = e && e.length >= 7 ? items(e[6]) : null;
    if (!e || !ks) continue;
    const keys: number[] = [];
    for (const k of ks) {
      const inner = typeof k === "number" ? null : items(k);
      const code = typeof k === "number" ? k : inner && typeof inner[0] === "number" ? inner[0] : 0;
      if (code) keys.push(code);
    }
    out.push({ action: str(e[0]), text: str(e[1]), component: str(e[2]), componentText: str(e[3]), keys });
  }
  return out;
}

/** Object paths from an allComponents reply, bounded. */
export function parseComponents(reply: unknown): string[] {
  const outer = items(reply);
  const list = (outer && items(outer[0])) ?? [];
  const out: string[] = [];
  for (const p of list) if (typeof p === "string" && p.indexOf("/component/") === 0 && out.length < MAX_COMPONENTS) out.push(p);
  return out;
}

/**
 * Keys a Plastile command shares with any other action. A command's keys are its current
 * binding in kglobalaccel (a user rebinding counts, a removed binding is not a conflict);
 * a command kglobalaccel does not list is checked with its default sequence.
 */
export function findConflicts(commands: readonly CommandSpec[], infos: readonly ShortcutInfo[]): Conflict[] {
  const mine = new Map<string, readonly number[]>();
  const holders = new Map<number, ShortcutInfo[]>();
  for (const s of infos) {
    if (s.component === "kwin" && s.action.indexOf("plastile.") === 0) { mine.set(s.action, s.keys); continue; }
    for (const k of s.keys) {
      const list = holders.get(k);
      if (list) list.push(s);
      else holders.set(k, [s]);
    }
  }
  const out: Conflict[] = [];
  for (const c of commands) {
    let keys = mine.get(c.id);
    if (keys === undefined) { const d = keyCode(c.sequence); keys = d === null ? [] : [d]; }
    for (const k of keys) {
      const others = holders.get(k);
      if (!others) continue;
      out.push({ key: keyText(k), command: c.id, commandText: c.text,
                 others: others.map((o) => ({ component: o.componentText || o.component, action: o.action, text: o.text || o.action })) });
    }
  }
  return out;
}

/** One concise line per conflict set, for the log. */
export function describeConflicts(cs: readonly Conflict[]): string {
  return cs.map((c) => `${c.key}: "${c.commandText}" and ${c.others.map((o) => `"${o.text}" (${o.component})`).join(", ")}`)
    .join("; ");
}

/**
 * Collects every component's shortcuts with one D-Bus request in flight at a time, then
 * reports once. A newer run, or cancel(), makes replies of an older run inert.
 */
export class ShortcutAudit {
  report: ShortcutReport = { state: "pending", components: 0, actions: 0, conflicts: [] };
  private run = 0;
  private readonly bus: Bus;
  private readonly commands: readonly CommandSpec[];
  private readonly done: (r: ShortcutReport) => void;

  constructor(bus: Bus, commands: readonly CommandSpec[], done: (r: ShortcutReport) => void) {
    this.bus = bus;
    this.commands = commands;
    this.done = done;
  }

  start(): void {
    const run = ++this.run;
    const unavailable = (reason: string): void => {
      if (run !== this.run) return;
      this.report = { state: "unavailable", reason, components: 0, actions: 0, conflicts: [] };
      this.done(this.report);
    };
    this.bus({ service: KGLOBALACCEL, path: "/kglobalaccel", iface: "org.kde.KGlobalAccel", method: "allComponents" },
      (reply) => {
        if (run !== this.run) return;
        const paths = parseComponents(reply);
        if (paths.length === 0) { unavailable("kglobalaccel listed no components"); return; }
        const infos: ShortcutInfo[] = [];
        let i = 0, failed = 0;
        const next = (): void => {
          if (run !== this.run) return;
          if (i >= paths.length) {
            const conflicts = findConflicts(this.commands, infos);
            this.report = { state: "done", components: paths.length - failed, actions: infos.length, conflicts };
            this.done(this.report);
            return;
          }
          const path = paths[i++];
          this.bus({ service: KGLOBALACCEL, path, iface: "org.kde.kglobalaccel.Component", method: "allShortcutInfos" },
            (r) => { for (const s of parseInfos(r)) infos.push(s); next(); },
            () => { failed++; next(); });
        };
        next();
      },
      () => unavailable("kglobalaccel is not reachable on the session bus"));
  }

  cancel(): void { this.run++; }
}
