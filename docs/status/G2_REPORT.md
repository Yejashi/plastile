# G2 report: integration and performance gate (T20; nested parts of T34 and T04)

**Scope of every number here: nested KWin sessions on the reference host.** Nothing in this report was measured in
a physical Plasma session, so nothing here is an input-to-photon result. Node numbers (P04) are V8 with a mock host and
say nothing about KWin's QV4 engine. Geometry signals and client commits are not presented frames. The one exception
is a set of earlier windowed real-GPU runs, cited in §8 under their own label `nested-windowed-gpu`. They are still
nested and still not physical.

**Verdict.** G2 is **closed for the nested layer, with one budget not met**. Every mandatory nested scenario passes. All
counter gates hold, the dispatch-to-last-request budget is met at 32 windows, corrections stay bounded and are
explained, and teardown is clean. The open items:

- The **pure-solve p99 at 32 windows is 1.06–1.07 ms against a 1 ms budget**. It is not a near miss: 2.1–3.4 % of
  the measured n = 32 solves fall in a separate 0.8–1.5 ms mode, so the p99 lies inside that mode. In the GC-logged
  diagnostic unit every solve of that mode contained a full QV4 collection (§6). That the measured units' mode is the
  same collection is inferred from its duration; those units had no GC log.
- The p95 solve budget (0.5 ms) is met with a wide margin: 0.27–0.28 ms.
- Two anomalies are unexplained and stay open (§6, §13): a burst of slow swaps in one baseline run, and one focus
  solve in the earlier windowed evidence.
- **Found in review (§15):** the command path at n = 32 is about 0.09 ms (12 %) slower at the median than at
  `b60e618`, measured on the same workload and machine. No budget fails because of it, but its cause is not
  attributed.
- Physical presentation, real input, and the physical-session parts of T34 and T04 remain open (§8, §12).

[STATUS](STATUS.md) is unchanged by this report.

## 1. Environment

| Item | Value |
|---|---|
| Host | AMD Ryzen 5 5600X (6 cores / 12 threads), 32 GB RAM, AMD Radeon RX 9070 XT ([ENVIRONMENT](ENVIRONMENT.md)) |
| OS | Arch Linux, kernel 7.2.9-arch1-1 |
| CPU policy | governor `powersave`, EPP `balance_performance`, on every unit |
| Compositor under test | `kwin_wayland --virtual` 6.7.5 (`kwin 6.7.5-3`), OpenGL compositing (`kwin_scene_opengl` in its log), one virtual output per session, private D-Bus bus, private XDG and config dirs ([tools/nested.py](../../tools/nested.py)) |
| Libraries | Qt 6.12.0 (`qt6-base 6.12.0-2`, `qt6-declarative 6.12.0-1`), KF 6.30.0 (`kglobalaccel 6.30.0-1`), `kactivitymanagerd 6.7.5-1`, `wayland 1.26.0-1`, Mesa 26.2.4 |
| Tools | Python 3.14.8, Node 26.11.1 |
| Clients | `fixtures/client` (`plastile-fixture --ssd`, 400×300 initial size, a fresh buffer for every configure); fixture frame minimum measured from KWin: 150 px client + 28 px Breeze titlebar = 178 px |
| Clock | `CLOCK_MONOTONIC` through `tools/measure` (`Plastile.Measure`) inside KWin's QV4. `clock_getres` 1 ns; one read costs 300 ns p50 (219 ns min), calibrated in all 52 P03 units. Fixture logs and the harness use the same clock |
| Load | 1-min load average 2.2–5.2 (mean 3.0) at the start of the 83 units. A constant background load: `polkitd` ≈ 80 % of one core during the whole run, `tailscaled` ≈ 30 %, `gdm` ≈ 20 %, `systemd` ≈ 17 %, `NetworkManager` ≈ 10 %, `ksystemstats`, `dbus-broker`; sometimes `plasmashell`, a browser content process and other user processes ([g2-campaign.json](evidence/g2-campaign.json), busy processes per unit by command name). Other user processes were busy at some unit starts (below the table). **No other nested KWin ran during any unit**; the user's live session ran, untouched |

The machine was not quiet for every unit (review, §15). At each unit start, g2-campaign.json lists the four busiest processes:

- an `openclaw-gateway` process at 22–42 % of a core in 7 main units: `qualify-n32-instrumented-r1` and `-r3`, the
  frames diagnostic, and n = 2/8/16 units;
- a browser content process at 19–101 % in 7 units, among them the frames diagnostic, `qualify-n32-instrumented-r2`,
  and Polonium r0 and Plastile r2/r3 of the upstream baseline;
- a `claude` process at 20 % in 1 unit;
- an unidentified `python3` at about 100 % at the start of both churn controls.

None of these was a nested session, and none belonged to this campaign.

## 2. What was run

All of it comes from committed probes and a clean tree. Every unit recorded `implementationDirty: false`.

| Campaign | Commit | Units | Content |
|---|---|---|---|
| main | `320cf72` | 83, all rc 0, about 3 h 6 min, one seeded random order (seed 20261018) | P03 qualification at n = 2/4/8/16/32 × instrumented/uninstrumented × 5 runs; two P03 diagnostic units (GC log, frame listener); P01/P02 baselines × 5; Polonium and Plastile × 5; P05 bursts n = 8/32 × 5; the P05 n = 32 boundary; P07/P12/P13 and root teardown; P14/P15 and their no-tiler controls (superseded, below) |
| churn | `329f7d3` | 4 | P14, P14 control, P15 (20 min) + idle pairs, P15 control (20 min). They replace the main campaign's churn units, whose idle accounting summed the live threads (one ended thread made a window's wakeups negative) and recorded no RssAnon |
| gc-rate | `8d3e56a` | 4 | n = 32, GC log, 2 × instrumented and 2 × uninstrumented, interleaved |
| rss-bisect | `dadc0b1` | 4 | where P14's anonymous-memory growth comes from (§7) |
| P04 | `329f7d3` | — | `node probes/perf/pure.ts --samples 5000` (Node, informational) |

**Not run in this campaign (review, §15).**

