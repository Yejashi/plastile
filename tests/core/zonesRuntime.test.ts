// Zones overlay in the runtime (experimental, docs/design/ZONES.md §4), driven through the fake
// KWin surface. Oracles: the overlay host's calls and the fake windows' frames.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../../src/runtime/main.ts";
import { zoneOverlayView, type ZoneOverlayHost, type ZoneOverlayView } from "../../src/runtime/zoneOverlay.ts";
import { isOwnUi, metaOf, ZONES_UI_TITLE } from "../../src/adapters/kwin/adapter.ts";
import { desktop, fakeEnv, FakeQt, FakeWorkspace, output } from "./fakeKwin.ts";

function setup(layout: string) {
  const ws = new FakeWorkspace([output("O1", { x: 0, y: 0, width: 1280, height: 800 })], [desktop("D1")]);
  const qt = new FakeQt();
  const wins = [1, 2].map((i) => {
    const w = ws.window({ caption: `w${i}`, resourceClass: `app${i}`, frameGeometry: { x: 20 * i, y: 20 * i, width: 400, height: 300 } });
    ws.windows.push(w);
    return w;
  });
  const f = fakeEnv(ws, qt, { layout, diagnostics: "info" });
  const calls: string[] = [];
  const shown: ZoneOverlayView[] = [];
  let state: "absent" | "hidden" | "shown" = "absent";
  const host: ZoneOverlayHost = {
    show: (v) => { calls.push("show"); shown.push(v); state = "shown"; },
    hide: () => { calls.push("hide"); state = "hidden"; },
    destroy: () => { calls.push("destroy"); state = "absent"; },
    state: () => state,
  };
  f.env.zones = host;
  const rt = createRuntime(f.env);
  qt.drain();
  return { ws, qt, wins, f, rt, calls, shown, dismiss: () => { state = "hidden"; } };
}

test("zone.show creates the overlay on first use, toggles it, and unload destroys it; keyboard placement never needs it", () => {
  const { ws, qt, wins, rt, calls, shown, f } = setup("zones");
  ws.activeWindow = wins[0];
  rt.dispatch("plastile.zone.assign-2");
  qt.drain();
  assert.deepEqual(calls, [], "assigning by keyboard creates no overlay");
  const g = wins[0].frameGeometry;
  rt.dispatch("plastile.zone.show");
  assert.deepEqual(calls, ["show"]);
  const v = shown[0];
  assert.equal(v.windowTitle, ZONES_UI_TITLE);
  assert.deepEqual(v.output, { x: 0, y: 0, width: 1280, height: 800 });
  assert.deepEqual(v.rects.map((r) => r.label), ["1", "2"]);
  assert.deepEqual(v.rects[1].rect, { x: g.x, y: g.y, width: g.width, height: g.height }, "zone 2 is where the window went");
  assert.equal(v.rects[1].detail, "1 window");
  assert.ok(f.lines.some((l) => l.startsWith("plastile info zones overlay ")), "the drawn rectangles are logged at info");
  rt.dispatch("plastile.zone.layout-next");
  assert.deepEqual(calls, ["show", "show"], "a zone command refreshes a shown overlay");
  assert.equal(shown[1].heading.indexOf("Zones: thirds"), 0);
  rt.dispatch("plastile.zone.show");
  assert.deepEqual(calls, ["show", "show", "hide"]);
  rt.dispatch("plastile.zone.next");
  assert.deepEqual(calls, ["show", "show", "hide"], "nothing happens to a hidden overlay");
  rt.dispatch("plastile.inspect.counters");
  assert.match(f.lines.find((l) => l.startsWith("plastile counters "))!, /"zoneOverlay":"hidden"/);
  rt.dispatch("plastile.zone.show");
  rt.shutdown();
  assert.deepEqual(calls.slice(-2), ["show", "destroy"]);
});

test("any accepted Plastile command refreshes a shown overlay: a reset out of zones hides it, a float updates the count", () => {
  const a = setup("master-stack");
  a.rt.dispatch("plastile.layout.zones");
  a.rt.dispatch("plastile.zone.show");
  assert.deepEqual(a.calls, ["show"]);
  assert.equal(a.rt.dispatch("plastile.context.reset")!.status, "accepted");
  assert.deepEqual(a.calls, ["show", "hide"], "no zone rectangles over a master-stack desktop");
  a.rt.shutdown();

  const { ws, qt, wins, rt, calls, shown } = setup("zones");
  ws.activeWindow = wins[0];
  rt.dispatch("plastile.zone.assign-2");
  qt.drain();
  rt.dispatch("plastile.zone.show");
  assert.match(shown[0].heading, /1 assigned/);
  assert.equal(rt.dispatch("plastile.window.toggle-float")!.status, "accepted");
  assert.deepEqual(calls, ["show", "show"]);
  assert.match(shown[1].heading, /0 assigned/, "the floated window left its zone");
  rt.shutdown();
});

test("zone.show outside a zones context shows nothing and says why", () => {
  const { rt, calls, f } = setup("master-stack");
  rt.dispatch("plastile.zone.show");
  assert.deepEqual(calls, []);
  assert.ok(f.lines.some((l) => /zones overlay not shown: the layout here is master-stack, not zones/.test(l)));
  rt.shutdown();
});

test("overlay view: local rectangles are the engine's minus the output origin; the legend sits in the work area", () => {
  const v = zoneOverlayView({ output: "O2", geometry: { x: 1280, y: -200, width: 1024, height: 768 },
    area: { x: 1280, y: -168, width: 1024, height: 736 }, layout: "halves",
    zones: [{ n: 1, rect: { x: 1288, y: -160, width: 500, height: 720 }, windows: 0 },
      { n: 2, rect: { x: 1796, y: -160, width: 500, height: 720 }, windows: 2 }] });
  assert.deepEqual(v.rects.map((r) => r.local), [{ x: 8, y: 40, width: 500, height: 720 }, { x: 516, y: 40, width: 500, height: 720 }]);
  assert.deepEqual(v.rects.map((r) => r.detail), ["", "2 windows"]);
  assert.ok(v.legend.x >= 1280 && v.legend.x + v.legend.width <= 2304 && v.legend.y >= -168);
});

test("own-UI detection covers the zones overlay caption, never a client with that caption", () => {
  const ws = new FakeWorkspace([output("O1", { x: 0, y: 0, width: 1280, height: 800 })], [desktop("D1")]);
  const internal = ws.window({ caption: ZONES_UI_TITLE, resourceClass: "", desktopFileName: "", pid: -1 });
  assert.ok(isOwnUi(internal));
  assert.equal(metaOf(internal).own, true);
  assert.equal(isOwnUi(ws.window({ caption: ZONES_UI_TITLE, resourceClass: "x", pid: 7 })), false);
});
