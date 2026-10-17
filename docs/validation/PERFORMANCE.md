# Performance and snappiness validation

## 1. Evidence status

No runtime performance experiment was executed during the planning research. Every numerical budget in this document is a **proposed engineering acceptance target**, not a claim about Plastile or an upstream project. M0/M1 must calibrate the reference machine and measurement resolution. Record an explicit revision if targets change; do not relax them silently after a failure.

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

## 6. Experimental protocol

1. Pin implementation/upstream commits and actual package versions. Disable other tiling managers. Use a disposable profile and preserve window rules/effects between runs.
2. Record hardware, CPU/GPU load, power mode, display pipeline, refresh/VRR, scale, renderer, and nested/physical status. Do not disable features only for Plastile and then compare to defaults elsewhere.
3. Warm the runtime/fixtures and record warmup separately. Do not discard unexplained slow events as warmup after seeing the data.
4. Use seeded workload generation, repeated independent runs, and randomized/alternating baseline order to reduce drift. Preserve every sample with a failure/outlier reason rather than deleting it.
5. For p99 claims, collect enough observations to represent the tail: target at least 5000 ordinary command samples across multiple runs; report per-run and pooled summaries. Bootstrap by run/block where autocorrelation matters. For expensive topology tests, publish counts and raw distributions rather than overclaiming p99 from a handful of samples.
6. Run instrumentation-enabled and disabled builds/settings separately. Quantify observer overhead. Buffer trace data in memory and export after the measured block.
7. Measure pure-core, real-KWin adapter, controlled-client, and physical presentation layers separately. A nested compositor is useful for reproducibility but cannot establish physical scanout/input latency.
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