- P03 at 64 windows (PERFORMANCE §5 lists 2–64; the task asked for 2–32).
- P00 as its own workload: P01/P02 and the no-tiler churn controls stand in for it.
- P06, P08–P11, P16 and P17. P06/P08–P11 behaviour is covered by nested scenarios (§9), not by timed workloads.

An earlier start of the main campaign at `cec0b83` was stopped after 10 units. An untracked file in `probes/` had marked
those units dirty, and P14 kept work pending at unload in only 7 of 100 cycles. That run is not used.

**Protocol (PERFORMANCE §6).**

- Each unit starts and stops its own nested KWin. Units run one at a time in a seeded shuffle across tilers (Plastile,
  no tiler, KWin's quick tile, Polonium) and workloads ([campaign.py](../../probes/perf/campaign.py)).
- In a P03 unit ([qualify.py](../../probes/perf/qualify.py)):
  - ratio, swap, master-count, focus and no-op commands run in seeded, shuffled blocks of 100.
  - Commands are 15–30 ms apart (seeded) and sent through kglobalaccel `invokeShortcut`. That is the D-Bus command API,
    not input.
  - There are 32 tiled fixtures plus 3 inactive desktops with 2 fixtures each (the §4 reference load).
- Warm-up was declared before any data: one block of 20 commands per workload per session. It is summarized
  separately and never pooled.
- Instrumented and uninstrumented runs are separate units of the same root:
  - Uninstrumented (`measureInstrumented=false`) runs the bundle exactly as production does: no clock, no
    per-command line.
  - Both modes take the same outer span: handler entry → `dispatch()` returned, after every frame request. That is
    t1 → t4.
  - The spans are buffered in memory and printed after each block.
- The measurement root is the production root plus the clock: shortcuts, the deadline Timer and the persistence
  store with the `plastile-state` helper. It has no inspector or zones hooks, and neither runs on a measured command.
- Statistics:
  - Nearest-rank quantiles. p99 is reported only from ≥ 5000 samples and withheld below that, as
    `tools/physical/summarize.py` does.
  - 95 % intervals are bootstraps over whole runs.
  - Every sample is kept.
- Per sample, the fixtures' own logs give: first and last xdg configure received, last commit answering a configure,
  and that commit's `wp_presentation` time on the virtual backend's software timeline.

Reproduce: `python3 probes/perf/campaign.py [--only FAMILY]` at the commits above, then
`python3 probes/perf/g2_aggregate.py <main> --churn-campaign <churn> --gc-campaign <gc-rate> --rss-campaign <rss> --p04 <pure.json>`.

## 3. §4 budgets

Environments:

- **nested-virtual**: this campaign.
- **nested-windowed-gpu**: the earlier kit runs, nested KWin windows on the live compositor, OpenGL on the real GPU at
  144 Hz, input injected through the nested KWin's EIS socket (libei); [runbook §1](../validation/PHYSICAL_RUNBOOK.md#1-what-was-validated-where).
- **physical**: never run.

| §4 budget | nested-virtual (KWin 6.7.5) | nested-windowed-gpu | physical |
|---|---|---|---|
| Pure solve, 32 windows, p95 ≤ 0.5 ms | **met**: p95 0.268 / 0.281 / 0.278 ms (ratio / swap / master; 5 × 1000 each, instrumented build) | not measured | not run |
| Pure solve, 32 windows, p99 ≤ 1 ms | **not met**: p99 1.071 / 1.067 / 1.064 ms, run-bootstrap CI [1.04, 1.12] / [1.06, 1.09] / [1.04, 1.10]. 3.4 / 2.1 / 2.4 % of the measured solves lie in a 0.8–1.5 ms mode (per run 1.9–3.5 %; review re-runs 0.7–4.9 %), so the p99 is inside that mode, not on its edge. In the GC-logged unit every solve of that mode held a full QV4 collection; the measured units carry no GC log, so their attribution is by duration. The collection rate of the uninstrumented build is comparable (78–90 vs 65–81 cycles per 1000 commands in GC-logged units, §5, §6). n = 16: p99 0.85 ms with 1.7–2.1 % in the same mode | not measured | not run |
| Dispatch-to-last-request, ordinary command, p95 ≤ 2 ms, p99 ≤ 4 ms | **met** at 32 windows (uninstrumented, 5 × 1000 each): ratio p95 1.585 [1.565, 1.607], p99 1.904; swap 1.361 / 1.639; master 1.477 / 1.865; focus 1.073 / 1.536 ms. Max 2.57 ms | not measured (input → present only) | not run |
| Focus-only: 0 geometry writes, 0 ordinary-layout solves | **met**: 50,000 focus commands (all n, both modes): 0 solves, 0 writes; KWin saw 0 frame changes (frames diagnostic, 1020 commands) | **one exception**: 1 solve, 0 writes in 1 of 5 focus blocks (P03-focus n = 4, block 10); cause not captured (the trace had rolled over), **open** | not run |
| Reapply unchanged plan: 0 mutations | **met**: 10,000 no-op commands (5000 `context.reset` re-solves, 5000 `layout.master-stack`): 0 writes, 0 client configures, 0 frame changes in KWin | not measured | not run |
| One geometry request per changed window | **met**: plan writes = changed windows × commands in all 30 solving cells (e.g. n = 32 ratio 160,000 / 160,000); KWin's frame changes = Plastile's writes in every run of one command family in the frames unit (250 of 250); corrections counted separately (bottom row) | not measured | not run |
| Lifecycle burst: ≤ 1 solve per affected context per flush | **met**: P05 n = 8 and 32, 5 bursts each: create solves = flushes (n = 32: 12–14 solves, 12–14 flushes), close solves < flushes; 80/80 checks. Amplification, not a violation: the 32 windows map over 206–241 ms, so each flush re-lays out a grown stack; that is 222–265 writes and 3–17 configures per window (p50 10–12) for one n = 32 burst | not measured | not run |
| Idle: no recurring Plastile timer or work | **met** within resolution: 3 pairs of 60 s loaded vs 60 s unloaded after 20 min of churn. Both 0 KWin run time (schedstat ns), 0 wakeups, 0 counter change, 0 Plastile log lines, in every 5 s slot; activity control 70–80 ms per 30 oracle scripts. That control moves the process tick counter only; no control moved the per-thread schedstat and wakeup counters. Their 0 is a reading of the kernel's counters, not checked against a known load (review, §15). No claim of exact 0 % CPU | not measured | not run |
| Post-warm-up resources: no monotonic unbounded growth | **met for counts, RSS bounded with an explanation**: P14 100 reloads with work pending in 100/100 cycles, connections 80/80, windows, kglobalaccel names 235/235, script objects 1/1, 0 dead-instance lines. RssAnon +3.1 MB (13 KiB/cycle after cycle 10, control 1.1), explained in §7 as heap warm-up with commands and window adoption that plateaus by ≈ 750 commands (8000-command run flat at 70.8–71.8 MB). Bare reloads: ≤ 0.9 KiB/cycle after cycle 10, ≤ 2.5 KiB/cycle over the second half. P15: RssAnon slope 128 KiB/min vs 168 KiB/min for the no-tiler control | not measured | not run |
| Physical input-to-first-visible vs matched baseline | not measurable (no physical output) | **pass** (5 × 1000 taps per workload, 144 Hz): P03-ratio median −2.95 ms and p95 −4.16 ms vs P02-quicktile; P03-swap −3.11 / −4.21 ms; P03-focus vs P00-switch +0.30 / +0.30 ms (interval 6.94 ms) | **not run** |
| Corrective requests for an unchanged target ≤ 2, then a diagnosed fallback | **met for P03 and P07 n = 2; not demonstrated per target elsewhere**. P03 n = 32: 11 corrections in 30,000 solving commands (both modes), and in every block corrections = `stale` classifications (E04: KWin dropped a return-to-size configure); 9 of the 11 have trace excerpts, the 4 in `instrumented-r0` (ratio block 31: 1, master block 34: 3) do not, so whether the 3 in one block hit 3 windows is not shown. P07 n = 2 back-to-back swaps: 24 corrections, 24 stale. P07 n = 4: 18 corrections but only 14 stale; the other 4 are not classified. P15 churn: 81 corrections, of which 51 follow a stale commit and 11 a deadline. The remaining 19 are attributed only by elimination, to `applyTarget` re-issuing the last requested rectangle on a re-solve. That path counts as a correction but does not check the ledger's budget. Per-target counts are not exported; the per-target bound is the ledger's `CORRECTION_BUDGET` = 2 on the correction path. G12 (a client that ignores requests) exhausts its budget once in `constraints-G08-G12` | not measured | not run |

Clock resolution is not a limit for any row. The smallest budget-relevant number, 0.27 ms, is about 900 clock reads.
No row is "inconclusive" for that reason.

## 4. P03 results (nested-virtual)

Outer span (dispatch → last request), ms, uninstrumented, pooled over 5 runs × 1000. Solve is from the instrumented
units.

| n | ratio p50 / p95 / p99 | swap | master | focus | solve p95 / p99 (ratio) |
|---|---|---|---|---|---|
| 2 | 0.248 / 0.329 / 0.890 | 0.224 / 0.293 / 0.855 | 0.229 / 0.305 / 0.854 | 1.386 / 1.917 / 2.104 | 0.067 / 0.074 |
| 4 | 0.293 / 0.393 / 0.983 | 0.248 / 0.332 / 0.894 | 0.280 / 0.375 / 0.935 | 0.967 / 1.184 / 1.674 | 0.083 / 0.095 |
| 8 | 0.387 / 0.527 / 1.097 | 0.340 / 0.492 / 1.052 | 0.364 / 0.490 / 1.103 | 0.937 / 1.125 / 1.299 | 0.110 / 0.127 |
| 16 | 0.552 / 0.799 / 1.383 | 0.426 / 0.623 / 1.252 | 0.527 / 0.752 / 1.356 | 0.930 / 1.126 / 1.359 | 0.165 / 0.858 |
| 32 | 0.868 / 1.585 / 1.904 | 0.663 / 1.361 / 1.639 | 0.832 / 1.477 / 1.865 | 0.743 / 1.073 / 1.536 | 0.268 / 1.071 |

- **Work per command** (engine counters, every measured block):
  - ratio and master: 1 solve, n writes, n observations, 0 observations during apply.
  - swap: 1 solve, 2 writes, n − 2 `skipNoop`; 1–1.6 of the 2 observations arrive inside the write (a move is applied
    synchronously), recorded as expected, without a nested solve (C06).
  - focus: 0 / 0.
  - no-op: `context.reset` 1 solve, 0 writes, n `skipNoop`; `layout.master-stack` 0 / 0.

  No command solves more than once, and none writes a window whose target did not change.
- **Focus** is dominated by KWin's activation setter (`workspace.activeWindow = w`, `activateNs`), not by Plastile.
  - Plastile's own share (outer − activate): p50 0.10 ms (n = 2) and 0.15 ms (n = 32); p95 0.13 and 0.20 ms.
  - At n = 2 the activation itself is bimodal by target window: 0.12 ms or 1.6 ms. That is why the pooled n = 2 focus
    median moves between runs, from 0.23 to 1.65 ms.
- **Where the n = 32 p95 goes:** apply (32 frame writes into KWin) p95 0.63 ms against solve 0.27 ms.
- **Client stages, n = 32 ratio** (fixture logs; the virtual backend, not scanout):
  - last request → first configure: 0.10 ms p50.
  - → last commit: 2.72 ms. The fixture fills a fresh buffer per configure, up to 1043×6070 px.
  - → virtual presentation: 25.0 ms p50, 34.8 ms p95. That is n = 2's 14 ms plus the time to render the 11.7 Mpx output.
- **Send → handler** (kglobalaccel D-Bus path, not input): 0.54–0.59 ms p50 everywhere. At n = 32 ratio and master
  its p95 is 7.4–8.3 ms and its max 31–32 ms, because KWin's thread is still busy after the previous command. It is not waiting
  for the clients: their commits had all arrived before the next send in 4164 of 4164 fast and 781 of 786 slow cases.
  It is consistent with rendering the 1920×6086 output that every command repaints (swap, which moves two windows,
  stays at 0.67 ms p95).
  - Review (§15, from the committed samples): the slow cases occur only while the previous command's frame is still
    being produced.
  - After a ratio or master command whose virtual presentation came *before* the next send, that send reached the
    handler in 0.66 ms p95, with 1 case over 2 ms in 5592.
  - When the presentation was still pending, the p95 is 8.6–9.0 ms (4638 of 14,041 cases over 2 ms).
  - This correlates the delay with KWin producing the previous frame. It is not a profile of KWin's thread.

  It lies outside the dispatch-to-last-request span and does not count against that budget. It would add to physical
  input latency on a desktop with this much repaint per command.

[g2-p03.json](evidence/g2-p03.json) holds all cells (both modes), per-run and pooled statistics, intervals, warm-up
summaries and the tails. The 223,600 raw samples are in
[g2-p03-samples.csv.xz](evidence/g2-p03-samples.csv.xz) (§8 fields; run constants once per run in
`samplesFile.runs`).

## 5. Instrumentation effect

Both modes share the outer span ([g2-p03.json](evidence/g2-p03.json) `instrumentationEffect`).

- For ratio, swap and master, instrumentation adds **0.036–0.049 ms at p50** (CI by run, e.g. n = 32 ratio +0.049
  [0.040, 0.056] ms). That cost is the runtime's own clock reads, formatting and the per-command log line. Outer − inner
  in the instrumented units is 0.039–0.050 ms p50.
- The p50 difference does not hold for focus or no-op:
  - n = 2 focus is bimodal (§4): −1.10 ms, CI [−1.32, +1.26].
  - The no-op p50 falls between its two commands: +0.03 to +0.24 ms.
- **At p95 the difference is noisy** (corrected in review, §15):
  - From +0.05 to +0.21 ms for solving commands; the largest is n = 16 ratio, +0.208 [0.098, 0.389]; n = 32 ratio is
    +0.139.
  - n = 32 swap is −0.26 ms: the instrumented runs were *faster* at p95, CI [−0.33, +0.07].
  - Run-to-run variation at p95 is therefore as large as the observer effect.
- The solve budget can only be measured instrumented. Its tail is not an observer artifact. In GC-logged n = 32 units
  the uninstrumented build ran 78 and 90 collections per 1000 commands and the instrumented build 65, 76 and 81, so the
  rates are comparable. With 2–3 units per mode, "at least as often" is not established
  ([g2-p03.json](evidence/g2-p03.json) `gcRate`).

## 6. Tails: the slowest samples explained

The GC diagnostic unit (n = 32, instrumented, `QT_LOGGING_RULES=qt.qml.gc.*=true`, never pooled) logs every
incremental-GC step of KWin's process with its duration. Since the perf line is printed at the end of a handler, a
step logged between two perf lines, at or after the command's entry, ran inside that command
([g2-p03.json](evidence/g2-p03.json) `gcAttribution`).

- **All of the slowest 1 % of commands, and 2.6 % of the rest, had a complete GC cycle inside the handler:** 14 steps
  totalling 0.80 ms p50, 0.97 ms p95, 1.23 ms max.
  - Median command with a cycle inside: 2.02 ms. Without: 0.83 ms.
  - All ten slowest (2.48–2.80 ms) are such commands: ratio, swap and master (none is a focus command).
- The cycle lands in the solve span 32 times, in apply 31 times, and elsewhere in the handler 90 times, out of 4300
  commands: 1.01 % of *that unit's* solves hold a cycle. Its own solve p99 is 0.30 ms for ratio and 0.32 ms for master,
  under budget.
- **Corrected in review (§15):** the 1.01 % does not carry over to the measured units.
  - There, solve spans are bimodal: 0.1–0.4 ms, plus a separate mode at 0.8–1.5 ms. With GC logging the mode is
    1.2–2.0 ms, because logging every step makes the cycle slower.
  - The mode holds 3.4 / 2.1 / 2.4 % of n = 32 ratio / swap / master solves (per run 1.9–3.5 %), 1.7–2.1 % at n = 16,
    0.9 % at n = 8 and 0.3–0.7 % at n ≤ 4.
  - So the n = 32 p99 sits well inside the mode, and so does the n = 16 p99 (0.85 ms). At n ≤ 8 the p99 stays at
    0.07–0.14 ms because fewer than 1 % of solves are in the mode.
  - The GC log perturbs both the share of cycles that land in a solve and their cost. Attributing the measured
    units' mode to GC therefore rests on its duration matching one collection. Those units have no GC log.
- The slowest uninstrumented samples (n = 32: 2.57, 2.45, 2.31 ms) match "p95 + one cycle". This is an inference: those
  units have no GC log.
- **First command of a block** (corrected in review):
  - It is slower at the median: +0.09 to +0.14 ms for ratio, swap and master, 50 samples per cell. Each block is preceded
    by a dump of the outer spans and a counters query.
  - It does not drive the tail: 0–2 of the 51 top-1 % samples per cell are first-of-block.
- **Is it a Plastile defect?** No defect was identified. The collector runs because the shared declarative engine
  allocates: the engine's per-command objects, trace records and frame rectangles. The cycle's cost is QV4's.
  - The p99 misses the budget by 6–7 %, but it sits inside a mode that holds 2–3 % of solves. Meeting the budget
    therefore means removing more than half of the collections that land in a solve, or making each one cheaper; a
    small speed-up of the solve does not do it. PERFORMANCE §7 puts allocation work after the attribution done here.
  - The next step for the solve budget is an allocation profile of `solveAndApply` and the adapter's frame writes. It
    was not attempted in this gate, and `src/` was not changed.
- **Polonium vs Plastile samples:** one Plastile run (r1) of the upstream baseline has a run of 15 consecutive swaps at
  8–11 ms send → configure, about 2 s into its first phase.
  - That probe has no handler timing. KWin's log shows nothing in that interval, and Plastile's counters show no extra
    solve, write or correction.
  - The pooled Plastile swap@25ms p99 is 2.15 ms (CI [1.95, 3.47]) and its max 11.0 ms.
  - **Unexplained, left open.** It is the only such burst in the 11,000 Plastile and 11,000 Polonium baseline commands.

## 7. Resource tracking (P14, P15) and the RSS bisection

All from [g2-churn.json](evidence/g2-churn.json).

**P14:** 100 reload cycles, 4 fixtures, one of them answering configures 200 ms late. Each cycle:

- a ratio command before unload, with work pending at 100 of 100 unloads (max 4 outstanding);
- two pokes at the destroyed actions;
- one window open and close.

Results:

| Measure | Result |
|---|---|
| Connections | 80 in every cycle |
| Windows | constant |
| kglobalaccel names | 235 = 235 |
| KWin script objects | 1 |
| Dead-instance lines | 0 |
| Errors, warnings, exceptions | 0 |
| Final layout | valid |
| Total RSS | +6.3 MB (control: +4.4 MB) |
| RssAnon | +3.1 MB (68.8 → 71.9 MB); regression slope after cycle 10: 13 KiB/cycle (control: 1.1 KiB/cycle) |

**Bisection** ([rss_bisect.py](../../probes/perf/rss_bisect.py), one nested session per variant):

- Bare reloads, slope after cycle 10, without / with 15 oracle scripts per cycle: production root +0.13 / +0.85 KiB per
  cycle, empty script +0.06 / +0.13, shortcuts only −0.06 / −0.39, runtime only +0.46 / +0.13, runtime with persistence
  −0.05 / −0.64. Over the second half of the 100 cycles the slopes are larger: up to +1.0 / +2.5 KiB per cycle
  for the production root and +1.7 / +1.7 for shortcuts only.
- P14-shaped cycles of the production root, one part at a time:
  - a ratio command per cycle grows the heap by 8–11 KiB per cycle, with or without the reload (`cmd+noreload` 11.1);
  - a window open and close per cycle: 9.5 KiB per cycle at first, then −2.7 in the second half;
  - counters and settle alone: −0.7; all parts together: 11.5;
  - without the persistence helper: 3.0, then −9.7 (noisy).
- **8000 ratio commands in one session:** RssAnon rises from 68.6 to 71.3 MB over the first 750 commands, then stays at
  70.8–71.8 MB to the end. Without the helper: 68.0 → 71.4 MB, then flat. The same holds in both.

The P14 growth is therefore the heap warming up with commands and window adoption. P14 issues only 100 commands and
100 adoptions in total, and the heap plateaus after about 750 commands. Reload alone grows the heap by at most 2.5 KiB per cycle in any half of the run. P14 grows 13 KiB per cycle, so reload
is not the source of that growth. A residual below about 2.5 KiB per cycle cannot be ruled out. Result:
[g2-rss-bisect.json](evidence/g2-rss-bisect.json).

**P15:** 20 minutes of seeded churn (seed 7), 4254 operations: open 555, close 550, minimize 529, unminimize 530,
toggle-float 506, swap 546, ratio 527, layout.next 511. 2–8 windows, clients with 0/120/300 ms configure delays.

- 0 errors and 0 outstanding requests at the end.
- Model windows equal the oracle's windows.
- 81 corrections: 51 after a stale commit, 11 after a deadline, 19 re-issued settled targets after a drift.
- Total RSS follows the windows' number and size. Plastile tiles them large, so their client buffers are large; the
  no-tiler control keeps them at 400×300.
- RssAnon after 2 minutes: slope 128 KiB/min, spread 3.4 MB. No-tiler control: 168 KiB/min, spread 3.5 MB.

**Idle (C14):** three pairs of 60 s loaded vs 60 s unloaded, after the churn.

- Counters, Plastile log lines, KWin schedstat run time and voluntary context switches of every live KWin thread were 0
  in both states, in every 5 s slot.
- Seven pool threads ended during the first loaded minute. They are leftovers of the churn, seen in the thread count;
  the process-level CPU ticks stayed 0.
- The sensitivity control (30 oracle scripts) reads 70–80 ms, so the counters are live.

## 8. Baselines (T04, nested-virtual)

All from [g2-baselines.json](evidence/g2-baselines.json), raw samples in
[g2-baselines-samples.csv.xz](evidence/g2-baselines-samples.csv.xz).

**No tiler, P01/P02.** `probes/timing`: one placement per activation, 5 runs × 1000 samples per workload.

| Workload | send → handler | write | → configure | → commit | → observed | → virtual present |
|---|---|---|---|---|---|---|
| P01 resize | 0.588 | 0.011 | 0.096 | 0.178 | 0.332 | 9.79 (p95 17.2) |
| P01 move | 0.583 | 0.118 | — (no configure) | — | 0.080 | — |
| P02 quick tile | 0.597 | 0.082 | 0.169 | 0.335 | 0.480 | 12.6 (p95 20.7) |

Values are p50 in ms.

- P02 quick tile p95 → observed is 1.07 ms.
- Plastile's command path at n = 2 compares like this: send → handler 0.54 ms, dispatch → last request 0.25 ms,
  request → first configure 0.042 ms.

**Upstream automatic tiler: Polonium 1.2.2 vs Plastile.** The package is pinned and verified as in
[baseline-upstream](../../probes/baseline-upstream/README.md), installed only into each session's private data home.
`kactivitymanagerd` ran on the private bus for both tilers. Setup: 3 windows, 5 runs per tiler, 1000 commands per phase
at 25 ms spacing (5000 pooled, p99 reported) and 100 at 250 ms. The metric is send → first fixture configure, in ms.

| Tiler | swap@25 p50 / p95 / p99 | resize@25 p50 / p95 / p99 | configures/command | fights |
|---|---|---|---|---|
| Polonium | 11.31 / 12.49 / 13.06 | 0.607 / 0.720 / 0.833 | 3 | 0 |
| Plastile | 0.826 / 1.062 / 2.148 | 0.851 / 1.018 / 2.162 | 2 (swap), 3 (resize) | 0 |

- Polonium's swap waits for its 10 ms `RebuildDelay` (attributed in the earlier evidence).
- Its resize is a synchronous `resizeByPixels` in the handler, **0.24 ms faster at p50 than Plastile's
  solve-and-apply**.
- The layouts differ (Polonium BTree with 4 px gaps, Plastile master/stack with 8 px), so this is not a layout-identical
  comparison.
- Both tilers: 0 oracle errors, teardown complete.

**No-tiler controls for resources.** P14 control (the empty script, same window churn) and P15 control (the same seeded
operation sequence with the empty script) are in §7. The unloaded halves of the idle pairs are the idle baseline.

**Physical-only latency.** Earlier windowed real-GPU runs, label `nested-windowed-gpu`
([evidence](evidence/latency-windowed-gpu-20261018T042052.json), commit `73947ed`). Input is libei taps through the
nested KWin's EIS socket, presentation is the nested KWin's own timeline at 144 Hz, 4 windows, 5 runs × 1000 per
workload. Median input → first present:

| Workload | Median | Baseline | Baseline median |
|---|---|---|---|
| P03-ratio | 10.27 ms | P02-quicktile | 13.22 ms |
| P03-swap | 10.11 ms | P02-quicktile | 13.22 ms |
| P03-focus | 14.03 ms | P00-switch | 13.72 ms |

Every comparison is `pass` by the §4 rule. Default chords on the real keymap through libei: 19/19
([evidence](evidence/keys-windowed-gpu-20261018T041604.json)). This is not scanout and not kernel input.

## 9. Mandatory scenarios and CI

The latest full nested suite is [integration-host-52314ed.json](evidence/integration-host-52314ed.json): KWin 6.7.5,
`52314ed`, clean tree.

- **127 scenarios, 0 failed, 1 expected SKIP** (`output-negative-origin-G02`: KWin normalizes output origins), **1759 of
  1759 checks**.
- No `src/` change was made in this G2 run, so that result stands for the code measured here.

CI ([CI.md](CI.md), [STATUS](STATUS.md)):

- Ubuntu 26.10 sandbox, KWin 6.7.5: 811 of 811 checks, 88 of 88 scenarios at `a434b29` (run 39114760401).
- KWin 6.8.0 Nix job: provisional at 779/782, for the `reload-Q09` RSS bound. That growth was measured as KWin 6.8's own
  ([q09-kwin68-control.json](evidence/q09-kwin68-control.json)).

By G2 acceptance item (ROADMAP §6) and test-matrix row:

| G2 item | Test-matrix rows | Nested scenarios (all pass at `52314ed`) | Unit/replay only |
|---|---|---|---|
| Delayed and out-of-order observations | G04, G06, C07, L09 | clients that answer configures late: `ratio-reversal-G05` (300 ms), `remove-during-apply-C07`, `unplug-O04`, `send-stale-close-T24`, `send-activity-switch-T24` (400 ms), `reload-Q09` (200 ms), `replay-capture-T10`; this campaign's P14 and P15 (0/120/300 ms) | G04 "peers proceed", G06 "old target after newer: no rollback" (`engine.test.ts`) |
| Rapid reversal | G05, I05 | `ratio-reversal-G05`, `resize-rapid-keys-I05`; this campaign's P03 n = 32 and P07 (E04 corrections, bounded) | G05/G06 replay, ledger E04 replay |
| No infinite correction loop, bounded corrections | G11, G12 | `app-resize-G11`, `constraints-G08-G12`, `late-min-size-D3`, `max-size-G09`, `fixed-size-G07` | — |
| No stale-ID writes | C02, C03, C04, C07 | `create-remove-C04` (cases A–C), `remove-during-apply-C07`, `send-stale-close-T24`, `drag-output-removal-I04` | C02/C03 generations |
| No window trapped invisible | O04, O06, L09–L12 | `unplug-O04`, `replug-identity-O05`, `states-L09-L12`, `scrolling-pullback-M8` | O06 invalid area |
| No shell helper adopted | — | `classify-tiny-helper-T16`, `classify-builtin-T16`, `plasmashell-panels-O07`, `workarea-*-O07` | — |
| One slow window does not delay peers | G04 | `remove-during-apply-C07` (peers applied while three clients answer 400 ms late), `reload-Q09`; P15 (mixed delays, 0 outstanding at the end) | G04 (`engine.test.ts`) |
| Negative tests throw inside callbacks | C08 | — (no nested scenario injects an exception into KWin's callbacks) | C08 ×2 (`engine.test.ts`: apply, one context's solve) |
| No-op, focus, idle | C11, C12, C14 | `noop-and-focus-C11-C12`, `suspend-idle-C14`; this campaign (§3) | — |

Rows with no nested scenario are G13 (position-only vs resize attribution; covered by P01's move/resize split in §8),
G14 (decoration change; covered indirectly by the real-app scenarios), G15 (physical hit regions) and O09 (activity
change with native root projection; the native backend was not chosen, ADR-003). C08 has replay coverage only.

## 10. Teardown

- All 52 P03 units: unloaded, `isScriptLoaded` false, 0 error/warning/exception lines. kglobalaccel keeps the 68 action
  names after unload, as measured before (API_PROFILE lifetime facts).
- Measurement root: its `Options.configChanged` marker fires once per reconfigure while loaded and never after unload
  (3 cycles, `workloads` teardown check).
- P14: as in §7.
- Both upstream tilers unloaded cleanly in all 10 runs.
- The persistence helper and `kactivitymanagerd` were terminated by the PIDs the harness started.
- After every campaign no nested `kwin_wayland` or private `dbus-daemon` was left running.

## 11. Remaining API gaps

These are script-visible limits that bound what can be measured or controlled from a KWin script on 6.7.5.

- No presentation feedback for scripts. A script cannot see when its geometry reached a frame, so t8 needs client or
  physical instrumentation.
- No configure count or serial for scripts. Configures are counted only by the controlled fixture (the PERFORMANCE §8
  `configureCount` field).
- KWin drops a configure that returns to the committed size while another is outstanding (E04). The script cannot see
  this, so the ledger needs its bounded stale correction (§3).
- `minSize`/`maxSize` have no NOTIFY signal. `WM_NORMAL_HINTS` changes emit nothing script-visible unless allowed
  actions flip. XWayland increments and aspect are invisible ([API_PROFILE](API_PROFILE.md)).
- The garbage collector of the shared declarative engine is neither observable (only through Qt logging) nor
  schedulable from a script. Its cycles run inside handlers (§6).
- A package installed after KWin started is found by `Scripting.start()` only about 20 s later (`package-install.json`).

## 12. What only a physical session can answer

- Input-to-first-visible and input-to-settled with real input devices and scanout (runbook P6). The windowed GPU numbers
  in §8 are the closest nested proxy and are labelled as such.
- Real monitors, mixed refresh (60/100/144 Hz on this machine), VRR, fractional scale on real outputs, cable unplug,
  suspend/resume.
- The user's own panels, activities, keymap, applications and effects. That covers whether the n = 32 repaint cost
  seen in §4 (send → handler p95 8 ms on an 11.7 Mpx virtual output) appears at real sizes.
- Long-session soak in the user's session (runbook P8).

The physical gate G3 stays open. Its consent points are in the [runbook](../validation/PHYSICAL_RUNBOOK.md).

## 13. Defects, fixes and the wip/perf-g2 branch

| Item | Kind | Disposition |
|---|---|---|
| `f5dc18e` P05/P03 output height without the gaps | probe | taken; re-verified on this host: the exact boundary holds (5774 px tiles all 32 windows, 5773 px floats only the newest; `P05-boundary-n32` in [g2-lifecycle.json](evidence/g2-lifecycle.json)). The 186 px frame minimum it assumes came from the sandbox's 36 px titlebar; here it is 178 px, and the measured feasibility check reports either |
| `e541963` instrumentation-off root mode, P15 no-tiler control, `pure.ts`, `measure_env` | probe | taken unchanged; `pure.ts` type error fixed in the next commit |
| `e541963` `tools/sandbox/nix/measure.nix` | tooling | dropped: it cannot be built on this host (no Nix) and named a `qualify.py` that did not exist |
| P14 kept work pending only until the persisted ratio hit its limit (7 of 100 cycles) | probe | fixed (alternating commands; 100/100) |
| Idle accounting summed live threads; one ended thread gave negative wakeups | probe | fixed (per-thread snapshots) |
| `baseline-upstream/run.py` read `.git/HEAD`, which fails in a linked worktree | probe | fixed |
| P05 n = 32 overlap (HANDOFF §6) | not a defect | infeasible workload in the sandbox's decoration; engine exact at the boundary |
| Solve p99 1.07 ms at n = 32 | budget miss | attributed to QV4 GC (§6); no `src/` change |
| Upstream baseline Plastile run r1: 15 swaps at 8–11 ms | unexplained | open (§6) |
| Windowed GPU focus block with 1 solve | unexplained (earlier evidence) | open; not reproducible here (0 solves in 50,000 nested-virtual focus commands), and windowed sessions were out of scope for this run |
| Command path at n = 32 slower than at `b60e618` (+0.09 ms p50 ratio, +0.07–0.08 ms swap; review §15) | slowdown, within budget | open: not bisected over the 74 `src/` commits since then; the measurement root also gained the persistence store |

No `src/` defect was found, so `src/` is unchanged.

## 14. Data

Committed (7.4 MB with the review files, redacted: no window titles, no user paths):

- [g2-campaign.json](evidence/g2-campaign.json): provenance, unit order, machine state per unit.
- [g2-p03.json](evidence/g2-p03.json) with [g2-p03-samples.csv.xz](evidence/g2-p03-samples.csv.xz) (223,600 rows).
- [g2-baselines.json](evidence/g2-baselines.json) with [g2-baselines-samples.csv.xz](evidence/g2-baselines-samples.csv.xz).
- [g2-lifecycle.json](evidence/g2-lifecycle.json), [g2-churn.json](evidence/g2-churn.json),
  [g2-rss-bisect.json](evidence/g2-rss-bisect.json).
- [g2-review.json](evidence/g2-review.json) with [g2-review-reruns.csv.xz](evidence/g2-review-reruns.csv.xz) (21,500 rows):
  the review of §15, from [g2_review.py](../../probes/perf/g2_review.py).
- [g2-p04-node.json](evidence/g2-p04-node.json): Node P04, informational. It records no commit or tree state. The
  review re-ran it from a clean tree at `96a6857`, with the same `src/` and `pure.ts`, and got p50s within
  7 % of the committed ones (`g2-review.json` `p04Rerun`). At 250 synthetic windows, 0.15 ms p50 per
  ratio command in V8 with a mock host; open bursts solve once per flush.

Not committed, because they held window titles, absolute paths and KWin logs of each session (about 2 GB, gitignored
`artifacts/g2/`): fixture JSONL logs (`start` records carry argv), the GC and frame diagnostic logs, per-cycle P14/P15
records, and the aborted `cec0b83` campaign. **These raw logs no longer exist:** they lived in the measuring agent's
worktree and were deleted with it on 2026-10-18, after the review. The committed raw samples above (§8 schema) still
reproduce every percentile in this report (the review recomputed all 50 pooled P03 cells from them with no mismatch),
but `g2_aggregate.py` can no longer regenerate the committed summaries from the session logs, and the diagnostic
analyses (GC log, frame listener, per-cycle churn) can only be repeated by running the probes again.

## 15. Adversarial review (nested-virtual, KWin 6.7.5)

This review ran on branch `wf/g2-review`, from `96a6857` (re-runs) and `88e9cd8` (analysis), on the same host the same
day (load 3.0–5.4; the busy user processes are recorded per unit). It is still nested and not physical. The evidence is
[g2-review.json](evidence/g2-review.json) and [g2-review-reruns.csv.xz](evidence/g2-review-reruns.csv.xz), produced by
[g2_review.py](../../probes/perf/g2_review.py). That script is a second implementation: its own CSV reader,
nearest-rank quantile and run bootstrap.

**Recompute.** All 50 pooled P03 cells were recomputed from the raw samples: outer span p50/p95/p99/max, solve span
where instrumented, and sample counts. They match g2-p03.json with **0 mismatches**. The checks:

- p99 comes only from cells with ≥ 5000 samples; the no-op cells (1000) have none.
- Warm-up (100 per cell) is never pooled. Its maximum is below the measured maximum in 9 of the 10 n = 32 cells;
  instrumented focus is the exception, at 2.16 against 2.14 ms. Pooling it would change no budget verdict.
- No sample has `success` false.
- Instrumented and uninstrumented units are never pooled together.
- Every published unit records `implementationDirty: false`.
- The n = 32 run-bootstrap intervals reproduce: ratio outer p95 [1.565, 1.607] ms.

**Reproducibility.** `qualify.py --n 32 --run 0 --seed 20261018`, the same command sequence as the campaign's r0, re-run
in a fresh nested session. Values are p50 / p95 in ms; the campaign column is its five runs' range.

| Cell | Re-run | Campaign r0–r4 |
|---|---|---|
| uninstrumented ratio | 0.866 / 1.598 | 0.865–0.879 / 1.549–1.612 |
| uninstrumented swap | 0.669 / 1.291 | 0.658–0.665 / 1.032–1.394 |
| uninstrumented master | 0.836 / 1.507 | 0.826–0.838 / 1.273–1.532 |
| uninstrumented focus | 0.703 / 0.958 | 0.691–0.883 / 0.865–1.144 |
| instrumented ratio solve | p99 1.066, 3.8 % of solves in the slow mode | pooled p99 1.071 |

**Corrections made to this report:**

| Was | Data says | Where |
|---|---|---|
| "1.01 % of solves hold a cycle, which places the n = 32 p99 exactly on the collection"; "missed by 6–7 %" | 1.01 % holds only in the GC-logged unit, whose own solve p99 is 0.30 ms. In the measured units 2.1–3.4 % of n = 32 solves (per run 1.9–3.5 %; review re-runs 0.7–4.9 %) lie in a 0.8–1.5 ms mode, so the p99 is deep inside it. Logging GC slows each cycle (mode 1.2–2.0 ms) and changes how often one lands in a solve | §3, §6, verdict |
| Instrumentation adds "up to +0.14 ms at p95 (n = 32 ratio)" | up to +0.21 ms (n = 16 ratio, CI [0.10, 0.39]); n = 32 swap is −0.26 ms (instrumented faster); the 0.04–0.05 ms p50 holds for solving commands only | §5 |
| Uninstrumented "collects at least as often (84 vs 74)" | per unit 78/90 vs 65/76/81: comparable, not ordered | §3, §5 |
| "All ten slowest … across ratio, swap, master and focus" | none of the ten is a focus command | §6 |
| "No first-of-block effect" | first-of-block commands are +0.09–0.14 ms slower at p50 (50 per cell), but 0–2 of 51 top-1 % samples are first-of-block | §6 |
| Send → handler slowness "an inference" only | slow sends (> 2 ms) occur when the previous command's frame is not yet presented: after ratio/master, 1 of 5592 sends when it was presented, 4638 of 14,041 when not (p95 0.66 vs 8.6–9.0 ms). Still a correlation, not a profile of KWin's thread | §4 |
| Corrections: "in P03 and P07 every correction follows a stale" | P07 n = 4 has 18 corrections and 14 stale; 4 P03 corrections (`instrumented-r0`) have no trace excerpt; P15's 19 are attributed by elimination | §3 |
| Bare reloads "≤ 0.9 KiB/cycle", "reload leaks no measurable memory" | ≤ 0.9 after cycle 10, but up to 2.5 KiB/cycle over the second half | §3, §7 |
| Idle "0 wakeups" | the sensitivity control moves the process tick counter only; the per-thread schedstat and wakeup counters were never checked against a known load | §3 |
| Load "other user processes" | `openclaw-gateway` (22–42 %) in 7 units, a browser content process (19–101 %) in 7, `claude` in 1, an unidentified `python3` (~100 %) at both churn controls | §1 |
| P05 counted only solves per flush | it also amplifies: 222–265 writes and up to 17 configures per window for one n = 32 burst (windows map over 206–241 ms, every flush re-lays out the grown stack) | §3 |
| Not mentioned | P03 at 64 windows, P06, P08–P11, P16 and P17 were not run; g2-p04-node.json records no commit | §2, §14 |

**Inactive contexts are not a cost.** n = 32, instrumented, interleaved A/B, 2 runs each:

| | 3 inactive desktops | 0 inactive desktops |
|---|---|---|
| ratio outer p50 | 0.902–0.927 | 0.896–0.915 |
| ratio solve p50 | 0.170–0.174 | 0.169–0.172 |

The difference is within run-to-run spread (PERFORMANCE §7 "latency grows with inactive desktops": not observed).

**Comparison with the earlier P03 evidence** ([perf-p03-nested.json](evidence/perf-p03-nested.json), `b60e618`, 300
samples, recorded 2026-10-17). It reported n = 32 ratio dispatch → return p50 0.678 ms and solve p95 0.208 ms. G2's
instrumented inner span is about 0.87 ms. The review ran `b60e618`'s own workload (`probes/perf/run.py`: 300 ratio,
then 300 swap, then 300 focus, no inactive desktops), alternating between the `b60e618` tree and this one, 3 runs each,
instrumented:

| n = 32, p50 ms | `b60e618` tree | this tree (`96a6857`) | difference |
|---|---|---|---|
| ratio dispatch → return | 0.759–0.770 | 0.848–0.859 | +0.09 (+12 %) |
| swap dispatch → return | 0.538–0.574 | 0.624–0.652 | +0.07–0.08 |
| ratio solve | 0.157–0.159 | 0.168–0.171 | +0.01 |
| n = 2 ratio dispatch → return | 0.210–0.218 | 0.227–0.240 | +0.02 |

So the 0.68 → 0.87 ms difference has two parts:

- **About 0.09 ms is the machine today.** The `b60e618` tree measured 0.68 then and 0.76 now.
- **About 0.09 ms is this tree.** The difference covers 74 `src/` commits (bundle 134 → 314 KB) and the measurement
  root's persistence store. It is mostly outside the solve span.

No budget fails because of it, but it is a slowdown nobody has attributed, and it is listed as open in §13. This A/B
has 300 samples per cell, so it gives medians only, not p99.

**Verdicts after review.**

- Unchanged: dispatch-to-last-request met; pure solve p95 met; pure solve p99 **not met**; the focus, no-op,
  one-request, lifecycle, idle and resource gates met as qualified above.
- The correction budget is narrowed to "met for P03 and P07 n = 2; not demonstrated per target elsewhere".
- No number in this report is physical, and the Node P04 numbers say nothing about QV4.

