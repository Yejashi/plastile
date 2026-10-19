# Performance and snappiness validation

## 1. Evidence status

No runtime performance experiment was executed during the planning research. Every numerical budget in this document is a **proposed engineering acceptance target**, not a claim about Plastile or an upstream project. M0/M1 must calibrate the reference machine and measurement resolution. Record an explicit revision if targets change; do not relax them silently after a failure. Nested measurements against these budgets (the G2 gate, nested only) are in the [G2 report](../status/G2_REPORT.md); the budgets themselves are unchanged.

The objective is low, stable input-to-visible-response latency while preserving correctness. Report engine time, scheduling delay, request/observation latency, frame pacing, and resource use separately. A fast solver cannot compensate for a fixed settle delay or repeated client resize requests.

## 2. Clock and event definitions

| Symbol | Event | Measurement requirements |
|---|---|---|
| `t0_input` | Physical/injected input event timestamp | Record source and clock; distinguish hardware input from invoking a command API |
| `t1_dispatch` | Plastile handler/command entry | Monotonic clock or calibrated conversion |
| `t2_model` | Model/event reduction complete | Same clock/domain as dispatch |
| `t3_solve` | Pure solve complete | Separate solver span; no UI/export work |
| `t4_request` | Last required placement request issued for transaction | Include earlier first-request timestamp for responsiveness analysis |
| `t5_configure` | Actual protocol configure, if observable | KWin/client instrumentation; property write count is not configure count |
| `t6_observed` | Required observed frame/target state reached | Window geometry observation; not presentation |
| `t7_commit` | Client's matching buffer/state committed | Controlled client/protocol instrumentation; correlate correctly |
| `t8_present` | First relevant output presentation feedback | Actual output/frame marker; identify physical versus nested |
| `t9_settled` | All relevant windows/presentation reach final state | Define tolerance and animation state; slowest client may dominate |

Not every environment can observe every timestamp. Mark missing values null with a reason. Do not synthesize `t8_present` from `frameGeometryChanged`, a screenshot polling time, or an application's completion log.

`Date.now()` is a wall clock with coarse resolution and possible adjustments. It is insufficient to establish sub-millisecond tail latency. Use a monotonic native harness/probe, profiler, or calibrated instrumentation. Pure Node microbenchmarks inform algorithm work but do not measure Qt's QV4 engine or Qt-object crossings. QML Timer intervals are not timestamp resolution or dispatch guarantees.

When correlating kernel/input, compositor, client, and presentation clocks, document clock domains and the conversion/error bounds. Protocol serials identify protocol state; Plastile request sequences identify policy intent. They are not interchangeable.

## 3. Metrics

Compute:

- Dispatch delay: `t1_dispatch - t0_input`.
- Model cost: `t2_model - t1_dispatch`.
- Solver cost: `t3_solve - t2_model`.
- Adapter/apply cost: `t4_request - t3_solve`.
- Command-to-request: `t4_request - t1_dispatch`.
- Request-to-observed: `t6_observed - t4_request` where attribution is valid.
- Input-to-first-visible: first relevant presented change minus `t0_input`.
- Input-to-settled: `t9_settled - t0_input`.
- Missed/late presentation intervals and consecutive outlier bursts.
- Solves, geometry/property writes, native mutations, observed signals, corrective writes, and actual configures per logical operation.
- Idle wakeups/CPU, active CPU, allocation/GC evidence, live record/connection/timer/overlay counts, and memory after warmup.

For multi-window operations, report first-response and all-window-settled separately. For animation, report command acknowledgement, first visual response, and final settle separately. Default disabled animation is the initial comparison mode.

## 4. Proposed budgets

Reference load: 32 ordinary controlled windows in one affected context, multiple inactive contexts present, no debug formatting or visual effects added by Plastile. Measure on a documented reference machine; lower-end hardware may need a published separate profile.

