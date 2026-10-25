// Border rule ownership (Q10, ARCHITECTURE section 5) with the mock compositor.
// Oracle: the mock windows' noBorder property.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MockHost } from "./mockHost.ts";

const NONE = { border: "none" as const, ruleIds: ["nb"] };

test("Q10: a later re-classification does not re-apply a border the user changed back", () => {
  const h = new MockHost();
  h.start({ rulesFor: () => NONE });
  for (const id of ["a", "b"]) h.open(id);
  h.drain();
  assert.equal(h.windows.get("b")!.noBorder, true, "the rule applied");
  h.windows.get("b")!.noBorder = false; // the user restores the border
  // Any later re-classification (here: a desktop round trip) must yield to that choice.
  const w = h.windows.get("b")!;
  w.membership = { ...w.membership, desktops: ["D2"] };
  h.engine.membershipChanged("b", w.gen, w.membership);
  w.membership = { ...w.membership, desktops: ["D1"] };
  h.engine.membershipChanged("b", w.gen, w.membership);
  h.drain();
  assert.equal(h.windows.get("b")!.noBorder, false);
  assert.equal(h.windows.get("a")!.noBorder, true);
});

test("Q10: a configuration change of the border rule still updates a border Plastile owns", () => {
  const h = new MockHost();
  let border: "none" | "normal" = "none";
  h.start({ rulesFor: () => ({ border, ruleIds: ["nb"] }) });
  h.open("a");
  h.drain();
  assert.equal(h.windows.get("a")!.noBorder, true);
  border = "normal";
  h.engine.configure({ rulesFor: () => ({ border, ruleIds: ["nb"] }) });
  h.drain();
  assert.equal(h.windows.get("a")!.noBorder, false);
});

test("Q10: a border:none window that floats as an overflow gets its decoration back", () => {
  const h = new MockHost();
  h.start({ rulesFor: () => ({ ...NONE, minSize: { width: 900, height: 0 } }) });
  h.open("a");
  h.drain();
  assert.equal(h.windows.get("a")!.noBorder, true, "the rule applied while tiled");
  h.open("b");
  h.drain();
  assert.equal(h.engine.modeOf("b"), "floating");
  assert.match(String(h.engine.explain("b")!.exception), /^overflow/);
  assert.equal(h.windows.get("b")!.noBorder, false, "restored when it left the layout");
  assert.equal(h.windows.get("a")!.noBorder, true);
  h.close("a");
  h.drain();
  assert.equal(h.engine.modeOf("b"), "tiled", "rejoined once there is room");
  assert.equal(h.windows.get("b")!.noBorder, true, "removed again while tiled");
});
