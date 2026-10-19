# Correctness and compatibility matrix

## 1. Test layers and independent oracles

| Layer | What it proves | What it cannot prove |
|---|---|---|
| Pure model/layout tests | Determinism, tree/order invariants, feasibility, coalescing semantics | Qt signals, Wayland clients, actual display latency |
| Property/randomized tests | Broad state/geometry invariants across operation sequences | Correctness of an unmodeled native API |
| Replay tests with mock clock/adapter | Ordering, stale-generation rejection, bounded requests | Real toolkit request/commit behavior |
| Actual QV4/KWin probe | Runtime module/API semantics, signal re-entry, object conversions | Physical presentation when nested |
| Nested compositor integration | Real window lifecycle, protocol/configure behavior, package loading | Physical monitor input/scanout and all driver issues |
| Physical-session checks | Input/visual/hit-region behavior, mixed outputs, real frame pacing | Every hardware/distribution combination |

Use independent oracles. For layout, verify coverage/minima/edge conservation rather than duplicating the solver. For runtime, observe frames from a separate probe/client and count protocol events when possible. For presentation, use client markers/output feedback or documented hardware/video methods. Do not let the code under test declare itself correct merely by reporting its own desired rectangle.

## 2. Core and scheduling scenarios

| ID | Scenario | Expected invariant/result | Required layer |
|---|---|---|---|
| C01 | Add same ID/generation twice | One record and one leaf | Pure/replay |
| C02 | Remove then stale geometry event | No write, no resurrection | Replay + KWin |
| C03 | Native ID reused for new lifetime | Old callback rejected by generation | Replay |
| C04 | Create/remove before adoption | Zero placement writes | Replay + KWin |
| C05 | Two grow commands during apply | Both deltas retained in order | Replay |
| C06 | Geometry signal during write | No recursive solve; expected observation recorded | KWin |
| C07 | Removal during apply | Tombstone immediately, peers still applied | Replay + KWin |
| C08 | Exception in command/apply callback | Guards released; next command works | Replay + KWin |
| C09 | Burst across two contexts | One solve per affected context per flush | Replay + KWin counters |
| C10 | Context changes before delayed flush | Correct old/new keys, no use of mutable global context | Replay |
| C11 | No-op plan | Zero external property/native writes | Pure + KWin counters |
| C12 | Focus-only navigation | No ordinary-layout solve or geometry request | KWin |
| C13 | Large event burst | Bounded queue/linear coalescing, no silent structural drops | Pure + replay |
| C14 | Idle after settling | No Plastile periodic timer/work | Runtime counters/profile |

## 3. Geometry and client protocol scenarios

| ID | Scenario | Expected result | Required layer |
|---|---|---|---|
| G01 | Odd 1919×1079 area with gaps | Shared edges conserve area, no accidental overlap | Pure |
| G02 | Negative output origin | Correct global logical rectangles | Pure + nested |
| G03 | 1.25/1.5/1.75/2.0 scale | Accepted frame values converge; no repeated fractional corrections | Nested + physical |
| G04 | Delayed client resize commit | Peers proceed, request remains pending, no busy loop | Controlled client |
| G05 | A→B→A before B commits | Final A intent wins or bounded diagnosed capability failure | Controlled client; both spikes |
| G06 | Old target observed after newer request | No policy rollback; bounded reconciliation | Replay + controlled client |
| G07 | Fixed-size window | Floating/excluded according to policy | Nested |
| G08 | Minima exceed available slot/tree | Deterministic overflow explanation | Pure + controlled client |
| G09 | Max-size constrained client | No repeated force-resize; defined alignment/fallback | Controlled client |
| G10 | XWayland increment/aspect hints | Accepted geometry respected, documented limits | XWayland fixture |
| G11 | Application resizes itself | Bounded reconciliation or yield, never oscillation | Controlled client |
| G12 | Client ignores requests | Corrective budget exhausted once, visible fallback | Controlled client |
| G13 | Position-only versus real resize | Correct attribution and independent timings | Controlled client/protocol trace |
| G14 | Border/decorations change | Correct frame/content interpretation, no restore corruption | Qt + real app |
| G15 | Click targets after tile/resize | Displayed tab/titlebar hit regions remain usable | Physical input test |

