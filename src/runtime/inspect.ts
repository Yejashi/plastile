// Explain view (T28, CONFIGURATION §7): turns the engine's explanation of one window into
// plain behaviour statements for the inspector window (package/contents/ui/Inspector.qml).
// Internal identifiers (window, desktop and activity ids, raw rectangles) appear only in the
// details section. Pure: no KWin objects; computed once when the inspector opens.

import type { Conflict, ShortcutReport } from "./shortcuts.ts";
import { OWN_UI_TITLE } from "../adapters/kwin/adapter.ts";

/**
 * Caption of the inspector window. With no application id and no client process (KWin's
 * internal windows report pid -1) it marks the window as Plastile's own UI, which
 * classification excludes before anything else (adapter.ts isOwnUi).
 */
export const INSPECTOR_TITLE = OWN_UI_TITLE;

export interface InspectorRow {
  readonly label: string;
  readonly text: string;
}

export interface InspectorView {
  readonly windowTitle: string;
  readonly heading: string;
  readonly rows: readonly InspectorRow[];
  readonly details: readonly InspectorRow[];
  /** Usable area of the output to centre on (logical px); null lets the window keep its default place. */
  readonly area: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
}

export interface InspectContext {
  desktopNameOf(id: string): string;
  readonly shortcuts: ShortcutReport | null;
  readonly area: InspectorView["area"];
}

type Obj = Record<string, unknown>;

const LAYOUT_NAMES: Readonly<Record<string, string>> = {
  "master-stack": "master and stack", bsp: "binary split (BSP)", monocle: "monocle (one window shown at a time)",
  floating: "floating (this desktop does not tile)", scrolling: "scrolling (experimental)",
};

const SUSPENSIONS: Readonly<Record<string, string>> = {
  minimized: "minimized", fullscreen: "full screen", maximized: "maximized", interactive: "being moved or resized by you",
  hidden: "hidden",
};

function obj(v: unknown): Obj | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null;
}

