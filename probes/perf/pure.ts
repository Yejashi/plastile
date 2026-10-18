// P04 pure-core scaling (PERFORMANCE §5): the production engine and layouts driven by the
// mock compositor (tests/core/mockHost.ts) in Node, with 32/100/250 synthetic windows.
//
// This is Node's V8, not KWin's QV4, and the host is a mock: it informs algorithm and queue
// scaling only. It is not a QV4/KWin measurement and proves nothing about desktop latency.
//
// Timed spans (process.hrtime.bigint, CLOCK_MONOTONIC):
//   executeNs   Engine.execute(command) entry -> return (every frame request issued)
//   solveNs     the engine's own solve span (EngineOptions.clockNs), when the command solves
//   flushNs     deferred engine callbacks (the coalesced flush) after a burst of opens/closes;
//               the mock compositor's commit work is excluded
// Client commits are drained between samples and are not timed.
//
// Usage: node probes/perf/pure.ts [--counts 32,100,250] [--samples 2000] [--warmup 200] [--seed 1] [--raw FILE]
// Prints one JSON summary on stdout.

import { writeFileSync } from "node:fs";
import { rect } from "../../src/core/geometry.ts";
import { MockHost } from "../../tests/core/mockHost.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const COUNTS = (args.get("counts") ?? "32,100,250").split(",").map(Number);
const SAMPLES = Number(args.get("samples") ?? 2000);
const WARMUP = Number(args.get("warmup") ?? 200);
const BURSTS = Number(args.get("bursts") ?? 20);
const RAW = args.get("raw");

const now = (): number => Number(process.hrtime.bigint());

/** Deferred callbacks are timed individually; identity is kept so the engine's dedup still works. */
class TimedHost extends MockHost {
  laterNs = 0;
  private wrapped = new Map<() => void, () => void>();
  override callLater(fn: () => void): void {
    let w = this.wrapped.get(fn);
    if (!w) {
      w = () => { const t0 = now(); fn(); this.laterNs += now() - t0; };
      this.wrapped.set(fn, w);
    }
    super.callLater(w);
  }
}

function q(xs: number[]) {
  const s = xs.slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const p = (f: number) => s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))];
  return { n: s.length, min: s[0], p50: p(0.5), p95: p(0.95), p99: p(0.99), max: s[s.length - 1] };
}

function setup(n: number) {
  const h = new TimedHost();
  // Tall enough that no layout is clamped (the mock windows have no minimum size).
  h.outs = [{ id: "O1", name: "O1", geometry: rect(0, 0, 1920, Math.max(1080, n * 40)), scale: 1 }];
  const e = h.start({ clockNs: now });
  for (let i = 1; i <= n; ++i) h.open(`w${i}`);
  h.drain();
  h.activate("w1");
  h.drain();
  return { h, e };
}

const WORKLOADS: Record<string, (k: number) => string> = {
  ratio: (k) => (k % 2 ? "plastile.resize.shrink" : "plastile.resize.grow"),
  swap: () => "plastile.swap.next",
  layout: (k) => (k % 2 ? "plastile.master.decrease" : "plastile.master.increase"),
  focus: () => "plastile.focus.next",
};

const out: Record<string, unknown> = {
  layer: "pure core + mock compositor in Node (V8), not QV4/KWin",
  node: process.version, samples: SAMPLES, warmup: WARMUP, bursts: BURSTS, counts: {},
};
const raw: Record<string, Record<string, number[]>> = {};

for (const n of COUNTS) {
  const row: Record<string, unknown> = {};
  raw[String(n)] = {};
  for (const [name, cmd] of Object.entries(WORKLOADS)) {
    const { h, e } = setup(n);
    const exec: number[] = [], solve: number[] = [], writes: number[] = [];
    let solves = 0;
    for (let k = 0; k < WARMUP + SAMPLES; ++k) {
      const s0 = e.counters.solves, w0 = h.writes.length;
      e.lastTiming = null;
      const t0 = now();
      const r = e.execute(cmd(k));
      const dt = now() - t0;
      if (r.status !== "accepted" && name !== "focus") throw new Error(`${name} n=${n}: ${r.status} ${r.reason ?? ""}`);
      if (k >= WARMUP) {
        exec.push(dt);
        writes.push(h.writes.length - w0);
        solves += e.counters.solves - s0;
        const timing = e.lastTiming as { solveNs: number } | null; // set by execute()
        if (timing) solve.push(timing.solveNs);
      }
      h.drain();
    }
    raw[String(n)][name] = exec;
    row[name] = { executeNs: q(exec), solveNs: q(solve), writesPerCommand: q(writes), solvesPerCommand: solves / SAMPLES,
                  corrections: e.counters.corrections, errors: e.counters.errors };
  }
  // Burst: n opens in one turn, then the coalesced flush; then n closes in one turn.
  const open: number[] = [], close: number[] = [], openSolves: number[] = [], openWrites: number[] = [], closeSolves: number[] = [];
  for (let b = 0; b < BURSTS + 2; ++b) {
    const h = new TimedHost();
    h.outs = [{ id: "O1", name: "O1", geometry: rect(0, 0, 1920, Math.max(1080, n * 40)), scale: 1 }];
    const e = h.start({ clockNs: now });
    let t0 = now();
    for (let i = 1; i <= n; ++i) h.open(`w${i}`);
    const addNs = now() - t0;
    h.laterNs = 0;
    h.drain();
    if (b >= 2) { open.push(addNs + h.laterNs); openSolves.push(e.counters.solves); openWrites.push(h.writes.length); }
    const s1 = e.counters.solves;
    t0 = now();
    for (let i = 1; i <= n; ++i) h.close(`w${i}`);
    const rmNs = now() - t0;
    h.laterNs = 0;
    h.drain();
    if (b >= 2) { close.push(rmNs + h.laterNs); closeSolves.push(e.counters.solves - s1); }
  }
  row.burst = { openAndFlushNs: q(open), solvesPerOpenBurst: q(openSolves), writesPerOpenBurst: q(openWrites),
                closeAndFlushNs: q(close), solvesPerCloseBurst: q(closeSolves), warmupBursts: 2 };
  (out.counts as Record<string, unknown>)[String(n)] = row;
}

if (RAW) writeFileSync(RAW, JSON.stringify(raw));
process.stdout.write(JSON.stringify(out) + "\n");