| Metric | Initial target | Interpretation |
|---|---|---|
| Pure solve in actual runtime, 32 windows | p95 ≤ 0.5 ms; p99 ≤ 1 ms | Requires an adequate clock; not a Node-only pass |
| Dispatch-to-last-request, ordinary command | p95 ≤ 2 ms; p99 ≤ 4 ms | Excludes client redraw and physical scanout, includes model/solve/adapter |
| Focus-only command | Zero geometry writes and zero ordinary-layout solves | Functional/counter gate regardless of clock |
| Reapply unchanged valid plan | Zero geometry/property/native mutations | No-op gate |
| Ordinary successful target change | One geometry request per changed window | Corrective exceptions counted separately and explained |
| Lifecycle burst | At most one solve per affected context per flush | Allow later independent events/required reconciliation, with reasons |
| Idle operation | No recurring Plastile timer or periodic work | Measure incremental CPU/wakeups against baseline; do not claim exact 0% |
| Post-warmup resource counts | No monotonic unbounded growth across churn/reload | Use live counts and heap trend, not one RSS snapshot |
| Physical input-to-first-visible | No additional full frame interval at median; p95 within one output interval of matched native/direct baseline | Relative target; report actual values and noise |
| Corrective requests for unchanged target | At most two after initial request, then diagnosed fallback | Default policy proposal; no infinite retry |

These are initial gates, not cross-hardware guarantees. A result close to a timer/clock resolution limit must be marked inconclusive. If ordinary commands exceed the target, attribute time before changing language or reducing features.

At 60/120/144/240 Hz, one nominal refresh interval is about 16.67/8.33/6.94/4.17 ms. These arithmetic values are not measured frame pacing, especially with VRR. Use actual presentation feedback when available.

## 5. Workload suite

| ID | Workload | Purpose |
|---|---|---|
| P00 | No tiler; same fixtures/effects | Base compositor/client overhead |
| P01 | Direct one-window placement; position-only and resize separately | Minimal adapter/control path |
| P02 | Native quick tile; same target/action | Native integration control |
| P03 | 2/4/8/16/32/64 windows; ratio/swap/focus/layout commands | Typical scaling and no-op behavior |
| P04 | 100/250 synthetic windows in pure core/replay only | Stress algorithm and queue scaling; not a desktop usability claim |
| P05 | Burst create then close, including create/remove in one turn | Event coalescing and cancellation |
| P06 | Rapid A→B→A resize with delayed client commit | Request/observation correctness and tail |
| P07 | Repeated key commands at realistic and overload rates | Queue ordering, latency under pressure |
| P08 | Live shared resize and drag/release | Frame-coalesced work and user ownership |
| P09 | Fullscreen/maximize/minimize/restore combinations | State transitions without force loops |
| P10 | Mixed constraints, fixed-size dialog, XWayland increment behavior | Constraint convergence and exceptions |
| P11 | Output transfer, unplug/replug, scale/work-area changes | Topology convergence; separate from ordinary key latency |
| P12 | Multiple desktops/activities/outputs; only one dirty context | Isolation from inactive work |
| P13 | Config activation with 10/100/1000 exact/glob rules | Compile/activation cost and cached hot path |
| P14 | 100 reload cycles with windows and pending callbacks | Lifetime leaks and duplicate engine work |
| P15 | Long mixed churn session and idle interval | Memory/wakeups and retained-state growth |
| P16 | Later scrolling with visible/off-screen columns | Compare only with a scrolling baseline |
| P17 | Later zone keyboard command with overlay hidden/shown | UI independence and active-only polling |

Define the same initial window order, geometries, targets, constraints, and activation for every comparable implementation. A master/stack swap is not equivalent to placing one active window in a zone; report those controls separately.

### 5.1 Focus activation cost depends on the decoration and window size

Finding from the physical P6 run (2026-10-18, KWin 6.7.5, installed build `97fec4a`), investigated in nested KWin on 2026-10-19 ([evidence](../status/evidence/focus-latency-nested-20261019.json), probe [`probes/perf/focus/run.py`](../../probes/perf/focus/run.py)).

