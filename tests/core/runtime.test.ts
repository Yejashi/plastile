// Runtime services around the engine: configuration reload (D9), the shortcut conflict
// report (T26) and the explain view (T28). Driven through the fake KWin surface
// (fakeKwin.ts) with a recorded fake D-Bus; oracles are the fake windows' frames, the
// recorded bus requests and the inspector host's calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntime, COMMANDS } from "../../src/runtime/main.ts";
import { describeWindow, INSPECTOR_TITLE, type InspectorView } from "../../src/runtime/inspect.ts";
import {
  findConflicts, keyCode, keyText, parseComponents, parseInfos, ShortcutAudit, type BusCall, type ShortcutReport,
} from "../../src/runtime/shortcuts.ts";
import { isOwnUi, metaOf } from "../../src/adapters/kwin/adapter.ts";
import { desktop, fakeEnv, FakeQt, FakeWorkspace, output, type FakeWindow } from "./fakeKwin.ts";

interface Pending { call: BusCall; done: (r: unknown[]) => void; fail: () => void }

class FakeBus {
  pending: Pending[] = [];
  log: BusCall[] = [];
  readonly fn = (call: BusCall, done: (r: unknown[]) => void, fail: () => void): void => {
    this.log.push(call);
    this.pending.push({ call, done, fail });
  };
  /** Answer the oldest request. */
  reply(r: unknown[]): void { this.pending.shift()!.done(r); }
  failNext(): void { this.pending.shift()!.fail(); }
}

/** QV4 hands QVariantLists to scripts as array-likes, not Arrays (measured); model that. */
function seq(a: unknown[]): unknown {
  const o: Record<string, unknown> = { length: a.length };
  a.forEach((v, i) => { o[i] = v; });
  return o;
}

const META = 0x10000000, SHIFT = 0x02000000, CTRL = 0x04000000;

function info(action: string, text: string, component: string, keys: number[]): unknown {
  return seq([action, text, component, component === "kwin" ? "KWin" : component, "default", "Default Context", seq(keys), seq([])]);
}

function setup(cfg: Record<string, unknown> = {}, withBus = true) {
  const ws = new FakeWorkspace([output("O1", { x: 0, y: 0, width: 1280, height: 800 })], [desktop("D1")]);
  const qt = new FakeQt();
  const wins: FakeWindow[] = [];
  for (let i = 1; i <= 2; ++i) {
    const w = ws.window({ caption: `w${i}`, resourceClass: `app${i}`, frameGeometry: { x: 20 * i, y: 20 * i, width: 400, height: 300 } });
    ws.windows.push(w);
    wins.push(w);
  }
  const f = fakeEnv(ws, qt, cfg);
  const bus = new FakeBus();
  const opened: InspectorView[] = [];
  let open = false;
  const inspector = { open: (v: InspectorView) => { opened.push(v); open = true; }, close: () => { open = false; }, isOpen: () => open };
  if (withBus) f.env.dbus = bus.fn;
  f.env.inspector = inspector;
  const rt = createRuntime(f.env);
  return { ws, qt, wins, f, bus, rt, opened, inspector };
}

// ----------------------------------------------------------------------- keys

test("every default sequence maps to a Qt key combination and back", () => {
  for (const c of COMMANDS) {
    if (!c.sequence) continue;
    const k = keyCode(c.sequence);
    assert.notEqual(k, null, c.sequence);
    assert.equal(keyText(k!), c.sequence, `${c.id}: ${c.sequence}`);
  }
  assert.equal(keyCode("Meta+Shift+H"), META | SHIFT | 0x48, "measured: kglobalaccel reports 301989960");
  assert.equal(keyCode("Meta+PgUp"), 285212694, "measured: Window Maximize default");
  assert.equal(keyCode("Meta+Ctrl+Down"), 352321557, "measured: Switch One Desktop Down");
  assert.equal(keyCode("Meta+F12"), META | 0x0100003b);
  assert.equal(keyCode("Hyper+X"), null);
  assert.equal(keyCode(""), null);
  assert.equal(keyText(META | CTRL | 0x3d), "Meta+Ctrl+=");
});

test("kglobalaccel replies are read from QV4 array-likes; malformed entries are skipped", () => {
  assert.deepEqual(parseComponents(seq([seq(["/component/kwin", "/component/org_kde_spectacle_desktop", 7, "/x"])])),
    ["/component/kwin", "/component/org_kde_spectacle_desktop"]);
  assert.deepEqual(parseComponents(null), []);
  const infos = parseInfos(seq([seq([info("Window Maximize", "Maximize Window", "kwin", [285212694]), "junk", seq([1, 2]),
    info("plastile.focus.left", "Plastile: Focus left", "kwin", [0])])]));
  assert.equal(infos.length, 2);
  assert.deepEqual(infos[0], { action: "Window Maximize", text: "Maximize Window", component: "kwin", componentText: "KWin", keys: [285212694] });
  assert.deepEqual(infos[1].keys, [], "0 means no key");
});

