// Runtime entry point bundled into package/contents/code/plastile.js and created
// by the declarative root (package/contents/ui/main.qml), once per script load.

import { Engine, type EngineOptions } from "../core/engine.ts";
import { COMMANDS, type CommandResult } from "../core/commands.ts";
import type { RuntimeServices } from "../core/ports.ts";
import type { ContextKey } from "../core/types.ts";
import {
  compileConfig, FLAT_KEYS, formatError, resolveContext, resolveWindow, type ConfigSnapshot, type ContextInfo,
} from "../config/index.ts";
import { KwinAdapter } from "../adapters/kwin/adapter.ts";
import type { KKWin, KOptions, KQt, KSignal, KWorkspace } from "../adapters/kwin/kwinTypes.ts";
import { describeConflicts, ShortcutAudit, type Bus, type ShortcutReport } from "./shortcuts.ts";
import { describeWindow, type InspectorView } from "./inspect.ts";

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
}

export interface InspectorHost {
  open(view: InspectorView): void;
  close(): void;
  isOpen(): boolean;
}

type Level = "error" | "warn" | "info" | "debug";
const LEVELS: Record<string, number> = { off: -1, error: 0, warn: 1, info: 2, debug: 3 };

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
  const options = (snap: ConfigSnapshot): EngineOptions => ({ ...engineOptions(snap, adapter), clockNs: env.clockNs });

  const engine = new Engine(adapter, svc, options(snapshot!));
  const initial = adapter.attach(engine, snapshot!.usesTitleRules);
  engine.start(initial);
  log("info", `started ${VERSION}`, { windows: initial.length, configRevision: snapshot!.revision });

  // KWin emits configChanged after every reconfigure (its own, the reload command's, other
  // settings pages'), once after a script loads; the settings dialog's Apply alone emits nothing.
  const optionConns: Array<{ signal: KSignal; fn: () => void }> = [];
  const onConfig = (): void => {
    if (!engine.isAlive()) return;
    if (loadConfig()) {
      // Caption watching follows the active rules; on activation the current titles are read
      // before the engine re-classifies.
      adapter.setWatchTitles(snapshot!.usesTitleRules);
      engine.configure(options(snapshot!));
      log("info", "configuration activated", { revision: snapshot!.revision });
    }
  };
  env.options.configChanged.connect(onConfig);
  optionConns.push({ signal: env.options.configChanged, fn: onConfig });
  // desktopName matchers read the names when contexts and rules resolve: a rename
  // re-resolves the active configuration (settings and classification), as an activation
  // does. Without such matchers a rename changes nothing and costs nothing.
  adapter.onDesktopNamesChanged = () => {
    if (engine.isAlive() && snapshot && snapshot.usesDesktopNames) engine.configure(options(snapshot));
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
    const x = a ? engine.explain(a) : null;
    const conflicts = shortcuts && shortcuts.conflicts.length > 0 ? shortcuts.conflicts : null;
    log("info", "explain", x ? (conflicts ? { ...x, shortcutConflicts: conflicts } : x) : { error: "no active window" });
    // The inspector window exists only from this command until it closes (Escape, a click
    // elsewhere, another window activated, this command again, or unload).
    const ins = env.inspector;
    if (!ins) return;
    if (ins.isOpen()) ins.close();
    else ins.open(describeWindow(x, { desktopNameOf: (id) => adapter.desktopNameOf(id), shortcuts, area: activeArea() }));
  };
  // ---- end T26/T28/D9 ----

  const dispatch = (id: string): CommandResult | null => {
    if (!engine.isAlive()) return null;
    if (id === "plastile.inspect.explain-window") { explainWindow(); return null; }
    if (id === "plastile.inspect.counters") {
      env.print("plastile counters " + safeJson({ counters: engine.counters, outstanding: engine.outstandingCount(),
        connections: adapter.connectionCount(), windows: adapter.windowCount(), contexts: engine.contextSummary(),
        configRevision: snapshot?.revision ?? null,
        shortcuts: shortcuts ? { state: shortcuts.state, conflicts: shortcuts.conflicts.length } : null,
        inspectorOpen: env.inspector ? env.inspector.isOpen() : null }));
      return null;
    }
    if (id === "plastile.inspect.dump-trace") {
      env.print("plastile trace " + safeJson(engine.trace.snapshot()));
      return null;
    }
    if (id === "plastile.runtime.reconcile") {
      engine.reconcile(adapter.liveSnapshots());
      return null;
    }
    if (id === "plastile.runtime.reload-config") { reloadConfig(); return null; }
    const clock = env.perf ? env.clockNs : undefined;
    const t0 = clock ? clock() : 0;
    engine.lastTiming = null;
    engine.lastActivateNs = null;
    const r = engine.execute(id);
    if (clock) {
      // Dispatch-to-last-request: execute() returns after every frame request was issued.
      env.print("plastile perf " + safeJson({ id, status: r.status, dispatchToReturnNs: clock() - t0, entryNs: t0,
        timing: engine.lastTiming, activateNs: engine.lastActivateNs, writes: r.requested }));
    }
    log("debug", "command", r);
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
      if (env.inspector) env.inspector.close();
      // Invalidate first (engine stops deferred work and restores owned state), then disconnect.
      engine.stop();
      pendingDeadline = null;
      env.clearDeadline();
      for (const c of optionConns) { try { c.signal.disconnect(c.fn); } catch (_e) { /* gone */ } }
      optionConns.length = 0;
      adapter.detach();
      log("info", "stopped");
    },
  };
}

/** Context names for configuration matchers (the adapter in KWin; a table in tests). */
export interface ContextNames {
  desktopNameOf(id: string): string;
}

/**
 * Engine options for a configuration snapshot: precedence-resolved settings per context and
 * rule actions per window in its context (CONFIGURATION §3-§4). Output identity is the
 * connector name, so the context's output id is also its outputName.
 */
export function engineOptions(snap: ConfigSnapshot, names: ContextNames): EngineOptions {
  const info = (key: ContextKey): ContextInfo => ({
    outputName: key.output, desktopId: key.desktop, desktopName: names.desktopNameOf(key.desktop), activityId: key.activity,
  });
  return {
    settingsFor: (key) => resolveContext(snap, info(key)).settings,
    rulesFor: (meta, key) => {
      const r = resolveWindow(snap, meta, key ? info(key) : null);
      if (r.ruleIds.length === 0) return null;
      return { mode: r.actions.mode, border: r.actions.border, insert: r.actions.insert, minSize: r.actions.minSize,
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