function s(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

function size(v: unknown): string {
  const o = obj(v);
  if (!o) return "";
  const w = Number(o.width), h = Number(o.height);
  const dim = (n: number): string => (isFinite(n) ? String(Math.round(n)) : "any");
  return `${dim(w)}×${dim(h)}`;
}

function rectText(v: unknown): string {
  const o = obj(v);
  return o ? `${Math.round(Number(o.width))}×${Math.round(Number(o.height))} at ${Math.round(Number(o.x))},${Math.round(Number(o.y))}` : "none";
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

function placement(mode: string, layout: string): string {
  switch (mode) {
    case "tiled": return `Tiled: Plastile places this window in the ${LAYOUT_NAMES[layout] ?? layout} layout.`;
    case "floating": return "Floating: its position and size are yours; Plastile does not move it.";
    case "excluded": return "Not managed: Plastile never moves or resizes this window.";
    case "native": return "Held by KWin's own tiling: Plastile stays out of the way until you use “Adopt natively tiled window”.";
    case "pending": return "Waiting: the application has not identified itself yet; Plastile decides when it does, or shortly after.";
    default: return mode;
  }
}

function why(d: Obj | null): string {
  if (!d) return "";
  const reason = s(d.reason), ids = Array.isArray(d.ruleIds) ? (d.ruleIds as unknown[]).map(s) : [];
  switch (s(d.source)) {
    case "builtin": return `A built-in exception: ${reason}.`;
    case "type": return `Its window type: ${reason}.`;
    case "rule": return `Your configuration: ${reason}${ids.length ? ` (rule ${list(ids)})` : ""}.`;
    case "constraint": return `Its size limits: ${reason}.`;
    case "membership": return `Where it is: ${reason}. One window cannot take a tile in two places, so it floats.`;
    case "default": return "An ordinary resizable window, which is tiled by default.";
    default: return reason;
  }
}

/** "900x0" (explain's minSize) as words. */
function minSizeText(v: string): string {
  const m = /^(\d+)x(\d+)$/.exec(v);
  if (!m) return `minimum size ${v}`;
  const w = Number(m[1]), h = Number(m[2]);
  return h === 0 ? `at least ${w} px wide` : w === 0 ? `at least ${h} px tall` : `at least ${w}×${h}`;
}

function ruleText(r: Obj | null): string {
  if (!r) return "No rule matches this window.";
  const ids = Array.isArray(r.ids) ? (r.ids as unknown[]).map(s) : [];
  const actions = obj(r.actions) ?? {}, reasons = obj(r.reasons) ?? {};
  const applied: string[] = [];
  for (const k of Object.keys(actions)) {
    const what = k === "minSize" ? `tile ${minSizeText(s(actions[k]))}` : `${k} ${s(actions[k])}`;
    const from = s(reasons[k]);
    applied.push(`${what}${from.indexOf("rule ") === 0 ? ` (from ${from.slice(5)})` : ""}`);
  }
  const blocked = Object.keys(reasons).filter((k) => s(reasons[k]).indexOf("ignored") >= 0);
  let text = `Matching: ${list(ids)}.`;
  if (applied.length) text += ` Applied: ${applied.join("; ")}.`;
  if (blocked.length) text += " A built-in exception overrides the matching rules for this window.";
  return text;
}

function sizeText(c: Obj | null, learnedMin: unknown): string {
  if (!c) return "";
  if (c.fixed === true) return "Fixed size: the application cannot be resized, so it never takes a tile.";
  const parts: string[] = [];
  const min = obj(c.minFrame), max = obj(c.maxFrame);
  if (min && (Number(min.width) > 0 || Number(min.height) > 0)) parts.push(`at least ${size(min)}`);
  if (max && (isFinite(Number(max.width)) || isFinite(Number(max.height)))) parts.push(`at most ${size(max)}`);
  let text = parts.length ? `Needs ${parts.join(", ")} (including its title bar).` : "No size limits reported by the application.";
  if (obj(learnedMin)) text += ` Learned from the application: it accepted no less than ${size(learnedMin)}.`;
  return text;
}

function statusText(mode: string, ledger: Obj | null): string {
  if (mode !== "tiled" || !ledger) return "";
  switch (s(ledger.status)) {
    case "settled": return "At its tile.";
    case "pending": return "Waiting for the application to take its new size.";
    case "diverged": return "The application did not take the requested size after a bounded number of corrections; Plastile stopped insisting.";
    default: return ledger.outstanding ? "Waiting for the application to take its new size." : "No placement request outstanding.";
  }
}

function problemText(exception: string): string {
  if (exception.indexOf("overflow") === 0) {
    return "Not enough room for it in this layout, so it floats; it gets another try when room appears " +
      "(a window closes, the screen or the configuration changes).";
  }
  return exception;
}

export function shortcutText(r: ShortcutReport | null): string {
  if (!r || r.state === "pending") return "";
  if (r.state === "unavailable") return `Not checked: ${r.reason ?? "kglobalaccel unavailable"}.`;
  if (r.conflicts.length === 0) return "";
  return r.conflicts.map((c: Conflict) =>
    `${c.key} runs “${c.commandText.replace(/^Plastile: /, "")}” and also ${list(c.others.map((o) => `“${o.text}” (${o.component})`))}`)
    .join(". ") + ". Change one of them in System Settings, Keyboard, Shortcuts.";
}

/** The inspector's content for an engine explanation (null: no active window). */
export function describeWindow(x: Obj | null, ctx: InspectContext): InspectorView {
  const conflicts = shortcutText(ctx.shortcuts);
  if (!x) {
    const rows: InspectorRow[] = [{ label: "", text: "No active window. Activate a window, then run “Explain active window” again." }];
    if (conflicts) rows.push({ label: "Shortcut conflicts", text: conflicts });
    return { windowTitle: INSPECTOR_TITLE, heading: "Plastile", rows, details: [], area: ctx.area };
  }
  const mode = s(x.mode), layout = s(x.layout);
  const decision = obj(x.decision), context = obj(x.context);
  const rows: InspectorRow[] = [{ label: "Placement", text: placement(mode, layout) }];
  let reason = why(decision);
  if (decision && s(decision.mode) === "tiled" && mode !== "tiled" && mode !== "pending") {
    // Classified for tiling, but something after the classification keeps it out of the layout.
    const because = x.userMode === "floating" ? "you floated it"
      : mode === "native" ? "KWin's own tiling holds it"
      : s(x.exception).indexOf("overflow") === 0 ? "there is not enough room (see Problem)"
      : x.exception ? "Plastile gave up on it (see Problem)"
      : "tiling is turned off where it is (enabled: false)";
    reason = `It would be tiled (${s(decision.reason)}), but ${because}.`;
  }
  rows.push({ label: "Why", text: reason });
  if (x.userMode) rows.push({ label: "Your choice", text: `You chose ${s(x.userMode)} with “Toggle floating”; that lasts until the window closes.` });
  rows.push({ label: "Rules", text: ruleText(obj(x.rules)) });
  if (context) {
    const name = ctx.desktopNameOf(s(context.desktop));
    rows.push({ label: "Where", text: `Output ${s(context.output)}, desktop “${name || "unnamed"}”.` });
  }
  const sus = Array.isArray(x.suspensions) ? (x.suspensions as unknown[]).map((v) => SUSPENSIONS[s(v)] ?? s(v)) : [];
  if (sus.length) rows.push({ label: "Paused", text: `KWin owns the window while it is ${list(sus)}; Plastile resumes afterwards.` });
  const sz = sizeText(obj(x.constraints), x.learnedMin);
  if (sz) rows.push({ label: "Size", text: sz });
  const st = statusText(mode, obj(x.ledger));
  if (st) rows.push({ label: "Status", text: st });
  if (x.exception) rows.push({ label: "Problem", text: problemText(s(x.exception)) });
  if (x.nativeYield && mode !== "native") rows.push({ label: "KWin tiling", text: "A native KWin tile action made Plastile yield this window." });
  if (conflicts) rows.push({ label: "Shortcut conflicts", text: conflicts });

  const ledger = obj(x.ledger);
  const details: InspectorRow[] = [
    { label: "Window id", text: s(x.id) },
    { label: "Application id, type", text: `${s(x.appId) || "(none)"}, ${s(x.kind)}` },
    { label: "Decision", text: decision ? `${s(decision.mode)} · source ${s(decision.source)} · ${s(decision.reason)}` : "" },
    { label: "Context", text: context ? `${s(context.output)} / ${s(context.desktop)} / ${s(context.activity)}` : "none" },
    { label: "Planned tile", text: rectText(x.slot) },
    { label: "Requested", text: ledger ? `${rectText(ledger.desired)}; outstanding ${ledger.outstanding ? "yes" : "no"}; corrections ${s(ledger.corrections)}` : "" },
  ];
  if (x.exception) details.push({ label: "Exception", text: s(x.exception) });
  if (obj(x.learnedMax)) details.push({ label: "Learned maximum", text: size(x.learnedMax) });
  const heading = `${s(x.appId) || "Unnamed application"}${x.kind && x.kind !== "normal" ? ` (${s(x.kind)})` : ""}`;
  return { windowTitle: INSPECTOR_TITLE, heading, rows, details, area: ctx.area };
}
