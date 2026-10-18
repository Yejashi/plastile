// Built-in safe defaults (configuration precedence level 1).

import type { ContextSettings } from "./types.ts";

export const DEFAULT_SETTINGS: ContextSettings = {
  enabled: true,
  layout: "master-stack",
  gaps: { inner: 8, outer: { top: 8, right: 8, bottom: 8, left: 8 } },
  masterStack: { ratio: 0.55, masterCount: 1, insert: "after-focus", ratioStep: 0.05 },
  bsp: { insert: "focused", axis: "alternate", initialRatio: 0.5, ratioStep: 0.05 },
  overflow: "float-new",
  singleWindowGaps: true,
  followOnSend: false,
};
