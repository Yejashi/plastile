// Runtime entry point bundled into package/contents/code/plastile.js and created
// by the declarative root (package/contents/ui/main.qml), once per script load.

import { Engine, type EngineOptions } from "../core/engine.ts";
import { COMMANDS, type CommandResult } from "../core/commands.ts";
import type { RuntimeServices } from "../core/ports.ts";
import type { ContextKey, LayoutKind } from "../core/types.ts";
import {
  compileConfig, FLAT_KEYS, formatError, resolveContext, resolveWindow, type ConfigSnapshot, type ContextInfo,
} from "../config/index.ts";
import { diffConfig } from "../config/diff.ts";
import { KwinAdapter } from "../adapters/kwin/adapter.ts";
import type { KKWin, KOptions, KQt, KSignal, KWorkspace } from "../adapters/kwin/kwinTypes.ts";
import { describeConflicts, ShortcutAudit, type Bus, type ShortcutReport } from "./shortcuts.ts";
import { describeWindow, type InspectorView } from "./inspect.ts";
import { zoneOverlayView, type ZoneOverlayHost } from "./zoneOverlay.ts";
import { Persister, type StateStore } from "./persistence.ts";
import { ReplayRecorder, type RecordOptions } from "./replay.ts";
import { layoutMessage, Osd, pauseMessage } from "./osd.ts";

export const VERSION = "0.1.0";
export { COMMANDS };

export interface RuntimeEnv {
  readonly workspace: KWorkspace;
  readonly kwin: KKWin;
  readonly qt: KQt;
  readonly options: KOptions;
  /** Start (or restart) the single QML deadline Timer. */
  setDeadline(ms: number): void;
  clearDeadline(): void;
  print(line: string): void;
  /** Measurement builds only (probes/perf): CLOCK_MONOTONIC ns and per-command timing logs. */
  readonly clockNs?: () => number;
  readonly perf?: boolean;
  // ---- configuration reload, shortcut report, inspector (T26, T28, D9) ----
  /** Asynchronous session-bus call (KWin's DBusCall, one object per call); absent: features that need it are off. */
  readonly dbus?: Bus;
  /** The lazily created inspector window (package/contents/ui/Inspector.qml); absent: explain only logs. */
  readonly inspector?: InspectorHost;
  /** The lazily created zones overlay (package/contents/ui/ZoneOverlay.qml, experimental); absent: zone.show only logs. */
  readonly zones?: ZoneOverlayHost;
  // ---- persistence (T27, ADR-020) ----
  /**
   * Saved session preferences: package/contents/ui/Persistence.qml, asynchronous calls to the
   * plastile-state helper. Absent: nothing is loaded or saved.
   */
  readonly state?: StateStore;
  // ---- replay recording (T10) ----
  /** Recording builds only (tools/replay/record.qml): record the engine's normalized event stream and print it at unload. */
  readonly record?: RecordOptions;
}

export interface InspectorHost {
  open(view: InspectorView): void;
  close(): void;
  isOpen(): boolean;
}

/**
 * Log levels. `notice` is the few lines that tell a user Plastile is alive and what it did on
 * its own or by a command (started, stopped, a layout a command chose, tiling paused or
 * resumed, saved layouts restored, the explanation the user asked for). It shows at the
 * default `warn` threshold and above; only `error` and `off` hide it. Nothing per window event.
 */
type Level = "error" | "notice" | "warn" | "info" | "debug";
const LEVELS: Record<string, number> = { off: -1, error: 0, notice: 1, warn: 1, info: 2, debug: 3 };
/** Restored layouts named in the one notice at load; the rest are counted. */
const RESTORED_NAMED = 8;

export interface Runtime {
  readonly commands: typeof COMMANDS;
  readonly version: string;
  dispatch(id: string): CommandResult | null;
  onDeadline(): void;
  shutdown(): void;
}