test("conflicts: shared keys are reported; a user rebinding counts, Plastile's own entries never clash with themselves", () => {
  const H = keyCode("Meta+Shift+H")!, J = keyCode("Meta+Shift+J")!, X = keyCode("Meta+Shift+X")!;
  const infos = parseInfos(seq([seq([
    info("plastile.focus.left", "Plastile: Focus left", "kwin", [H]),
    info("plastile.focus.down", "Plastile: Focus down", "kwin", [X]),   // user moved it to Meta+Shift+X
    info("Window Maximize", "Maximize Window", "kwin", [H]),
    info("Some Action", "Some Action", "org_example_app", [J]),          // J is no longer Plastile's
    info("Other", "Other", "org_example_app", [X]),
  ])]));
  const cs = findConflicts(COMMANDS, infos);
  assert.deepEqual(cs.map((c) => [c.key, c.command, c.others.map((o) => o.action)]), [
    ["Meta+Shift+H", "plastile.focus.left", ["Window Maximize"]],
    ["Meta+Shift+X", "plastile.focus.down", ["Other"]],
  ]);
  // A command kglobalaccel does not list is checked with its default.
  const missing = findConflicts(COMMANDS, parseInfos(seq([seq([info("Window Maximize", "Maximize Window", "kwin", [H])])])));
  assert.deepEqual(missing.map((c) => c.command), ["plastile.focus.left"]);
  assert.deepEqual(findConflicts(COMMANDS, []), []);
});

test("the audit keeps one request in flight, reports once, and ignores replies after cancel", () => {
  const bus = new FakeBus();
  const reports: ShortcutReport[] = [];
  const a = new ShortcutAudit(bus.fn, COMMANDS, (r) => reports.push(r));
  a.start();
  assert.equal(bus.pending.length, 1);
  bus.reply([seq(["/component/kwin", "/component/b"])]);
  assert.equal(bus.pending.length, 1, "components are queried one at a time");
  assert.equal(bus.pending[0].call.path, "/component/kwin");
  bus.reply([seq([info("Window Maximize", "Maximize Window", "kwin", [keyCode("Meta+Shift+H")!])])]);
  assert.equal(bus.pending[0].call.path, "/component/b");
  bus.failNext();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].state, "done");
  assert.equal(reports[0].components, 1, "the failed component is not counted");
  assert.deepEqual(reports[0].conflicts.map((c) => c.command), ["plastile.focus.left"]);

  a.start();
  bus.reply([seq(["/component/kwin"])]);
  a.cancel();
  bus.reply([seq([])]);
  assert.equal(reports.length, 1, "a cancelled run never reports");
  a.start();
  bus.failNext();
  assert.equal(reports[1].state, "unavailable");
});

// -------------------------------------------------------------------- runtime

test("D9: reload asks KWin to reconfigure and activates only when KWin reports the re-read configuration", () => {
  const { f, qt, bus, rt, wins } = setup({ gapInner: 8, diagnostics: "info" });
  qt.drain();
  bus.pending.length = 0; bus.log.length = 0; // the startup shortcut audit is not under test here
  f.cfg.gapInner = 30; // written to kwinrc; KWin's cached copy is what readConfig sees after its reconfigure
  rt.dispatch("plastile.runtime.reload-config");
  assert.deepEqual(bus.log[0], { service: "org.kde.KWin", path: "/KWin", iface: "org.kde.KWin", method: "reconfigure" });
  qt.drain();
  assert.ok(!f.lines.some((l) => l.includes("configuration activated")), "nothing activates before KWin re-reads");
  f.configChanged.emit(); // KWin's reconfigure timer fired: kwinrc re-read, Options.configChanged
  qt.drain();
  assert.equal(f.lines.filter((l) => l.includes("configuration activated")).length, 1);
  const [a, b] = wins.map((w) => w.frameGeometry).sort((p: { x: number }, q: { x: number }) => p.x - q.x);
  assert.equal(b.x - (a.x + a.width), 30, "the new gap is applied (fake frames)");
  // A storm of requests: each is one D-Bus call; KWin coalesces them into one re-read.
  for (let i = 0; i < 20; ++i) rt.dispatch("plastile.runtime.reload-config");
  assert.equal(bus.log.filter((c) => c.method === "reconfigure").length, 21);
  f.configChanged.emit();
  qt.drain();
  assert.equal(f.lines.filter((l) => l.includes("configuration activated")).length, 1, "unchanged input is not a new revision");
  rt.shutdown();
});