## 4. Layout and state scenarios

| ID | Scenario | Expected result |
|---|---|---|
| L01 | Master insert/remove/promote | Stable deterministic order and master count |
| L02 | Ratio clamp with minima | Feasible result, explained no-op/clamp |
| L03 | BSP randomized insert/remove | Unique leaves, valid parents, collapsed unary branches |
| L04 | BSP rotate/mirror/equalize | Defined transformation, stable IDs where appropriate |
| L05 | Deep unbalanced BSP | No unsafe recursion/stack failure; bounded traversal |
| L06 | Switch among initial layouts | Preserve windows/order/float decisions |
| L07 | Monocle focus with transient dialog | Selected member usable; dialog not hidden incorrectly |
| L08 | Float→user resize→tile→float | Restore latest real floating geometry |
| L09 | Minimize/unminimize under delayed commits | Suspended requests and correct reinsertion |
| L10 | Fullscreen/restore | Native fullscreen respected; prior intent restored |
| L11 | Maximize/restore, including rule-enforced maximize | No geometry fight; respect KWin rules |
| L11a | Window that opens maximized (application or KWin chose it; Wayland and X11), `maximizedOnOpen` tile/keep, later user maximize, a client that re-maximizes, windows maximized at start/reload/resume, opened on a desktop not shown, no room in the layout (ADR-021) | Un-maximized once and tiled with one configure (when shown, for a hidden desktop), or kept with `keep` or without room; later maximizes honoured; no fight (`maximized-open-*-T17`) |
| L12 | Overlapping minimize/fullscreen states | Clearing one suspension does not clear another |
| L13 | Native quick-tile | Ownership yields or chosen native-mode semantics apply |
| L14 | Native editor edit during automatic mode | Explicit adopt/manual/suspend policy; no competing writers |
| L15 | New window on inactive desktop | No involuntary follow/focus unless configured |
| L16 | All-desktop/multi-activity window | Default float, no conflicting geometry targets |

Pure tests cover layout invariants; actual KWin tests cover all state transitions. Test representative real applications: Konsole, Kate, Dolphin, a browser, a dialog-heavy application, and an XWayland client. Application names are examples, not a compatibility guarantee. Record tested versions and distinguish toolkit/client defects from tiler behavior without assuming attribution.

## 5. Topology and interactions

| ID | Scenario | Expected result |
|---|---|---|
| O01 | Two outputs, offset/negative origin | Commands target intended output |
| O02 | Mixed scale/portrait/refresh | Correct logical placement and independent timing report |
| O03 | Output enumeration reorder | Identity/preferences unchanged |
| O04 | Unplug with pending resize | Old requests cancelled; windows visible on fallback |
| O05 | Replug same/ambiguous display | Deterministic preference recovery or explained fallback |
| O06 | Temporary invalid/zero output geometry | Retain valid state, bounded convergence, no invalid placement |
| O07 | Panel auto-hide/floating/work-area change | No double padding/subtraction or oscillation |
| O08 | Different current desktop per output | Correct visible-context targeting |
| O09 | Activity change and native root projection | Correct saved logical model, no stale activity apply |
| O10 | Desktop rename/reorder/remove | Stable ID policy, safe migration/removal |
| I01 | Drag through multiple tiles | Preview only by default, one release commit |
| I02 | Escape/cancel drag | Original structure restored; preview/timers gone |
| I03 | Shared resize with constraints | User owns drag; feasible peers update boundedly |
| I04 | Window/output removed mid-drag | Cleanup and no stale callback |
| I05 | Rapid keys during resize/animation | Defined ordering; no animation queue barrier |
| I06 | Disable while overlay/animation visible | Input and appearance fully restored |

Use nested virtual outputs for repeatable logic, then real monitors for mandatory physical checks. A headless virtual setup cannot certify mixed-refresh frame pacing.

## 6. Configuration, packaging, and lifetime

