// Built-in safe defaults (configuration precedence level 1).

import type { ContextSettings, ZoneLayout } from "./types.ts";

/**
 * Built-in zone layouts (docs/design/ZONES.md §1). Zones are numbered in list order: left to
 * right, then top to bottom. A configured `zoneLayouts` entry with the same id replaces one.
 */
export const BUILTIN_ZONE_LAYOUTS: readonly ZoneLayout[] = [
  { id: "halves", zones: [{ x: 0, y: 0, width: 0.5, height: 1 }, { x: 0.5, y: 0, width: 0.5, height: 1 }] },
  { id: "thirds", zones: [
    { x: 0, y: 0, width: 1 / 3, height: 1 }, { x: 1 / 3, y: 0, width: 1 / 3, height: 1 },
    { x: 2 / 3, y: 0, width: 1 / 3, height: 1 }] },
  { id: "grid-2x2", zones: [
    { x: 0, y: 0, width: 0.5, height: 0.5 }, { x: 0.5, y: 0, width: 0.5, height: 0.5 },
    { x: 0, y: 0.5, width: 0.5, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }] },
  { id: "main-side", zones: [{ x: 0, y: 0, width: 0.6, height: 1 }, { x: 0.6, y: 0, width: 0.4, height: 1 }] },
];

export const DEFAULT_SETTINGS: ContextSettings = {
  enabled: true,
  layout: "master-stack",
  gaps: { inner: 8, outer: { top: 8, right: 8, bottom: 8, left: 8 } },
  masterStack: { ratio: 0.55, masterCount: 1, insert: "after-focus", ratioStep: 0.05 },
  bsp: { insert: "focused", axis: "alternate", initialRatio: 0.5, ratioStep: 0.05 },
  scrolling: { policy: "lazy", defaultWidth: 0.5, widthPresets: [1 / 3, 1 / 2, 2 / 3, 1] },
  zones: { layout: "halves", layouts: BUILTIN_ZONE_LAYOUTS },
  overflow: "float-new",
  singleWindowGaps: true,
  followOnSend: false,
};