test("D9: a failed reconfigure request falls back to re-reading; without D-Bus the command re-reads at once", () => {
  const { f, qt, bus, rt } = setup({ gapInner: 8, diagnostics: "info" });
  qt.drain();
  bus.pending.length = 0;
  f.cfg.gapInner = 12;
  rt.dispatch("plastile.runtime.reload-config");
  const req = bus.pending.find((p) => p.call.method === "reconfigure")!;
  req.fail();
  assert.ok(f.lines.some((l) => l.includes("plastile warn KWin reconfigure request failed")));
  assert.equal(f.lines.filter((l) => l.includes("configuration activated")).length, 1);
  rt.shutdown();

  const plain = setup({ gapInner: 8, diagnostics: "info" }, false);
  plain.f.cfg.gapInner = 16;
  plain.rt.dispatch("plastile.runtime.reload-config");
  assert.equal(plain.f.lines.filter((l) => l.includes("configuration activated")).length, 1);
  plain.rt.shutdown();
});

test("T26: the shortcut check starts on a later turn, logs one warning, and is shown in explain and counters", () => {
  const { f, qt, bus, rt, ws, wins } = setup({ diagnostics: "info" });
  assert.equal(bus.log.length, 0, "nothing is requested during start");
  qt.turn();
  assert.equal(bus.log.length, 1);
  bus.reply([seq(["/component/kwin"])]);
  bus.reply([seq([info("Window Maximize", "Maximize Window", "kwin", [keyCode("Meta+Shift+H")!])])]);
  const warn = f.lines.filter((l) => l.startsWith("plastile warn shortcut conflicts: "));
  assert.equal(warn.length, 1);
  assert.match(warn[0], /Meta\+Shift\+H: "Plastile: Focus left" and "Maximize Window" \(KWin\)/);
  ws.activeWindow = wins[0];
  rt.dispatch("plastile.inspect.explain-window");
  const ex = JSON.parse(f.lines.find((l) => l.startsWith("plastile notice explain "))!.slice("plastile notice explain ".length));
  assert.equal(ex.shortcutConflicts[0].key, "Meta+Shift+H");
  rt.dispatch("plastile.inspect.counters");
  const counters = JSON.parse(f.lines.find((l) => l.startsWith("plastile counters "))!.slice("plastile counters ".length));
  assert.deepEqual(counters.shortcuts, { state: "done", conflicts: 1 });
  rt.shutdown();
});

test("T28: explain opens the inspector, a second explain closes it, shutdown closes it and drops late replies", () => {
  const { f, qt, bus, rt, ws, wins, opened, inspector } = setup({ diagnostics: "info" });
  qt.drain();
  for (const c of ["plastile.focus.left", "plastile.resize.grow", "plastile.layout.next"]) rt.dispatch(c);
  assert.equal(opened.length, 0, "keyboard commands never create the inspector");
  ws.activeWindow = wins[1];
  rt.dispatch("plastile.inspect.explain-window");
  assert.equal(opened.length, 1);
  assert.ok(inspector.isOpen());
  assert.equal(opened[0].windowTitle, INSPECTOR_TITLE);
  assert.equal(opened[0].heading, "app2");
  rt.dispatch("plastile.inspect.explain-window");
  assert.ok(!inspector.isOpen(), "the same command closes it");
  rt.dispatch("plastile.inspect.explain-window");
  assert.ok(inspector.isOpen());
  rt.shutdown();
  assert.ok(!inspector.isOpen(), "unload closes the inspector");
  const lines = f.lines.length;
  while (bus.pending.length) bus.reply([seq(["/component/kwin"])]);
  assert.equal(f.lines.length, lines, "a reply after shutdown does nothing");
});

