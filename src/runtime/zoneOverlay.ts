// Zones overlay view (experimental, docs/design/ZONES.md §4). Turns the engine's overlay model
// (Engine.zoneOverlay: the rectangles projectZones gives, the same ones solves place windows
// in) into what package/contents/ui/ZoneOverlay.qml binds to. Every coordinate is computed
// here; QML only displays it. Pure: no KWin objects.

import type { Rect } from "../core/geometry.ts";
import type { ZoneOverlayModel } from "../core/engine.ts";
import { ZONES_UI_TITLE } from "../adapters/kwin/adapter.ts";

/** One drawn rectangle: what ZoneOverlay.qml binds to (it knows nothing about zones). */
export interface ZoneOverlayZone {
  readonly n: number;
  /** Large text in the middle (the zone number) and a smaller line under it ("" for none). */
  readonly label: string;
  readonly detail: string;
  /** Absolute logical rectangle (equal to the engine's projection). */
  readonly rect: Rect;
  /** The same rectangle relative to the overlay window's origin. */
  readonly local: Rect;
  readonly windows: number;
}

export interface ZoneOverlayView {
  /** Caption marking the windows as Plastile's own UI (adapter.ts isOwnUi). */
  readonly windowTitle: string;
  /** The overlay window covers the active output. */
  readonly output: Rect;
  /** Where the legend goes: centred near the top of the work area, in absolute coordinates. */
  readonly legend: Rect;
  readonly heading: string;
  readonly hint: string;
  readonly rects: readonly ZoneOverlayZone[];
}

export interface ZoneOverlayHost {
  /** Create the overlay on first use, or update and show the existing one. */
  show(view: ZoneOverlayView): void;
  hide(): void;
  /** Destroy it (unload). */
  destroy(): void;
  state(): "absent" | "hidden" | "shown";
}

export const LEGEND_WIDTH = 420;
export const LEGEND_HEIGHT = 56;

export function zoneOverlayView(m: ZoneOverlayModel): ZoneOverlayView {
  const o = m.geometry;
  const zones = m.zones.map((z) => ({
    n: z.n, rect: z.rect, windows: z.windows, label: String(z.n),
    detail: z.windows === 0 ? "" : z.windows === 1 ? "1 window" : `${z.windows} windows`,
    local: { x: z.rect.x - o.x, y: z.rect.y - o.y, width: z.rect.width, height: z.rect.height },
  }));
  const w = Math.min(LEGEND_WIDTH, Math.max(1, m.area.width - 32));
  const legend = { x: Math.round(m.area.x + (m.area.width - w) / 2), y: Math.round(m.area.y + 16), width: w, height: LEGEND_HEIGHT };
  const assigned = m.zones.reduce((n, z) => n + z.windows, 0);
  return {
    windowTitle: ZONES_UI_TITLE, output: o, legend, rects: zones,
    heading: `Zones: ${m.layout} (${m.zones.length} zones, ${assigned} assigned)`,
    hint: "Escape, a click or “Zones: show or hide the zone overlay” closes this.",
  };
}