**The physical result.** Input to the activation configure took 9.9 ms median (p95 11.3) for P03-focus at 144 Hz and 6.4 ms (p95 7.9) at 60 Hz, against 3.05 ms and 2.85 ms for P00-switch (KWin's *Switch to Window to the Right*, no tiler). Swap and ratio, through the same kglobalaccel → `ShortcutHandler` path, reached their configure in 0.6 ms, and the focus blocks issued 0 solves and 0 writes.

**Cause of most of the gap: not Plastile's code** (a residual at equal area is still open, below). The reference desktop decorates windows with Aurorae v2 and an SVG theme. On every change of a window's active state, Aurorae v2 re-renders that window's whole decorated frame synchronously, into a new `QImage` the size of the frame (observed source: aurorae v6.7.5 `v2/decoration.cpp`; `onWindowActiveChanged` → `updateDecoration` → `setCurrentDecoration` → `updateShadow` paints the theme's `FrameSvg` into the image). KWin forwards `Window::activeChanged` to the decoration synchronously, and the xdg configure goes out later, from a 0 ms timer that the activation starts (observed source: kwin v6.7.5 `src/window.cpp` `Window::setActive`, `src/decorations/decoratedwindow.cpp`, `src/xdgshellwindow.cpp` `scheduleConfigure`). The client is flushed when KWin's event loop next goes idle (`src/wayland/display.cpp`, `aboutToBlock`). Every activation pays for two frames, the window that loses focus and the one that gains it, before the configure leaves KWin. The cost grows with their area.

The two physical workloads did not use the same geometry. P00-switch ran on KWin-placed 400×300 clients (0.24 Mpx for the pair). P03-focus ran on Plastile's tiles: 0.9–2.6 Mpx per pair on the 2560×1440 output, and 0.5–1.5 Mpx on 1920×1080. That breaks this section's rule of the same geometries for comparable workloads. The difference that scales with the refresh rate is mostly a difference in tile area: the 144 Hz output is the 2560×1440 one. It is not one frame-aligned step. Binned by the tap's phase in the refresh cycle (eight bins from the previous vblank; [`phase.py`](../../probes/perf/focus/phase.py), physical raw logs), P03-focus is flat at 144 Hz (9.84–10.02 ms) and at 100 Hz (5.13–5.21 ms). At 60 Hz it steps from 5.8 ms in the first three bins to 6.7–6.9 ms after them. P00-switch depends on the phase at every rate: 2.5–4.3 ms at 144 Hz, 2.75–4.8 ms at 100 Hz, and 2.33–2.36 ms in the first half of the cycle against 3.68–3.77 ms in the second at 60 Hz. So part of every activation's latency is a frame-aligned wait, KWin's own switch included. The phase data alone cannot say what that wait is.

**Measured in nested KWin 6.7.5, labelled nested, not physical.** 2560×1440 output, 4 fixtures, real key input through libei, 600 samples per condition in randomized blocks with one fresh session each. Median ms from the key-down to the activation configure:

| Decoration | Frames | KWin's switch, no tiler | KWin's switch, Plastile loaded | Plastile focus.next | Minimal script (`activeWindow =` only) |
|---|---|---|---|---|---|
| Aurorae v2 + the desktop's SVG theme | tiled | 7.88 | 7.62 | 6.18 | 5.88 |
| same | KWin's 400×300 | 2.16 | — | — | 2.20 |
| same | KWin's 400×300, Plastile's layout floating (review run, `--floating`) | 2.15 | 2.20 | 2.24 | 2.20 |
| Breeze (default) | tiled | 1.83 | 1.87 | 0.92 | 1.16 |
| Breeze | 400×300 | 1.15 | — | — | 1.21 |
| Aurorae v2, no theme (paints nothing) | tiled | 0.41 | — | 0.58 | 0.46 |

- **Same window pair, same cost.** Activating the master from a stack tile, or the reverse (2.40 Mpx), took 7.7–8.1 ms with KWin's switch (7.6 ms with Plastile loaded), 7.7–7.8 ms with Plastile and 7.6–7.7 ms with the minimal script. Pairs of stack tiles (0.96 Mpx) took 4.9–5.2 ms with Plastile or the minimal script. KWin's switch among master/stack tiles always involves the master, which is why its overall median is the highest.
- **Area model.** Over the tiled and 400×300 Aurorae runs (4189 samples), latency ≈ 2.4 ms + 2.2 ms per Mpx, r² 0.67. Over the five tiled Aurorae runs (three builds, 8394 samples, only two pair areas), it is 3.7 ms + 1.6 ms per Mpx, r² 0.31. The physical P03-focus samples at 144 Hz fit 5.5 ms + 1.9 ms per Mpx, r² 0.76: the same slope as nested, but an intercept 3.1 ms higher. At P00-switch's 0.24 Mpx that line gives 6.0 ms, against the 3.3 ms P00-switch measured. The intercept alone does not show a Plastile cost. A line fitted to tiled areas overestimates small windows in nested too: the tiled-only fit gives 4.1 ms at 0.24 Mpx, and 2.2 ms was measured. Only the 100 Hz run compares the two workloads at equal area (see *What remains open*). With Breeze, latency is flat (r² 0.02).
- **Where the time goes** (Aurorae, tiled, Plastile focus.next; median ms):

  | Stage | ms |
  |---|---|
  | Key-down → Plastile's handler | 0.25 |
  | Inside the `workspace.activeWindow` assignment (KWin's activation, the decoration's re-render, every synchronous handler) | 4.23 |
  | Rest of Plastile's dispatch | 0.08 |
  | `windowActivated` → the next event-loop turn (work queued by the activation; with Breeze or no theme 0.06–0.12 ms) | 2.07 |
  | That turn → the configure received | 0.05 |

  The assignment takes 0.12 ms without a theme, 0.5–0.9 ms with Breeze and 1.7 ms with Aurorae at 400×300. Plastile's own work around the assignment is 0.06–0.09 ms in every build and decoration. Its `windowActivated` handler is within the assignment's 0.03 ms difference to the minimal script.