| ID | Scenario | Expected result |
|---|---|---|
| Q01 | Invalid schema/unknown key/NaN | Reject and retain prior config |
| Q02 | Multiple matching overrides/rules | Documented field-level order and explanation |
| Q03 | Title update with app-only rules | No unrelated matcher recompilation |
| Q04 | Rapid settings reload | One engine and one shortcut handler |
| Q05 | Helper dies/restarts | Runtime continues; async versioned recovery |
| Q06 | Ambiguous session restore | Ordinary insertion, no incorrect unique identity claim |
| Q07 | Schema migration/partial write | Last valid config preserved |
| Q08 | Shortcut conflict/update | User binding preserved; conflict explained |
| Q09 | 100 enable/disable cycles | Counts return to steady baseline; no leaked work |
| Q10 | Disable after user changed border/layer | Restore only still-owned properties |
| Q11 | Clean install/update/remove | Correct metadata/imports, config preservation, resource release |
| Q12 | Unsupported runtime capability | Actionable error/disabled feature; no silent crash |

## 7. Later-feature gates

- **Scrolling:** preferred widths, column stacking, visible-range calculation, focus policy, transient positioning, adjacent-output leakage, off-screen input, opacity restoration, rapid reversal, and disable mid-transition. Compare with a scrolling baseline.
- **Zones:** keyboard/UI geometry equality, overlay-hidden no work, active-only pointer sampling, zone-span rounding, panel reservation, connected resize policy, malformed layout rejection.
- **Native presentation:** retarget from current visual state; final real geometry issued once; GL cleanup in a valid context; hit-test consistency; reduced-motion and renderer/version support; package rebuild across KWin changes.

## 8. Version matrix

Rows are real runs; per-scenario results are in the linked reports. "All" means every scenario in
`tests/integration/run.py --list` at that commit except the listed SKIPs.

| KWin package | Qt package | Session | Renderer/GPU | Test layer | Passed IDs | Failures/limitations |
|---|---|---|---|---|---|---|
| kwin 6.7.5 (Arch) | Qt 6.12.0, KF 6.30.0 | Nested `--virtual` on the reference host | OpenGL (host GPU, offscreen) | Nested | All 99 run scenarios at `67772ee` ([evidence](../status/evidence/integration-host-67772ee.json)) | SKIP G02 negative origin (KWin normalizes origins) |
| kwin-wayland 4:6.7.5-0ubuntu1 (Ubuntu 26.10 sandbox) | Qt 6.11.2, KF 6.29.0 | Nested `--virtual` in CI | QPainter | Nested | All 88 run scenarios at `67772ee` (CI run 39109880796) | SKIP L14 (tile editor is GL-only), SKIP G02 |
| kwin 6.8.0 (Nix, pinned nixpkgs) | Qt 6.11.2, KF 6.30.0 | Nested `--virtual` in CI (provisional) | llvmpipe, emulated udmabuf | Nested | 84 of 87 run scenarios at `67772ee` | FAIL `reload-Q09`, `persist-reload-cycles-Q09` (KWin RSS growth), `persist-no-qtcore-Q05` (test environment); SKIP G02 |
| kwin 6.7.5 (Arch) | Qt 6.12.0 | Physical Plasma Wayland session, reference desktop, build `97fec4a` | OpenGL, AMD RX 9070 XT; 144/100/60 Hz, scale 1 | Physical | P0, P1, P2a–c, P3, P4, P5, P7, P8b; P6 at 60 Hz ([evidence](../status/evidence/physical-runbook-20261018.json)) | FAIL P6 at 144 Hz (ratio, focus); P6 100 Hz incomplete; P8a soak idle only (no growth over 3.83 h, no window activity); P2d, P2e skipped by the owner; P9 and PHY-10 not run ([G3 checklist](../status/G3_CHECKLIST.md)) |

The initial support candidate families are 6.7 and 6.8. Earlier Plasma releases and full X11 sessions are separate compatibility work. XWayland-client coverage does not imply full X11-session support.

## 9. Release criteria

All mandatory initial scenarios have a real result on declared supported versions. Every workaround has a reproducer and regression fixture. No unbounded geometry loop, stale callback, invisible orphan, duplicate engine, unexplained tail regression, or incomplete teardown remains. Physical-session presentation/input checks are explicitly completed; otherwise the result remains a candidate with those gates open. Report skipped/unavailable tests by ID rather than collapsing them into a passing count.

The physical-session procedures, consent points, pass criteria and tooling are in [PHYSICAL_RUNBOOK](PHYSICAL_RUNBOOK.md).
