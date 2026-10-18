// Window eligibility: built-in exclusions > type/constraint defaults > rules,
// with the decision source recorded for explanations (BEHAVIOR §1).

import type { Constraints, Decision, Membership, WindowKind, WindowMeta } from "./types.ts";

/** Kinds that are never ordinary managed windows; rules cannot change this. */
export const EXCLUDED_KINDS: ReadonlySet<WindowKind> = new Set<WindowKind>([
  "dock", "desktop", "notification", "tooltip", "popup", "osd", "applet-popup", "dnd-icon", "menu", "splash", "toolbar",
]);

/** Shell/compositor surfaces excluded by app id (built-in exceptions, explained). */
export const EXCLUDED_APPS: ReadonlySet<string> = new Set([
  "org.kde.plasmashell", "plasmashell", "org.kde.krunner", "krunner", "ksmserver-logout-greeter",
  "org.kde.ksmserver-logout-greeter", "kwin", "org.kde.kwin", "kwin_wayland", "org.kde.kscreenlocker_greet",
  "kscreenlocker_greet", "xwaylandvideobridge", "org.kde.xwaylandvideobridge",
]);

/** Helper/dialog-like apps that float by default (built-in exceptions, explained). */
export const FLOATING_APPS: ReadonlySet<string> = new Set([
  "org.freedesktop.impl.portal.desktop.kde", "xdg-desktop-portal-kde", "org.kde.polkit-kde-authentication-agent-1",
  "polkit-kde-authentication-agent-1", "org.kde.kdeconnect.daemon", "org.kde.plasma.emojier",
]);

export interface RuleView {
  readonly mode?: "tiled" | "floating" | "excluded";
  readonly ruleIds: readonly string[];
}

export interface ClassifyInput {
  readonly meta: WindowMeta;
  readonly membership: Membership;
  readonly constraints: Constraints;
  readonly frameSize: { readonly width: number; readonly height: number } | null;
  /** True when the window maps to exactly one layout context (ADR-009). */
  readonly singleContext: boolean;
  readonly rule: RuleView | null;
}

function d(mode: Decision["mode"], source: Decision["source"], reason: string, ruleIds: readonly string[] = []): Decision {
  return { mode, source, reason, ruleIds };
}

export function classify(x: ClassifyInput): Decision {
  const m = x.meta;
  // Level 0: built-in exclusions (cannot be overridden by user rules).
  if (m.own) return d("excluded", "builtin", "Plastile's own UI");
  if (EXCLUDED_KINDS.has(m.kind)) return d("excluded", "type", `window type ${m.kind}`);
  if (m.special) return d("excluded", "type", "special window");
  if (!m.managed) return d("excluded", "type", "not managed by KWin");
  if (EXCLUDED_APPS.has(m.appId)) return d("excluded", "builtin", `shell/compositor surface ${m.appId}`);
  if (x.frameSize && (x.frameSize.width <= 2 || x.frameSize.height <= 2)) return d("excluded", "builtin", "tiny helper surface");

  const rule = x.rule;
  if (rule && rule.mode === "excluded") return d("excluded", "rule", "excluded by rule", rule.ruleIds);

  // Multi-context windows float regardless of rules: one frame cannot take conflicting targets.
  if (!x.singleContext) {
    return d("floating", "membership", x.membership.onAllDesktops ? "on all desktops"
      : x.membership.desktops.length > 1 ? "on several desktops" : x.membership.output === null ? "no output"
      : "on several activities");
  }
  if (rule && rule.mode === "tiled") {
    if (x.constraints.fixed || !m.resizeable) return d("floating", "constraint", "fixed size (rule asked to tile)", rule.ruleIds);
    return d("tiled", "rule", "tiled by rule", rule.ruleIds);
  }
  if (rule && rule.mode === "floating") return d("floating", "rule", "floating by rule", rule.ruleIds);

  if (FLOATING_APPS.has(m.appId)) return d("floating", "builtin", `helper application ${m.appId}`);
  if (m.kind === "dialog") return d("floating", "type", "dialog");
  if (m.kind === "utility") return d("floating", "type", "utility window");
  if (m.transient || m.modal) return d("floating", "type", m.modal ? "modal transient" : "transient window");
  if (m.kind !== "normal") return d("floating", "type", `window type ${m.kind}`);
  if (x.constraints.fixed || !m.resizeable) return d("floating", "constraint", "fixed size");
  return d("tiled", "default", "normal resizable window");
}