- **Script-side activation is not slower than KWin's own.** At 400×300 the minimal script and KWin's switch land within 0.06 ms of each other, with either decoration. For the same tiled window pair they land within 0.5 ms. In KWin 6.7.5 the script setter is `Workspace::activateWindow(window)`, the same call `Workspace::switchWindow` makes (observed source: `src/scripting/workspace_wrapper.cpp` `setActiveWindow`, `src/useractions.cpp`). No script-visible way to activate avoids the decoration's re-render, because the re-render belongs to the activation itself.
- **No build regression.** At the same pair (2.40 Mpx) Plastile focus.next took 7.7–8.4 ms at `4afc10e` (the windowed-GPU run's build), 8.3–8.7 ms at `97fec4a` (the physical run's build) and 7.9–8.1 ms at this branch. KWin's switch took 7.2–8.1 ms in the same sessions. The run-to-run spread is about ±0.5 ms. The windowed-GPU run matched KWin's switch because its private configuration used Breeze.
- **18 windows on 6 desktops** (14 extra fixtures on other desktops): Plastile 6.22 ms, minimal 6.11 ms, KWin's switch 7.29 ms. The populated session added nothing to Plastile's cost.
- **Repeated in review** (three blocks of 300 per condition, new sessions, [evidence](../status/evidence/focus-latency-nested-20261019.json) `review`). Aurorae, tiled: Plastile 5.80 ms, minimal 6.03 ms, KWin's switch 7.46 ms. At the 2.40 Mpx pair they took 7.45–7.60, 7.71–8.64 and 7.32–7.58 ms. Breeze, tiled: Plastile 1.31 ms, minimal 1.22 ms, KWin's switch 1.83 ms, flat across pairs. The per-block medians spread by about ±0.5 ms under Aurorae and ±0.05 ms under Breeze.