export function createRuntime(env: RuntimeEnv): Runtime {
  let level = LEVELS.warn;
  const log = (lv: Level, message: string, data?: unknown): void => {
    if (LEVELS[lv] > level) return;
    env.print(`plastile ${lv} ${message}${data === undefined ? "" : " " + safeJson(data)}`);
  };
  // On-screen feedback (Plasma's OSD over D-Bus, src/runtime/osd.ts); each configuration load sets whether it is on.
  const osd = new Osd(env.dbus, (fn) => env.qt.callLater(fn), () => Date.now(), (m) => log("debug", m));

  let revision = 0;
  let snapshot: ConfigSnapshot | null = null;
  const readFlat = (): Record<string, unknown> => {
    const flat: Record<string, unknown> = {};
    // Flat keys from kwinrc [Script-plastile] (the settings dialog writes these). readConfig
    // reads one key by name and cannot list the group, so a mistyped key is never seen here
    // (the validator's unknown-key warning is reachable only from compileConfig callers).
    for (const k of FLAT_KEYS) flat[k] = env.kwin.readConfig(k, "");
    return flat;
  };
  /** Validate and compile; on failure keep the previous revision (Q01). */
  let lastInput: string | null = null;
  const loadConfig = (): boolean => {
    const flat = readFlat();
    const key = JSON.stringify(flat);
    // KWin emits configChanged for unrelated reconfigures (also right after a script
    // loads); identical input is not a new revision and invalidates nothing.
    if (key === lastInput) return false;
    lastInput = key;
    const r = compileConfig(flat, ++revision);
    if (!r.ok) {
      log("error", "configuration rejected; keeping previous revision", r.errors.slice(0, 20).map(formatError));
      if (snapshot === null) {
        const fallback = compileConfig({}, revision);
        if (fallback.ok) snapshot = fallback.snapshot;
      }
      return false;
    }
    for (const w of r.warnings) log("warn", "configuration: " + formatError(w));
    snapshot = r.snapshot;
    level = LEVELS[snapshot.diagnostics] ?? LEVELS.warn;
    osd.setEnabled(snapshot.osd);
    return true;
  };
  loadConfig();

  let pendingDeadline: (() => void) | null = null;
  const svc: RuntimeServices = {
    now: () => Date.now(),
    callLater: (fn) => env.qt.callLater(fn),
    deadline: (ms, fn) => {
      pendingDeadline = fn;
      env.setDeadline(Math.max(1, Math.round(ms)));
      return () => {
        if (pendingDeadline === fn) { pendingDeadline = null; env.clearDeadline(); }
      };
    },
    log,
  };

  const adapter = new KwinAdapter(env.workspace, env.qt);
  // Recording builds stand a recorder between the engine and its ports; otherwise the engine talks to them directly.
  const rec = env.record ? new ReplayRecorder(svc, env.record) : null;
  if (rec) rec.config = JSON.parse(lastInput!);
  const names = rec ? rec.names(adapter) : adapter;
  const options = (snap: ConfigSnapshot): EngineOptions => ({ ...engineOptions(snap, names), clockNs: env.clockNs });

  const engine = new Engine(rec ? rec.host(adapter) : adapter, rec ? rec.services(svc) : svc, options(snapshot!));
  const initial = adapter.attach(rec ? rec.sink(engine) : engine, snapshot!.usesTitleRules);
  /** A desktop's name for notices and the OSD ("desktop 3" when unnamed). */
  const desktopLabel = (desktop: string): string => {
    const d = adapter.desktopNameOf(desktop);
    if (d) return d;
    const i = adapter.desktops().indexOf(desktop);
    return i >= 0 ? `desktop ${i + 1}` : "a removed desktop";
  };
  /** "eDP-1 / Desktop 2": an output's connector name and a desktop's name. */
  const placeName = (output: string, desktop: string): string => `${adapter.outputNameOf(output)} / ${desktopLabel(desktop)}`;
  // ---- persistence (T27, ADR-020): requested at start-up, applied when the helper replies ----
  const persister = new Persister(env.state, engine, {
    now: svc.now, log, stamp: () => new Date().toISOString(), clockNs: env.perf ? env.clockNs : undefined,
    restoredLayouts: (items) => {
      // Once per load: the saved layouts that differ from the configuration (they look permanent otherwise).
      const odd = items.filter((x) => x.layout !== engine.configuredLayout(x.key));
      if (odd.length === 0) return;
      const named = odd.slice(0, RESTORED_NAMED).map((x) => `${x.layout} for ${placeName(x.key.output, x.key.desktop)}`);
      const more = odd.length > RESTORED_NAMED ? ` and ${odd.length - RESTORED_NAMED} more` : "";
      log("notice", `restored saved layout ${named.join(", ")}${more}`);
    },
  });
  engine.onPersistChange = (scope) => persister.markDirty(scope);
  // ---- end T27 ----
  // ---- notices and the OSD for what a command changed (one line each; the OSD on a later turn) ----
  engine.onLayoutChange = (key: ContextKey, layout: LayoutKind, previous: LayoutKind) => {
    log("notice", `layout ${layout} on ${placeName(key.output, key.desktop)} (was ${previous})`);
    const desk = adapter.desktops().length > 1 ? desktopLabel(key.desktop) : null;
    const out = adapter.outputs().length > 1 ? adapter.outputNameOf(key.output) : null;
    osd.show(layoutMessage(layout, desk, out));
  };
  engine.onSuspendChange = (paused: boolean) => {
    log("notice", paused ? "tiling paused" : "tiling resumed");
    osd.show(pauseMessage(paused));
  };
  // With a store, the first solve waits for the saved state, bounded by LOAD_HOLD_MS (ADR-020
  // addendum): a restored float or ratio is then the first geometry written, not a correction of
  // a default tile. Commands and events meanwhile update the model; their geometry is held work.
  // Without a store there is nothing to wait for. Recording builds do not hold: the recorder
  // has no input for the release, and replays model no persistence.
  const hold = env.state !== undefined && !rec;
  if (rec) rec.start(initial, () => engine.start(initial));
  else engine.start(initial, hold);
  {
    const shown: string[] = [];
    const act = adapter.currentActivity();
    for (const o of adapter.outputs()) {
      const d = adapter.visibleDesktop(o.id);
      if (d !== null) shown.push(`layout ${engine.layoutAt({ output: o.id, desktop: d, activity: act })} on ${placeName(o.id, d)}`);
    }
    log("notice", `started ${VERSION}: ${initial.length} window${initial.length === 1 ? "" : "s"}, configuration revision `
      + `${snapshot!.revision}${shown.length ? "; " + shown.join("; ") : ""}`);
  }
  persister.load(hold ? () => engine.releaseHold() : undefined);

  // KWin emits configChanged after every reconfigure (its own, the reload command's, other
  // settings pages'), once after a script loads; the settings dialog's Apply alone emits nothing.
  const optionConns: Array<{ signal: KSignal; fn: () => void }> = [];
  const onConfig = (): void => {
    if (!engine.isAlive()) return;
    const prev = snapshot;
    if (loadConfig()) {
      // Caption watching follows the active rules; on activation the current titles are read
      // before the engine re-classifies.
      adapter.setWatchTitles(snapshot!.usesTitleRules);
      // Only what changed is re-evaluated (T26): a gap-only change reclassifies nothing.
      const d = diffConfig(prev, snapshot!);
      const activate = () => engine.configure({ ...options(snapshot!), changes: { rules: d.rules, settings: d.settings } });
      if (rec) rec.configure(JSON.parse(lastInput!), activate);
      else activate();
      log("info", "configuration activated", { revision: snapshot!.revision });
    }
  };
  env.options.configChanged.connect(onConfig);
  optionConns.push({ signal: env.options.configChanged, fn: onConfig });
  // desktopName matchers read the names when contexts and rules resolve: a rename
  // re-resolves the active configuration (settings and classification), as an activation
  // does. Without such matchers a rename changes nothing and costs nothing.
  adapter.onDesktopNamesChanged = () => {
    if (!engine.isAlive() || !snapshot || !snapshot.usesDesktopNames) return;
    if (rec) rec.configure(null, () => engine.configure(options(snapshot!)));
    else engine.configure(options(snapshot));
  };

  // ---- configuration reload, shortcut report, inspector (T26, T28, D9) ----
  const bus = env.dbus;
  // Shortcut report: read-only, once per load (and per reload request), on a later event-loop
  // turn than the start, one D-Bus request in flight at a time; never on the command path.
  let shortcuts: ShortcutReport | null = null;
  const audit = bus ? new ShortcutAudit(bus, COMMANDS, (r) => {
    if (!engine.isAlive()) return;
    shortcuts = r;
    if (r.state === "unavailable") log("info", `shortcut check unavailable: ${r.reason}`);
    else if (r.conflicts.length > 0) {
      log("warn", `shortcut conflicts: ${describeConflicts(r.conflicts)} (change one in System Settings, Keyboard, Shortcuts)`);
    } else log("info", "shortcut check: no conflicts", { components: r.components, actions: r.actions });
  }) : null;
  const startAudit = (): void => { if (audit && engine.isAlive()) audit.start(); };
  if (audit) env.qt.callLater(startAudit);
  // Reload: the settings dialog's Apply does not reach a script, and readConfig reads KWin's
  // cached kwinrc, so re-reading alone changes nothing (KWin v6.7.5 genericscriptedconfig.cpp
  // ScriptingConfig::reload() is a TODO). Ask KWin to reconfigure instead: an asynchronous
  // D-Bus call whose handler only (re)starts KWin's 200 ms reconfigure timer; KWin then
  // re-reads kwinrc and emits Options.configChanged, which activates through onConfig. A
  // burst of requests restarts that timer: one re-read, one activation (Q04).
  const reloadConfig = (): void => {
    if (!bus) { onConfig(); return; }
    log("info", "configuration reload requested");
    bus({ service: "org.kde.KWin", path: "/KWin", iface: "org.kde.KWin", method: "reconfigure" }, () => {}, () => {
      if (!engine.isAlive()) return;
      log("warn", "KWin reconfigure request failed; re-reading KWin's cached configuration");
      onConfig();
    });
    env.qt.callLater(startAudit);
  };
  const activeArea = (): InspectorView["area"] => {
    const o = adapter.activeOutput();
    const d = o === null ? null : adapter.visibleDesktop(o);
    return o === null || d === null ? null : adapter.workArea(o, d);
  };
  const explainWindow = (): void => {
    const a = adapter.activeWindow();
    const e = a ? engine.explain(a) : null;
    // `context.output` is the output's identity key (E16); `outputName` is its connector name, which
    // overrides and rules match.
    const key = e && e.context ? (e.context as ContextKey) : null;
    const x = e && key ? { ...e, context: { ...key, outputName: adapter.outputNameOf(key.output) } } : e;
    const conflicts = shortcuts && shortcuts.conflicts.length > 0 ? shortcuts.conflicts : null;
    // Asked for by the user: a notice, so the default log level shows it.
    log("notice", "explain", x ? (conflicts ? { ...x, shortcutConflicts: conflicts } : x) : { error: "no active window" });
    // The inspector window exists only from this command until it closes (Escape, a click
    // elsewhere, another window activated, this command again, or unload).
    const ins = env.inspector;
    if (!ins) return;
    if (ins.isOpen()) ins.close();
    else ins.open(describeWindow(x, { desktopNameOf: (id) => adapter.desktopNameOf(id), outputNameOf: (k) => adapter.outputNameOf(k),
      shortcuts, area: activeArea() }));
  };
  // ---- end T26/T28/D9 ----

  // ---- zones overlay (M9, experimental; docs/design/ZONES.md §4) ----
  // Exists from the first "show" until unload; draws the engine's own projection. Refreshed only by
  // Plastile commands while shown (no timer, no polling, nothing at all while hidden).
  const zoneOverlay = (refreshOnly: boolean): void => {
    const host = env.zones;
    const shown = !!host && host.state() === "shown";
    if (refreshOnly && !shown) return;
    if (!refreshOnly && shown) { host!.hide(); return; }
    const m = engine.zoneOverlay();
    if ("reason" in m) {
      if (shown) host!.hide();
      log("info", `zones overlay not shown: ${m.reason}`);
      return;
    }
    const view = zoneOverlayView(m);
    log("info", "zones overlay", { output: m.output, layout: m.layout, zones: view.rects.map((z) => ({ n: z.n, rect: z.rect })) });
    if (host) host.show(view);
  };
  // ---- end zones overlay ----

  const dispatch = (id: string): CommandResult | null => {
    if (!engine.isAlive()) return null;
    if (id === "plastile.inspect.explain-window") { explainWindow(); return null; }
    if (id === "plastile.inspect.counters") {
      env.print("plastile counters " + safeJson({ counters: engine.counters, outstanding: engine.outstandingCount(),
        holding: engine.isHolding(),
        connections: adapter.connectionCount(), transientConnections: adapter.transientConnectionCount(),
        windows: adapter.windowCount(), contexts: engine.contextSummary(),
        configRevision: snapshot?.revision ?? null,
        shortcuts: shortcuts ? { state: shortcuts.state, conflicts: shortcuts.conflicts.length } : null,
        inspectorOpen: env.inspector ? env.inspector.isOpen() : null, zoneOverlay: env.zones ? env.zones.state() : null,
        osd: { state: osd.state(), sent: osd.sent, failures: osd.failures }, suspended: engine.isSuspended(),
        persistence: persister.summary() }));
      return null;
    }
    if (id === "plastile.inspect.dump-trace") {
      env.print("plastile trace " + safeJson(engine.trace.snapshot()));
      return null;
    }
    if (id === "plastile.runtime.reconcile") {
      const live = adapter.liveSnapshots();
      if (rec) rec.reconcile(live, () => engine.reconcile(live));
      else engine.reconcile(live);
      return null;
    }
    if (id === "plastile.runtime.reload-config") { reloadConfig(); return null; }
    if (id === "plastile.zone.show") { zoneOverlay(false); return null; }
    const clock = env.perf ? env.clockNs : undefined;
    const t0 = clock ? clock() : 0;
    engine.lastTiming = null;
    engine.lastActivateNs = null;
    const r = rec ? rec.command(id, () => engine.execute(id)) : engine.execute(id);
    if (clock) {
      // Dispatch-to-last-request: execute() returns after every frame request was issued.
      env.print("plastile perf " + safeJson({ id, status: r.status, dispatchToReturnNs: clock() - t0, entryNs: t0,
        timing: engine.lastTiming, activateNs: engine.lastActivateNs, writes: r.requested }));
    }
    log("debug", "command", r);
    if (r.status === "accepted" && (id.indexOf("plastile.zone.") === 0 || id.indexOf("plastile.layout.") === 0)) zoneOverlay(true);
    return r;
  };

  return {
    commands: COMMANDS,
    version: VERSION,
    dispatch,
    onDeadline: () => {
      const fn = pendingDeadline;
      pendingDeadline = null;
      if (fn) fn();
    },
    shutdown: () => {
      // Own UI and pending D-Bus replies go first: neither may reach a stopped engine.
      if (audit) audit.cancel();
      osd.stop();
      if (env.inspector) env.inspector.close();
      if (env.zones) env.zones.destroy();
      // The last save reads the engine's preferences, so it precedes the engine's stop (T27); it is
      // one asynchronous Write, sent before Persistence.qml's call objects are destroyed.
      persister.shutdown();
      // Invalidate first (engine stops deferred work and restores owned state), then disconnect.
      if (rec) env.print("plastile replay " + rec.finish(engine, () => engine.stop()));
      else engine.stop();
      pendingDeadline = null;
      env.clearDeadline();
      for (const c of optionConns) { try { c.signal.disconnect(c.fn); } catch (_e) { /* gone */ } }
      optionConns.length = 0;
      adapter.detach();
      log("notice", "stopped");
    },
  };
}

