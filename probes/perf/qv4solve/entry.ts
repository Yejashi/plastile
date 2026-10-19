// QV4 pure-core solve probe (G2 report §16): the production engine and layouts driven by the
// mock compositor (tests/core/mockHost.ts), bundled for and run inside KWin's own QV4 engine in a
// nested session (probes/perf/qv4solve/main.qml). The solve span is the engine's own (the same
// clock points as in production: EngineOptions.clockNs), but the host is a mock: no KWin object
// crossings, mock frame writes and commits. It isolates the JavaScript engine's share (allocation,
// garbage collection) of the solve from KWin; it is not the §4 measurement, which stays P03.
//
// Built by probes/perf/qv4solve/run.py with tools/bundle-options.ts (target ES2016).

import { rect } from "../../../src/core/geometry.ts";
import { MockHost } from "../../../tests/core/mockHost.ts";

const CMDS: Record<string, (k: number) => string> = {
  ratio: (k) => (k % 2 ? "plastile.resize.shrink" : "plastile.resize.grow"),
  swap: () => "plastile.swap.next",
  master: (k) => (k % 2 ? "plastile.master.decrease" : "plastile.master.increase"),
};

export interface Bench {
  /** Run `count` commands of one workload; solve spans (ns) go into `out` from `at`. Returns commands that solved. */
  run(workload: string, count: number, out: Float64Array, at: number): number;
  errors(): number;
}

/** n windows of the fixture's measured minimum (150 x 178 frame) in master/stack on a tall output. */
export function createBench(clockNs: () => number, n: number, height: number): Bench {
  const h = new MockHost();
  h.outs = [{ id: "O1", name: "O1", geometry: rect(0, 0, 1920, height), scale: 1 }];
  const e = h.start({ clockNs });
  const c = { minFrame: { width: 150, height: 178 }, maxFrame: { width: Infinity, height: Infinity }, fixed: false };
  for (let i = 1; i <= n; ++i) h.open(`w${i}`, { constraints: c });
  h.drain();
  h.activate("w1");
  h.drain();
  let k = 0;
  return {
    run(workload, count, out, at) {
      const cmd = CMDS[workload];
      let solved = 0;
      for (let i = 0; i < count; ++i) {
        e.lastTiming = null;
        e.execute(cmd(k++));
        const t = e.lastTiming as { solveNs: number } | null;
        out[at + i] = t ? t.solveNs : -1;
        if (t) solved++;
        h.drain();
        h.writes.length = 0; // the mock's write log would grow the live heap without bound
        h.logs.length = 0;
      }
      return solved;
    },
    errors: () => e.counters.errors,
  };
}