**What remains open.** At 100 Hz the physical P03-focus context had a floating layout, so its fixtures kept KWin's 400×300 placement, the same area as P00-switch. There, P03-focus took 5.2 ms against 4.0 ms. That residual of 1.2 ms is one run of 1000 samples (the 100 Hz run is incomplete). The nested runs above did not reproduce it, though at first they compared only KWin's switch and the minimal script at 400×300 (2.16 against 2.20 ms), both without Plastile. The review measured that physical condition in nested: Plastile loaded, its layout floating, KWin's 400×300 placement, the reference desktop's Aurorae theme, three blocks of 300 per condition. Plastile's focus.next took 2.24 ms (per block 2.24, 2.24, 2.25), KWin's switch 2.15 ms (2.19, 2.13, 2.16), KWin's switch with Plastile loaded 2.20 ms and the minimal script 2.20 ms. Plastile's work around the assignment was 0.07 ms. At that geometry Plastile adds under 0.1 ms in nested, so the physical residual must come from something the nested session lacks (plasmashell and its panels, three outputs, other clients, a real display's render timing). It is not explained. At 100 Hz, P00-switch's slower phase bins (4.6–4.8 ms) lie within 0.6 ms of P03-focus's flat 5.1–5.2 ms. That fits P03-focus always taking the frame-aligned wait, but this has not been tested. The physical re-run needs a P00-switch baseline at Plastile's geometry. One option is KWin's switch with Plastile loaded, which tracks KWin's switch without Plastile within 0.3 ms in nested, though its window pairs differ from focus.next's. Until then, the P03-focus verdict against P00-switch measures window size as much as Plastile. A focus-heavy user on an Aurorae SVG theme pays for this cost on every activation, whoever asks for the activation.

## 6. Experimental protocol

1. Pin implementation/upstream commits and actual package versions. Disable other tiling managers. Use a disposable profile and preserve window rules/effects between runs.
2. Record hardware, CPU/GPU load, power mode, display pipeline, refresh/VRR, scale, renderer, and nested/physical status. Do not disable features only for Plastile and then compare to defaults elsewhere.
3. Warm the runtime/fixtures and record warmup separately. Do not discard unexplained slow events as warmup after seeing the data.
4. Use seeded workload generation, repeated independent runs, and randomized/alternating baseline order to reduce drift. Preserve every sample with a failure/outlier reason rather than deleting it.
5. For p99 claims, collect enough observations to represent the tail: target at least 5000 ordinary command samples across multiple runs; report per-run and pooled summaries. Bootstrap by run/block where autocorrelation matters. For expensive topology tests, publish counts and raw distributions rather than overclaiming p99 from a handful of samples.
6. Run instrumentation-enabled and disabled builds/settings separately. Quantify observer overhead. Buffer trace data in memory and export after the measured block.
7. Measure pure-core, real-KWin adapter, controlled-client, and physical presentation layers separately. A nested compositor is useful for reproducibility but cannot establish physical scanout/input latency. The physical input-to-visible protocol and its tooling are in [PHYSICAL_RUNBOOK P6](PHYSICAL_RUNBOOK.md#p6-input-to-visible-latency-p00-p03).
8. Include correctness failures/timeouts in the result summary. A fast failed placement is not a successful latency sample; report success rate and timing of failure/fallback.
9. Inspect worst events and correlate with write/solve counts, GC, topology, rule activation, client delay, or scheduling. Preserve traces for representative outliers.
10. Summarize median/p95/p99, max, spread/confidence, sample count, and exclusions with reasons. Compare changes against noise and run-to-run variation, not only percent improvements.

## 7. Attribution and optimization order

Use counters to test hypotheses:

| Symptom | First investigation | Possible targeted change |
|---|---|---|
| Low solver time, high command delay | Fixed timers, callback scheduling, blocking work | Immediate lane; stable coalesced flush; move parsing/I/O off path |
| Many solves per action | Signals feeding recursive arrangement | Dirty full contexts, apply guard with preserved structural events |
| Many writes but few changes | Missing scalar diff, repeated property flags | Diff against requested intent and owned property values |
| Rapid resize reversals fail | Late configure/commit and false no-op | Request ledger; bounded stale-ack handling; capability spike if needed |
| p99 grows with rule count | Repeated regex parsing/matching | Compile once, dependency-index rules, metadata/config cache |
| Latency grows with inactive desktops | Global scans/arrangement | Context-local collections and dirty sets |
| Native path emits many changes | Full tree rebuild/temporary sizes | Stable node mapping and structural/geometry diff |
| Smooth animation feels delayed | Animation serializes commands | Retarget visual state; zero default duration; separate first-response metric |
| Memory/work increases after reload | Stale connections/timers/instances | Ownership registry, generation invalidation, teardown tests |
| Client redraw dominates | Unnecessary intermediate sizes or slow app | One final real target; transform-only presentation; report client bound |

Only after these are addressed should an agent consider array pooling, specialized data structures, compiled solver code, or a daemon. Verify every optimization with the same behavior fixtures and benchmark workload. Do not make the core harder to reason about for a statistically insignificant gain.

### 7.1 QV4 iteration allocates (measured)

Finding from the G2 follow-up (2026-10-19, nested KWin 6.7.5 / Qt 6.12.0, [G2 report §16](../status/G2_REPORT.md#16-follow-up-the-median-slowdown-and-the-pure-solve-p99-nested-virtual-kwin-675-2026-10-19), [evidence](../status/evidence/g2-followup.json)). Nested only; not physical.

**Why it matters.** The bundle targets ES2016, so `for…of`, spread and array destructuring run in KWin's QV4 as written. Each loop allocates an iterator object. Each step allocates a `{value, done}` result object. A `Map` entry is a new `[key, value]` array, which destructuring iterates again (observed source: qtdeclarative v6.12.0 `qv4mapiterator.cpp`). These are garbage-collected objects.

**How collections reach a span.** QV4 starts a collection at the allocation that finds the heap full (`qv4mm_p.h` `MemoryManager::allocate`). With the default 5 ms incremental limit, a cycle of about 0.8 ms finishes inside the span that triggered it.

**What was measured at 32 windows** (G2 protocol, 5 × 1000 per command, `eca2df5` → `212d86b`):

- The pure-solve slow mode was collections. In a diagnostic unit, 151 of 153 solves above 0.5 ms had a collection start in their command's interval. Without one, a solve was slow 0.04 % of the time.
- A `Set` walked with `for…of` in `participates()`, once per window per solve and per write, cost 0.04–0.06 ms per command on its own (two bisect campaigns). That was the largest single part of the 0.09–0.12 ms median slowdown since `b60e618`; the rest is spread over later commits and not attributed to lines.
- Rewriting the master/stack solve, `allocate()`, the solve input and the apply loop changed three things:
  - pure-solve p99 from 1.055–1.092 ms to **0.166–0.170 ms**;
  - p50 from 0.17–0.18 ms to 0.09–0.10 ms;
  - garbage per command, across the whole engine, down by about 46 %.

  The rewrite used index loops, `Map.forEach`, and flat cut arrays instead of `[begin, end]` tuples. The solver output is bit-for-bit unchanged (`tests/core/solveAlloc.test.ts`). The apply loop's iteration order is not, in one case (below).

**Rule for code on the command path** (solve, apply, adapter writes, observation handlers):

- Iterate arrays with index loops and Maps with `forEach`.
- Know that the two are not interchangeable in QV4 when the loop deletes entries. QV4's `for…of` over a `Map`, `Map.keys()` or a `Set` skips the entry after one deleted at or before its position; `forEach` follows ECMAScript, as V8 does (measured, Qt 6.12.0: [qv4iter](../../probes/perf/qv4iter/run.py), [evidence](../status/evidence/qv4-iteration.json)). A Node test cannot see the difference. Do not delete from a collection inside a `for…of` over it; iterate a copy, or use `forEach`.
- Do not spread into calls.
- Do not `map`/`slice` per window when an index range will do.
- Return flat arrays rather than one small array per item.

Verify any such change with the QV4 probes ([qv4solve](../../probes/perf/qv4solve/run.py), [ab_bundles](../../probes/perf/ab_bundles.py), [ab_qualify](../../probes/perf/ab_qualify.py)). A Node benchmark does not measure QV4's iterator or collector costs. Collections still happen, now mostly outside the solve span (apply, KWin's frame writes, observations), so they remain in the command path's outer p99 (1.1–1.6 ms nested). A physical session's heap is larger and has not been measured.

## 8. Raw result schema

Store JSONL/CSV records with at least:

```json
{
  "runId": "reference-001",
  "implementationCommit": "exact-sha",
  "environmentId": "profile-id",
  "workload": "P06",
  "sample": 42,
  "contextCount": 4,
  "affectedWindowCount": 8,
  "clock": "monotonic-test-harness",
  "clockResolutionNs": 1000,
  "dispatchNs": 0,
  "solveEndNs": 0,
  "lastRequestNs": 0,
  "observedNs": null,
  "presentedNs": null,
  "presentationUnavailableReason": "nested fixture without physical feedback",
  "solves": 1,
  "geometryWrites": 2,
  "nativeMutations": 0,
  "configureCount": null,
  "correctiveWrites": 0,
  "success": true,
  "failureReason": null
}
```

This is an illustrative schema; the zeros are placeholders, not measured data. Real records must include aligned timestamp definitions and non-placeholder values. Keep raw traces local/private when they contain identifying window metadata; publish redacted reproducible benchmark results and fixture parameters.

## 9. Release report requirements

Name the exact feature/version/environment tested; provide comparable baselines; separate proposed budgets from measured values; show failures and tail behavior; state measurement limitations. “Uses C++,” “zero idle CPU,” “instant,” and “fastest” are not substitutes for results. The accepted product claim can be narrower and stronger: for the declared fixtures and machines, ordinary commands meet stated latency targets without geometry loops or unbounded idle work.
