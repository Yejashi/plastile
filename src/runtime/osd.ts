// On-screen feedback through Plasma's own OSD (the overlay plasmashell shows for volume,
// brightness or a keyboard layout switch). Shown when a command changes a context's layout and
// when tiling is paused or resumed; never on window events.
//
// Interface: org.kde.plasmashell /org/kde/osdService, org.kde.osdService.showText(s icon, s text)
// (plasma-workspace shell/osd.h; introspected read-only on the reference machine, plasmashell
// 6.7.5). One asynchronous DBusCall (org.kde.kwin 3.0) per message, sent on a later event-loop
// turn than the command, at most one in flight: a message produced meanwhile replaces the
// waiting one and goes when the reply arrives.
//
// A failed call (no plasmashell yet: KWin starts before it at login; plasmashell restarting; an
// error reply or a timeout: DBusCall's failed() cannot tell them apart) drops that message, with
// one debug line per streak of failures. Messages are then dropped for OSD_RETRY_AFTER_MS; the
// first one after that tries again. Every message comes from a user command, so nothing retries
// by itself: there is no timer and no loop.

import type { LayoutKind } from "../core/types.ts";
import type { Bus } from "./shortcuts.ts";

export const OSD_SERVICE = "org.kde.plasmashell";
export const OSD_PATH = "/org/kde/osdService";
export const OSD_IFACE = "org.kde.osdService";
/** After a failed call, messages are dropped until this long has passed; the next one then tries again. */
export const OSD_RETRY_AFTER_MS = 30000;

/** Breeze icon names (present in breeze 6.7 actions/22). */
const ICONS: Readonly<Record<LayoutKind, string>> = {
  "master-stack": "view-split-left-right", bsp: "view-grid", monocle: "window-maximize", floating: "window-duplicate",
  scrolling: "object-columns", zones: "view-grid",
};

const NAMES: Readonly<Record<LayoutKind, string>> = {
  "master-stack": "Master/stack layout", bsp: "BSP layout", monocle: "Monocle layout", floating: "Floating layout (tiling off)",
  scrolling: "Scrolling layout", zones: "Zones layout",
};

export interface OsdMessage {
  readonly icon: string;
  readonly text: string;
}

/**
 * The message for a layout a command chose. `desktop` is named when there is more than one
 * desktop and `output` when there is more than one output (null: not worth naming).
 */
export function layoutMessage(layout: LayoutKind, desktop: string | null, output: string | null): OsdMessage {
  const where = desktop && output ? `${desktop} on ${output}` : desktop || output || "";
  return { icon: ICONS[layout] ?? "view-grid", text: NAMES[layout] + (where ? ` — ${where}` : "") };
}

export function pauseMessage(paused: boolean): OsdMessage {
  return paused ? { icon: "media-playback-pause", text: "Tiling paused" } : { icon: "media-playback-start", text: "Tiling resumed" };
}

/** "failed": the last call failed; a message at least OSD_RETRY_AFTER_MS later tries again. */
export type OsdState = "idle" | "off" | "failed" | "stopped";

export class Osd {
  /** Requests sent, and how many of them failed (diagnostics). */
  sent = 0;
  failures = 0;
  private enabled = true;
  /** When the last call failed; null once a call succeeded (or before any failed). */
  private failedAt: number | null = null;
  private alive = true;
  private inflight = false;
  private waiting: OsdMessage | null = null;
  private scheduled = false;
  private readonly flushFn = (): void => { this.scheduled = false; this.send(); };
  private readonly bus: Bus | undefined;
  private readonly later: (fn: () => void) => void;
  private readonly now: () => number;
  private readonly debug: (message: string) => void;

  constructor(bus: Bus | undefined, later: (fn: () => void) => void, now: () => number, debug: (message: string) => void) {
    this.bus = bus;
    this.later = later;
    this.now = now;
    this.debug = debug;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.waiting = null;
  }

  /** Queue a message for a later turn; nothing without a bus, when off, or within OSD_RETRY_AFTER_MS of a failure. */
  show(m: OsdMessage): void {
    if (!this.bus || !this.enabled || !this.alive) return;
    if (this.failedAt !== null && this.now() - this.failedAt < OSD_RETRY_AFTER_MS) return;
    this.waiting = m;
    if (this.inflight || this.scheduled) return;
    this.scheduled = true;
    this.later(this.flushFn);
  }

  private send(): void {
    const m = this.waiting;
    this.waiting = null;
    if (!m || !this.bus || !this.enabled || !this.alive || this.inflight) return;
    this.inflight = true;
    this.sent++;
    this.bus({ service: OSD_SERVICE, path: OSD_PATH, iface: OSD_IFACE, method: "showText", args: [m.icon, m.text] },
      () => {
        if (!this.alive) return;
        this.inflight = false;
        this.failedAt = null; // a streak of failures, if any, is over
        if (this.waiting) this.send();
      },
      () => {
        if (!this.alive) return;
        this.inflight = false;
        this.failures++;
        if (this.failedAt === null) {
          this.debug(`on-screen display unavailable (${OSD_SERVICE} ${OSD_PATH} showText failed); messages are dropped, `
            + `and a command at least ${OSD_RETRY_AFTER_MS / 1000} s later tries again`);
        }
        this.failedAt = this.now();
        this.waiting = null; // dropped with the failed one, never resent
      });
  }

  state(): OsdState {
    return !this.alive ? "stopped" : !this.enabled || !this.bus ? "off" : this.failedAt !== null ? "failed" : "idle";
  }

  /** Unload: nothing more is sent and late replies are ignored. */
  stop(): void {
    this.alive = false;
    this.waiting = null;
  }
}