test("T28: explain names a monitor's output by its connector, as overrides match it; the EDID key stays in details", () => {
  const ws = new FakeWorkspace([{ ...output("DP-1", { x: 0, y: 0, width: 1280, height: 800 }),
    manufacturer: "Dell Inc.", model: "DELL U2720Q", serialNumber: "ABC123" }], [desktop("D1")]);
  const qt = new FakeQt();
  const w = ws.window({ caption: "w1", resourceClass: "app1" });
  ws.windows.push(w);
  const f = fakeEnv(ws, qt);
  const opened: InspectorView[] = [];
  f.env.inspector = { open: (v: InspectorView) => { opened.push(v); }, close: () => {}, isOpen: () => false };
  const rt = createRuntime(f.env);
  qt.drain();
  ws.activeWindow = w;
  rt.dispatch("plastile.inspect.explain-window");
  const rows = Object.fromEntries(opened[0].rows.map((r) => [r.label, r.text]));
  assert.equal(rows.Where, "Output DP-1, desktop “D1”.");
  assert.match(opened[0].details.find((d) => d.label === "Context")!.text, /^DP-1 \(key edid:Dell Inc\.\/DELL U2720Q\/ABC123\) \//);
  const ex = JSON.parse(f.lines.find((l) => l.startsWith("plastile notice explain "))!.slice("plastile notice explain ".length));
  assert.equal(ex.context.output, "edid:Dell Inc./DELL U2720Q/ABC123", "the identity key");
  assert.equal(ex.context.outputName, "DP-1", "the connector name");
  rt.shutdown();
});

test("T28: own-UI detection needs the caption and no client identity", () => {
  const ws = new FakeWorkspace([output("O1", { x: 0, y: 0, width: 1280, height: 800 })], [desktop("D1")]);
  const internal = ws.window({ caption: INSPECTOR_TITLE, resourceClass: "", desktopFileName: "", pid: -1, popupWindow: true });
  assert.ok(isOwnUi(internal));
  assert.equal(metaOf(internal).own, true);
  assert.equal(isOwnUi(ws.window({ caption: INSPECTOR_TITLE, resourceClass: "evil", pid: 42 })), false);
  assert.equal(isOwnUi(ws.window({ caption: INSPECTOR_TITLE, resourceClass: "", desktopFileName: "", pid: 42 })), false);
  assert.equal(isOwnUi(ws.window({ caption: "other", resourceClass: "", desktopFileName: "", pid: -1 })), false);
});

// ------------------------------------------------------------------ explain view

const EXPLAIN = {
  id: "{1234-abcd}", appId: "org.kde.kate", kind: "normal", mode: "floating", userMode: null,
  decision: { mode: "tiled", source: "default", reason: "normal resizable window", ruleIds: [] },
  rules: { ids: ["kate-min"], actions: { minSize: "900x0" }, reasons: { minSize: "rule kate-min" } },
  context: { output: "edid:Dell Inc./DELL U2720Q/ABC123", desktop: "5c2a-uuid", activity: "act-uuid" }, layout: "master-stack",
  suspensions: ["minimized"], constraints: { minFrame: { width: 900, height: 200 }, maxFrame: { width: Infinity, height: Infinity }, fixed: false },
  learnedMin: { width: 549, height: 242 }, learnedMax: null,
  ledger: { status: "idle", outstanding: false, desired: null, corrections: 0 }, slot: null,
  exception: "overflow: kate: min width 900 > 600", nativeTile: false, nativeYield: false,
};

test("T28: the view speaks behaviour; internal ids appear only in details", () => {
  const v = describeWindow(EXPLAIN, { desktopNameOf: (id) => (id === "5c2a-uuid" ? "Writing" : ""),
    outputNameOf: (k) => (k === "edid:Dell Inc./DELL U2720Q/ABC123" ? "DP-1" : k), shortcuts: null, area: null });
  const rows = Object.fromEntries(v.rows.map((r) => [r.label, r.text]));
  assert.match(rows.Placement, /^Floating/);
  assert.match(rows.Rules, /Matching: kate-min\. Applied: tile at least 900 px wide \(from kate-min\)/);
  assert.equal(rows.Why, "It would be tiled (normal resizable window), but there is not enough room (see Problem).");
  assert.equal(rows.Where, "Output DP-1, desktop “Writing”.");
  assert.match(rows.Paused, /minimized/);
  assert.match(rows.Size, /at least 900×200.*no less than 549×242/);
  assert.match(rows.Problem, /Not enough room/);
  const text = JSON.stringify(v.rows);
  for (const id of ["{1234-abcd}", "5c2a-uuid", "act-uuid", "edid:"]) assert.ok(!text.includes(id), `rows mention ${id}`);
  const details = JSON.stringify(v.details);
  for (const id of ["{1234-abcd}", "5c2a-uuid", "act-uuid", "overflow: kate"]) assert.ok(details.includes(id), `details lack ${id}`);
  assert.equal(v.details.find((d) => d.label === "Context")!.text,
    "DP-1 (key edid:Dell Inc./DELL U2720Q/ABC123) / 5c2a-uuid / act-uuid", "the connector name, with the identity key");
  const none = describeWindow(null, { desktopNameOf: () => "", outputNameOf: (k) => k, shortcuts: null, area: null });
  assert.match(none.rows[0].text, /No active window/);
  const conflicts = describeWindow(null, { desktopNameOf: () => "", outputNameOf: (k) => k, area: null, shortcuts: { state: "done", components: 1, actions: 1,
    conflicts: [{ key: "Meta+Shift+H", command: "plastile.focus.left", commandText: "Plastile: Focus left",
                  others: [{ component: "KWin", action: "Window Maximize", text: "Maximize Window" }] }] } });
  assert.match(conflicts.rows[1].text, /Meta\+Shift\+H runs “Focus left” and also “Maximize Window” \(KWin\)/);
});