/** Context names for configuration matchers (the adapter in KWin; a table in tests). */
export interface ContextNames {
  /** Connector name of an output identity key (E16). */
  outputNameOf(key: string): string;
  desktopNameOf(id: string): string;
}

/**
 * Engine options for a configuration snapshot: precedence-resolved settings per context and
 * rule actions per window in its context (CONFIGURATION §3-§4). Context keys carry the
 * output's identity key (E16); overrides and rules match its connector name.
 */
export function engineOptions(snap: ConfigSnapshot, names: ContextNames): EngineOptions {
  const info = (key: ContextKey): ContextInfo => ({
    outputName: names.outputNameOf(key.output), desktopId: key.desktop, desktopName: names.desktopNameOf(key.desktop),
    activityId: key.activity,
  });
  return {
    settingsFor: (key) => resolveContext(snap, info(key)).settings,
    rulesFor: (meta, key) => {
      const r = resolveWindow(snap, meta, key ? info(key) : null);
      if (r.ruleIds.length === 0) return null;
      return { mode: r.actions.mode, border: r.actions.border, insert: r.actions.insert, minSize: r.actions.minSize, zone: r.actions.zone,
               ruleIds: r.ruleIds, reasons: r.reasons };
    },
    titleRules: snap.usesTitleRules,
    traceCapacity: snap.traceCapacity,
    traceEnabled: snap.diagnostics !== "off",
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => (x === Infinity ? "Infinity" : x));
  } catch (_e) {
    return String(v);
  }
}
