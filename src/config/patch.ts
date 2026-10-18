// Field-level settings patches: deep merge for the recognized objects only (CONFIGURATION §3).

import type { ContextSettings } from "../core/types.ts";
import type { SettingsPatch } from "./types.ts";

export function isEmptyPatch(p: SettingsPatch): boolean {
  return Object.keys(p).length === 0;
}

/** Returns `base` itself when the patch changes nothing structural. */
export function applyPatch(base: ContextSettings, p: SettingsPatch): ContextSettings {
  if (isEmptyPatch(p)) return base;
  const g = p.gaps;
  return {
    enabled: p.enabled !== undefined ? p.enabled : base.enabled,
    layout: p.layout !== undefined ? p.layout : base.layout,
    gaps: g ? {
      inner: g.inner !== undefined ? g.inner : base.gaps.inner,
      outer: g.outer ? { ...base.gaps.outer, ...g.outer } : base.gaps.outer,
    } : base.gaps,
    masterStack: p.masterStack ? { ...base.masterStack, ...p.masterStack } : base.masterStack,
    bsp: p.bsp ? { ...base.bsp, ...p.bsp } : base.bsp,
    // Arrays (widthPresets) replace rather than concatenate (CONFIGURATION §3).
    scrolling: p.scrolling ? { ...base.scrolling, ...p.scrolling } : base.scrolling,
    overflow: p.overflow !== undefined ? p.overflow : base.overflow,
    singleWindowGaps: p.singleWindowGaps !== undefined ? p.singleWindowGaps : base.singleWindowGaps,
    followOnSend: p.followOnSend !== undefined ? p.followOnSend : base.followOnSend,
  };
}

/** Deep copy, so freezing never touches objects owned elsewhere (e.g. DEFAULT_SETTINGS). */
export function cloneSettings(s: ContextSettings): ContextSettings {
  return { ...s, gaps: { inner: s.gaps.inner, outer: { ...s.gaps.outer } }, masterStack: { ...s.masterStack }, bsp: { ...s.bsp },
           scrolling: { ...s.scrolling, widthPresets: s.scrolling.widthPresets.slice() } };
}

export function freezeSettings(s: ContextSettings): ContextSettings {
  if (Object.isFrozen(s)) return s;
  Object.freeze(s.gaps.outer);
  Object.freeze(s.gaps);
  Object.freeze(s.masterStack);
  Object.freeze(s.bsp);
  Object.freeze(s.scrolling.widthPresets);
  Object.freeze(s.scrolling);
  return Object.freeze(s);
}
