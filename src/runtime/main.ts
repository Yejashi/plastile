// Runtime entry point bundled into package/contents/code/plastile.js and created
// by the declarative root (package/contents/ui/main.qml), once per script load.

import { Engine, type EngineOptions } from "../core/engine.ts";
import { COMMANDS, type CommandResult } from "../core/commands.ts";
import type { RuntimeServices } from "../core/ports.ts";
import type { ContextKey } from "../core/types.ts";
import { compileConfig, FLAT_KEYS, formatError, resolveContext, resolveWindow, type ConfigSnapshot } from "../config/index.ts";
import { KwinAdapter } from "../adapters/kwin/adapter.ts";
import type { KKWin, KOptions, KQt, KSignal, KWorkspace } from "../adapters/kwin/kwinTypes.ts";

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
    // Flat keys from kwinrc [Script-plastile] (the settings dialog writes these).
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
  const options = (snap: ConfigSnapshot): EngineOptions => ({
    settingsFor: (key: ContextKey) => resolveContext(snap, {
      outputName: key.output, desktopId: key.desktop, desktopName: adapter.desktopNameOf(key.desktop), activityId: key.activity,
    }).settings,
    rulesFor: (meta, key) => {
      const r = resolveWindow(snap, meta, key ? {
        outputName: key.output, desktopId: key.desktop, desktopName: adapter.desktopNameOf(key.desktop), activityId: key.activity,
      } : null);
      if (r.ruleIds.length === 0) return null;
      return { mode: r.actions.mode, border: r.actions.border, insert: r.actions.insert, ruleIds: r.ruleIds, reasons: r.reasons };
    },
    titleRules: snap.usesTitleRules,
    clockNs: env.clockNs,
    traceCapacity: snap.traceCapacity,
    traceEnabled: snap.diagnostics !== "off",
  });

  const engine = new Engine(adapter, svc, options(snapshot!));
  const initial = adapter.attach(engine, snapshot!.usesTitleRules);
  engine.start(initial);
  log("info", `started ${VERSION}`, { windows: initial.length, configRevision: snapshot!.revision });

  // Settings dialog "Apply" triggers KWin's reconfigure, which emits configChanged.
  const optionConns: Array<{ signal: KSignal; fn: () => void }> = [];
  const onConfig = (): void => {
    if (!engine.isAlive()) return;
    if (loadConfig()) {
      engine.configure(options(snapshot!));
      log("info", "configuration activated", { revision: snapshot!.revision });
    }
  };
  env.options.configChanged.connect(onConfig);
  optionConns.push({ signal: env.options.configChanged, fn: onConfig });

  const dispatch = (id: string): CommandResult | null => {
    if (!engine.isAlive()) return null;
    if (id === "plastile.inspect.explain-window") {
      const a = adapter.activeWindow();
      log("info", "explain", a ? engine.explain(a) : { error: "no active window" });
      return null;
    }
    if (id === "plastile.inspect.counters") {
      env.print("plastile counters " + safeJson({ counters: engine.counters, outstanding: engine.outstandingCount(),
        connections: adapter.connectionCount(), windows: adapter.windowCount(), contexts: engine.contextSummary(),
        configRevision: snapshot?.revision ?? null }));
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
    if (id === "plastile.runtime.reload-config") { onConfig(); return null; }
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

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => (x === Infinity ? "Infinity" : x));
  } catch (_e) {
    return String(v);
  }
}
