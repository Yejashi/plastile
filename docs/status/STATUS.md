# Implementation status

**Product state:** a working automatic tiler, packaged as a KWin 6 declarative script (`package/`) with a
TypeScript core (`src/`). It is a **release candidate in preparation, not a release**: everything below was
validated in unit/replay tests and in disposable nested KWin sessions, and the [physical runbook](../validation/PHYSICAL_RUNBOOK.md)
has run on one desktop at build `97fec4a` (results below). Gate G3 is open: see the [G3 checklist](G3_CHECKLIST.md).

Updated 2026-10-26 at `main` (see `git log`). [HANDOFF](HANDOFF.md) has the working context for the next
agent; this file is the short status.

## Tested environments and last results

| Layer | Environment | Last result |
|---|---|---|
| Unit/replay | Node 26 (`node --test tests/core/*.test.ts`), mock host and fake KWin, replay fixtures recorded from nested KWin (`tests/fixtures/replay/`) | 604/604 (`wf/bugfix` at `ee6f8ef`, after the 2026-10-25 bug hunt and its review; 535/535 at `f43de02`), including QV4-vs-V8 iteration scenarios |
| Nested, virtual backend | Reference host: Arch Linux, KWin 6.7.5, Qt 6.12.0, KF 6.30.0 ([ENVIRONMENT](ENVIRONMENT.md)) | `3297b6d` (`wf/rekey-review`): 1897/1897 checks, 141/141 scenarios, 1 expected SKIP ([evidence](evidence/integration-host-3297b6d.json)); earlier `521eb6c` (`wf/rekey`, [evidence](evidence/integration-host-521eb6c.json)) and `eb23093`, the same counts ([evidence](evidence/integration-host-eb23093.json)) |
| Nested, virtual backend, KWin 6.8.1 | Reference host after a system update (2026-10-25): Arch Linux, KWin 6.8.1, Qt 6.12.0, KF 6.31.0 | `ee6f8ef` (`wf/bugfix` after its review, the bug-hunt fixes): 2045/2045 checks, 155 scenarios with 154 run and 1 expected SKIP ([evidence](evidence/integration-host-kwin681-bugfix-ee6f8ef.json)); `reload-Q09` grew KWin by 0.43 MiB over 100 reloads and `persist-reload-cycles-Q09` by 3.4 MiB, both inside their bounds. Earlier: `0a0798c` 1895/1895 ([evidence](evidence/integration-host-kwin681-0a0798c.json)) |
| Nested, virtual backend (CI) | Ubuntu 26.10 sandbox: KWin 6.7.5, Qt 6.11.2, KF 6.29.0, QPainter compositing | `58614e5`: 1724/1724 checks, 13 expected SKIPs, on the first attempt (run 40272444147). `3ec082c` (after the bug hunt): 1724/1724 checks, 132/132 run scenarios, 13 expected SKIPs (run 40269141050, on its re-run; the first attempt hit two timing flakes, see [CI](CI.md#4-open-items)). Earlier `cf5fe36`: 1664/1664 |
| Nested, virtual backend (CI, provisional) | Nix: KWin 6.8.0, Qt 6.11.2, KF 6.30.0, llvmpipe | `58614e5`: 1675/1675 checks, 14 expected SKIPs, both `Q09` bounds passed (run 40272444147). `3ec082c`: 1675/1675 checks, 129/129 run scenarios, 14 expected SKIPs (run 40269141050). The two `Q09` RSS bounds still fail in some runs on KWin 6.8.0's own heap growth (they failed at `6d3d530`, run 40267513338) |
| Nested, windowed on the real GPU | Reference host: nested KWin 6.7.5's outputs are windows on the live compositor (`PLASTILE_NESTED_HOST_DISPLAY`), OpenGL on the real GPU, 144 Hz host output; private bus, config and XDG dirs | Latency kit at full protocol (30,000 taps): every Plastile workload `pass` against its matched baseline; 19/19 chords delivered; real apps, real `plasmashell` panels, GL tile editor pass ([runbook §1](../validation/PHYSICAL_RUNBOOK.md#1-what-was-validated-where)). Labelled `nested-windowed-gpu`, never physical |
| Physical session | Reference desktop (KWin 6.7.5, HDMI-A-1 144 Hz, DP-2 100 Hz, DP-1 60 Hz, scale 1), runbook with the owner's consent, installed build `97fec4a` | P0, P1, P2a–c, P3, P4, P5, P7, P8b idle pass; P8a soak 3.83 h unattended: no growth (KWin RSS +4 KiB, connections 175, errors 0) but no window activity, so the normal-use soak is open ([evidence](evidence/physical-runbook-20261018.json)). **P6 latency** (5 × 1000 samples per workload): 60 Hz pass for every Plastile workload; 144 Hz swap pass, **ratio fail** (+11.5 ms median vs quick tile, the difference is in KWin's commit→present of resized windows; Plastile's input→configure is 0.6 ms) and **focus fail** (+10.3 ms vs KWin's window switch). The focus gap is mostly the Aurorae decoration's re-render on activation, which grows with window area: P00-switch ran on KWin's 400×300 placement, P03-focus on Plastile's tiles; in nested KWin a script activation costs the same as KWin's own and Plastile adds under 0.1 ms ([PERFORMANCE §5.1](../validation/PERFORMANCE.md#51-focus-activation-cost-depends-on-the-decoration-and-window-size)); a 1.2 ms residual at equal area is open, and the kit now has a P00-switch-tiled control. 100 Hz incomplete (re-run pending). Plastile did one solve per command, no corrections, and 0 solves/writes for 10,500 focus commands. Found and fixed: a hidden-desktop window diverged on a panel change (`a5642dd`). The owner's kitty opens maximized and was left suspended: windows that open maximized are now un-maximized and tiled (ADR-021, `0a371c9`, nested only). Open: physical re-check of `a5642dd`, a multi-hour soak with normal use, P2d/P2e skipped by the owner. Later, on KWin 6.8.1: ADR-021 at login and a 1 h normal-use soak at `0a0798c`, and `58614e5` installed and started cleanly (Next tasks 1). Earlier: the owner's laptop (eDP-1, scale 1.35), by hand ([evidence](evidence/physical-first-run-20261018.json)) |

Expected SKIPs: `output-negative-origin-G02` (KWin normalizes output origins, so a negative origin cannot
occur); `native-editor-toggle-L14` only where compositing is QPainter (the tile editor is GL-only);
`plasmashell-panels-O07` and `settings-dialog-T28` in CI (no plasmashell or kcmshell6 in the sandbox images; both run on the reference host).

## Gates

| Gate | State |
|---|---|
| G0 (APIs and measurement viable) | Passed, nested ([M0 report](M0_PROBE_REPORT.md), [API profile](API_PROFILE.md)) |
| G1 (backend decision) | Passed, nested: direct geometry (ADR-003) |
| G2 (integration and performance) | **Passed, nested only** ([G2_REPORT](G2_REPORT.md), [§16](G2_REPORT.md#16-follow-up-the-median-slowdown-and-the-pure-solve-p99-nested-virtual-kwin-675-2026-10-19)): every §4 budget is now met in nested KWin 6.7.5. Pure-solve p99 at 32 windows fell from 1.00–1.10 to 0.166–0.170 ms: the slow mode was QV4 garbage collection (151 of 153 slow solves had a collection start in their interval), and the solve path now allocates 46 % less. The ratio median is 0.11 ms below `b60e618`; of the earlier 0.09–0.12 ms slowdown, 0.04–0.06 ms was a Set iterator in `participates()` (`8a4bea5`), and the rest is attributed only to commit ranges. Physical input-to-visible is G3's |
| G3 (release) | **Open**: physical session, G2 report, release checklist, licence (ADR-012, owner decision) |

## Tasks

Verdicts from a card-by-card audit against each acceptance text (2026-10-18), updated for the work since.
"Nested" means a nested KWin scenario; "unit" means unit/replay only. Physical clauses are open everywhere.

| State | Tasks |
|---|---|
| Complete (nested evidence) | T00–T03, T05, T08, T10, T13–T16, T18, T19, T22–T25, T27 (helper, ADR-020), T28 (no live preview: ADR-019), T29, T30 |
| Complete (unit/replay evidence) | T09, T11, T12, T17 (its ADR-021 addition, windows that open maximized, also nested: `maximized-open-*-T17`), T21 |
| Reopened and complete (nested evidence), physical judgement open | T31: the optional Plastile Motion effect (ADR-023, supersedes ADR-018's deferral; [below](#window-motion-t31-adr-023-nested-kwin-681)) |
| Superseded by G1 | T06, T07 (native spike; ADR-003) |
| Partial | T04 (nested baselines committed with raw samples: no tiler, quick tile, Polonium 1.2.2; physical half open), T20 (G2 report: one budget not met, see Gates), T26 and T32 (no release-to-release upgrade yet: the old side is a past commit relabelled), T33 (6.8 job provisional: RSS noise), T34 (nested protocol run in the G2 report; physical soak and latency open; 6.8 RSS), T35 ([G3 checklist](G3_CHECKLIST.md) written: candidate, not a qualified release; user docs audited; licence and physical gates open), T36/T37 (experimental, ADR-014) |

Recent nested evidence (KWin 6.7.5, each with mutation checks): dialogs follow their parent through minimize,
desktop moves and close, matching KWin without Plastile (`scenarios_transients.py`); unload and reload in
monocle leave no state behind (`monocle-unload-T22`); resume and re-enable adopt events missed while suspended,
re-placing a window that drifted in place (`scenarios_recovery.py`); a send solves each affected context once;
recorded replay fixtures (`tests/fixtures/replay/`); a version upgrade keeps user rebindings and config
(`package-upgrade-bindings-T26-T32`); KWin's real settings dialog (`kcmshell6 kcm_kwin_scripts`, *Configure…*)
driven with real input: Apply writes the runtime's vocabulary, Cancel writes and reloads nothing
(`settings-dialog-T28`; SKIPs in CI, which has no `kcmshell6`); windows on several desktops or activities never get
two targets, checked against KWin's frames (`scenarios_membership.py`); X11 dialogs behave like KWin without
Plastile; user floats survive suspend/resume and re-enable.

**Upgrade finding (documented in [INSTALL](../user/INSTALL.md)):** after a package upgrade, disabling and
re-enabling the script runs the *old* code again, because KWin keeps every declarative script's QML in one
engine's component cache. Only a KWin restart (a re-login) starts the new version. Defaults that changed between
versions stay bound to their old keys for existing users.

**Persistence (T27) no longer touches KWin's compositor thread** (ADR-020, owner decision 2026-10-18).
Saves and the load go over asynchronous D-Bus to `plastile-state` (`helper/`, D-Bus-activated, installed by
`tools/install.sh install-helper`); without it, preferences stay in memory with one diagnostic. On KWin's thread
a typical save now costs 0.22 ms p50 (max 0.69 ms) instead of 2–8 ms, and a stopped helper leaves KWin's round
trips at baseline (max 0.76 ms, against a 31.9 s stall with a held lock before)
([evidence](evidence/persistence-helper-cost.json)). The first solve waits for the saved state for at most
250 ms (released 0–2 ms after load with the helper running, 6–11 ms when it is activated). A saved float names
the window it came from (schema 2), so a window the user moved while Plastile was disabled keeps its place.

## Bug hunt, 2026-10-25 (unit and nested KWin 6.8.1)

At the owner's request, the whole project was searched for bugs. Sixteen finders each took one subsystem or one
cross-cutting lens, and five more covered the gaps a completeness critic named. An independent verifier then
tried to refute each finding. Of 71 findings, 2 were dropped (one refuted, one documented design). The verifiers
confirmed 68 and judged 1 plausible: 18 medium, 51 low, none critical or high.

**Outcome:** 63 fixed in code, each with a regression test that fails without its fix. 6 were documentation
corrections where the code was right: B27/B52 (directional swap and move are no-ops in monocle), B50
(focusWrap in scrolling), B32, B51 and B66. Nothing was left open. The full list with evidence is in the
workflow results (`wf/fix-*` branches merged into `wf/bugfix`).

Medium findings fixed:
- **Float preferences:**
  - an already-open tiled sibling took a closed window's float on a later unrelated event (B00);
  - toggling float while a tile configure was in flight left the window at the tile (B05);
  - an output re-key onto a retained key duplicated a context, and the next load rejected the snapshot (B09);
  - stale pending floats crowded out this session's decisions (B10);
  - float rectangles were restored in stale absolute coordinates after the output moved (B12).
- **Reconcile:**
  - an unrelated reclassify ended the readiness wait, so a window tiled before its rules matched (B01);
  - a skipped deadline correction left the request outstanding forever (B02);
  - re-tiling after the user or KWin owned the frame was charged to the correction budget (B03);
  - unpark skipped a window whose in-flight configure targeted the parking spot (B08).
- **Commands and layouts:**
  - adopt-native released KWin's tile on a window that cannot tile (B04);
  - BSP `longest` used a fixed 1920x1080 area instead of the real work area (B07/B24);
  - a layout change by command, reset or restored preferences never reconsidered overflow floats (B16).
- **Adapter:** a layer-shell bar with a namespace other than `dock` (waybar, AGS, eww) never re-solved the area
  (B06).
- **Test oracles:**
  - `motion-edges-T31` overwrote its first session's log check (B11);
  - motion scenarios could not parse KWin's log on a host up less than about 28 h (B17).
- **Physical kit:**
  - a response slower than the effect timeout counted as "key not delivered" and as a fast success for the next
    key (B13);
  - the live-session guard accepted a nested KWin started without a backend flag (B14);
  - with Plastile Motion on, settle time ignored the animation; it is now motion-aware and labelled (B15).

The new realapps survivor oracle (B47) found a real harness leak. `plasma_waitforname`, activated on the
private bus by chromium's notification, outlived the nested session. `NestedKwin.stop()` now ends the bus's
descendants (`d590d06`).

**Results:**
- Unit: 595/595 before the review, 604/604 after.
- Harness offline tests: `tests/integration` 11 OK and `tools/physical/tests` OK (1 skip because `/dev/uinput`
  exists on the host).
- Nested KWin 6.8.1 full suite at `56ce8ae` (before the review): 2041/2041 checks, 153/153 run scenarios, 1
  expected SKIP. The first full run, at `758c32c`, failed
  `realapps-chromium` (the leak above) and `resume-missed-events-T19` (an oracle that did not yet count the B03
  plan write); both were fixed before the second run.
- Physical: none of these fixes has been checked on the reference desktop yet. `58614e5` was installed there on
  2026-10-26 and started cleanly; the fixes were not exercised by a test.

**Adversarial review of the fixes** (three reviewers, branches `wf/review-engine`, `wf/review-runtime` and
`wf/review-tests`, merged into `wf/bugfix`). For every finding with a code fix, a reviewer reverted the fix and
confirmed that its regression test fails. They found and fixed regressions and gaps:
- **Engine:** two fix interactions could leave a window off every output.
  - A parked column whose float restore was deferred (B05 x B08) left the parked set early. A stop or suspend
    before its parking configure committed stranded it.
  - B03's `deferHidden` cleared the request B08's unpark relied on. A slow column whose parking deadline passed
    while hidden stayed off-screen at a stop or suspend.

  Both now hold the window inside its area. Also fixed:
  - a waiting float restore survived suspend and overwrote the user's placement at resume;
  - the new work-area read for BSP `longest` was unguarded (C08);
  - adopt-native reported `accepted` when the window overflowed;
  - a pending window that turned out to be a dialog waited for the deadline.
- **Runtime:** the B31 overlay refresh re-mapped a dismissed zone overlay for one turn after an activating
  command. `onDismissed` now clears the wish at once (new nested scenario `zones-overlay-activation-M9`).
- **Physical kit and probes:**
  - keytap's guard tests ran the real `/dev/uinput` build, so a guard regression could have created a real
    virtual keyboard in the live session. Tests now use a build with a non-existent device path.
  - The guard's accepting path now runs on this host.
  - `nested_dryrun` proves both guards refuse a flag-free nested `kwin_wayland`.
  - `probes/perf/run.py` and `tools/physical/common.git_revision` now count every implementation path.
  - Motion durations round like `Math.round`.
  - A live block whose motion state cannot be read withholds its settle.

After the review, at `ee6f8ef`, the nested KWin 6.8.1 full suite passed: 2045/2045 checks, 154/154 run scenarios,
1 expected SKIP ([evidence](evidence/integration-host-kwin681-bugfix-ee6f8ef.json)). Unit tests: 604/604.

Left as known minor items (reported by the reviewers, not fixed):
- Moving a panel to the opposite edge shifts float rectangles by the panel's thickness (the B12 rule).
- A drag during the at most 750 ms float-restore wait is overwritten when the restore is written.
- adopt-native releases KWin's tile before an overflow is known.
- A hidden context waiting in `floatLayouts` could restore its float rectangles twice if its layout is switched
  away and back first.
- The scrolling view can jump once when the column holding it is dropped.
- The layer-shell bar hook (B06) does not see an exclusive-zone change without a frame change.
- Some older probes (`probes/persistence/cost`, `probes/timing/baseline.py`, `probes/baseline-upstream`)
  still use narrow dirty-tree pathspecs.
- `swap-move-layouts-L06` still uses the weaker tiling-only oracle after layout switches.

## Window motion (T31, ADR-023), nested KWin 6.8.1

At the owner's request T31 was reopened. Window motion ships as **Plastile Motion**, a separate scripted KWin effect
(`effect/`, id `plastile_motion`). It is disabled by default, installed by `tools/install.sh`, and released as
`dist/plastile_motion-<version>.zip`. It animates only the picture, a translate and scale of the window's current
texture, from the old frame to the new one. Plastile is unchanged: one immediate frame request per window, and
`animation` stays inert.

Nested results: branch `wf/motion`, KWin 6.8.1, OpenGL ES on the reference host's GPU, virtual backend at 60 Hz
([evidence](evidence/motion-T31.json); oracles: KWin frames, fixture configures, ScreenShot2 images).

- **Unit:** 21/21 (`tests/core/motion.test.ts`; 2 added in review, 3 in the bug hunt below).
- **Nested scenarios at `b1d4e03`:** `scenarios_motion.py`, 9/9 scenarios and 76/76 checks.
  - Swap: starts for the two moved windows only. Both end at the real frame 214 ms after the command, against a
    180 ms duration.
  - Ten ratio steps 25 ms apart (231 ms in all): one start and eight retargets per window, one end 186 ms after the
    last command.
  - The same configures reached every client with the effect on and off, and Plastile did the same work (one solve
    per command, 0 corrections).
  - Latency, effect on against off: command to configure p50 1.22 against 1.29 ms; command to
    `frameGeometryChanged` p50 2.6 against 3.1 ms.
  - Unloading, or disabling through kwinrc with a notification, 0.5 s into a 2 s animation: every window is drawn
    at its real rectangle 0.15 s later.
  - Not animated: drag, resize, maximize, fullscreen, a new window's placement, and the speed *Instant*.
  - A click lands on the real rectangle mid-animation.
  - Removing an output stops the running animations.
- **Full nested suite** at `209edcd` (the effect before the debug-formatting guard and the hit-test scenario):
  1967/1967 checks, 149/149 scenarios, 1 expected SKIP (`output-negative-origin-G02`). At `b1d4e03` (the branch head's code): 1971/1971 checks,
  150/150 scenarios, the same expected SKIP.
- **Adversarial review** (branch `wf/motion-review`, code at `233fd4f`, nested KWin 6.8.1):
  - Found and fixed: the scrolling layout's parked columns sit above the output (negative y). A column scrolled in
    or out logged `start`, but `AnimationEffect` ignores a negative `Position` coordinate, so its y jumped while x
    moved (on a lower output it would have flown in from below). Such changes now skip with `reason=offscreen`;
    columns that stay visible still slide.
  - Found and fixed: a scale change animated the re-fit of every window. `virtualScreenGeometryChanged` is now an
    output change (`reason=transition`).
  - New scenario `motion-edges-T31` (13 checks): scrolling, scale change, minimize/restore, desktop switch, keyboard
    quick tile, suspend/resume, close mid-animation. On the previous effect it failed 3 checks (scrolling twice,
    scale); it passes now.
  - Full nested suite at `233fd4f`: 1984/1984 checks, 151/151 scenarios, 1 expected SKIP
    (`output-negative-origin-G02`); the package and upgrade scenarios are included. `npm run check` 535/535.
  - Unchanged: `src/` differs from `a0d66a0` only in the `animation` error message.
- **CI:** KWin loads scripted effects only on hardware OpenGL. In both CI jobs (QPainter 6.7.5, llvmpipe 6.8.0) the
  motion scenarios are expected SKIPs, except `motion-package-T31`, which runs without its load checks. Observed on
  hosted run 40229452063 at `f43de02`: both jobs skipped the nine load-dependent scenarios with the
  `animationsSupported` reason and passed `motion-package-T31` (so the `KWin/Effect` package type is present).
  Ubuntu 1679/1679; the provisional 6.8 job failed only the known KWin 6.8.0 Q09 RSS checks.
- **Open, physical only:**
  - smoothness at 144, 100 and 60 Hz;
  - perceived lag of the picture behind input;
  - stretched content with real applications;
  - GPU cost.

  P6 runs with the effect off unless a block is labelled "motion on"
  ([PERFORMANCE §6.1](../validation/PERFORMANCE.md#61-the-motion-effect-in-latency-measurements)).

## Outstanding failures

| Item | Where | State |
|---|---|---|
| `reload-Q09` and `persist-reload-cycles-Q09`: KWin RSS sometimes grows 20–35 MiB over 100 reloads (bound 16 MiB) | KWin 6.8.0 Nix only (6.7.5: +0.5 MiB) | **KWin 6.8's own allocation, not Plastile:** the same 100 reloads of an *empty* script grew KWin by 45–77 MiB in 7 of 14 reps; Plastile's worst of 14 interleaved reps was 40 MiB. The growth is heap (anonymous pages), not renderer buffers ([evidence](evidence/q09-kwin68-control.json)). A bisect over 9 commits found no regression. The bound is unchanged and the 6.8 job stays provisional |

## Fixed recently

- **Panels that change only their exclusive zone** (plasmashell auto-hide, *dodge windows*) left tiles in the old
  area: the panel keeps its frame and KWin emits no work-area signal. Docks now also feed `hiddenChanged` and
  `damaged` into the area comparison (`a254d64`; `plasmashell-panels-O07`, adapter test).
- **`persist-no-qtcore-Q05` on KWin 6.8 Nix** (a test-environment issue: nixpkgs puts
  `NIXPKGS_QT6_QML_IMPORT_PATH` above the standard variables): the scenario follows the sandbox's exec chain to
  the Qt wrapper (`aa9793a`) and passes in CI ([evidence](evidence/q09-kwin68-control.json)).

## Measurements

Nested only; none is a physical input-to-photon measurement.

- Ratio command, dispatch to last frame request, 32 windows: p95 1.24 ms, p99 1.39 ms; pure solve p95 0.21 ms
  ([perf-p03-nested](evidence/perf-p03-nested.json), 300 samples per cell: p99 indicative only).
- Persistence save: 1.6–3.6 ms p50, up to 7.85 ms p99 per save, off the command path
  ([persistence-t27-cost](evidence/persistence-t27-cost.json)).
- Reload cycles on 6.7.5: steady connection and window counts, one shortcut per command, RSS +0.5 MiB over 100
  cycles, no idle work (`reload-Q09`, `suspend-idle-C14`).

## Next tasks

1. Physical, now on KWin 6.8.1 (the reference desktop updated; build `0a0798c` installed and loaded after a re-login on 2026-10-25). Done: windows that open maximized (ADR-021): at login 5 restored windows were un-maximized and tiled and 1 kept (no free slot, by design); a new kitty tiled and settled with 0 corrections, but it did not open maximized this time, so the owner's usual launch path is not yet re-checked. P8a soak during normal use, 1 h (the owner shortened it from 4 h): connections grew by exactly 17 per tracked window and were flat at a constant window count, at a constant 10 windows (4 samples, 30 min) KWin RSS 459,616 → 449,604 → 452,180 → 451,692 KiB, no upward trend (range 9.8 MiB), errors 0 ([evidence](evidence/physical-recheck-20261025.json)). Waiting for the owner to be away from the machine: the hidden-desktop panel case (P3, `a5642dd`) and P6 at 100 Hz with P00-switch-tiled. Raw results stay in `artifacts/physical/recheck-20261025/`. On 2026-10-26, with the owner's go-ahead, `58614e5` (the bug-hunt fixes) was installed (`tools/install.sh upgrade`, `install-helper`); after the owner restarted the session (the machine booted at 07:40) KWin and the helper started after the install, so they run the installed files (inferred from start times; the `started 0.1.0` line cannot tell builds apart), the script and Plastile Motion are loaded, a saved layout was restored, and the journal holds no Plastile error, only the known `Meta+Ctrl+S` conflict (physical, read-only checks; [evidence](evidence/physical-install-58614e5-20261026.json)). The fixes have not been exercised by a test on the desktop; the owner uses it normally.
2. Done: QV4 `for...of` deletion audit (ADR-022). Five loops could skip an entry when a host read re-keyed an output mid-walk (identical second monitor); fixed, each fix proven to fail when reverted in QV4 (`qml` tool, not KWin), and `tools/itercheck.ts` now fails the build on `for...of`/`next()`/`yield*`/`Array.from(…, fn)` over a non-array in `src/`. Command-path A/B: no change beyond noop outer p50 0.346→0.359 ms (nested; [evidence](evidence/qv4-iteration-perf.json)). Open: whether KWin ever delivers that first key lookup inside a loop needs two identical monitors (physical). Optional: the adapter's per-write allocations (outer p99 1.1–1.6 ms). Done on `wf/rekey`: the adapter's queries no longer re-key the engine. New keys are staged and committed on the adapter's deferred turn or at `screensChanged`, with the same renames in the same order. The final state is the same as before in nine event orders and a two-stage re-key (unit; the review added the two-stage tests after a mutation check found staged-order bugs undetected) and in the QV4 scenarios ([evidence](evidence/output-rekey-convergence.json)). CI's `native-tools` job now runs the QV4 tests with `PLASTILE_REQUIRE_QV4=1` (hosted run 39300522170: 17/17, skipped 0).
3. Physical: merged to main as `f43de02` (disabled by default) and installed, disabled, in the owner's home on 2026-10-25 (`tools/install.sh install-effect`). Physical (owner, 2026-10-25): the owner enabled Plastile Motion in System Settings (kwinrc `plastile_motionEnabled=true`, `isEffectLoaded` true) and reported "Tried it works". No per-refresh-rate judgement, lag or GPU measurement was reported, so those stay open. P6 runs from now on are "motion on" unless the effect is turned off for the whole run.
4. The open rows of the [G3 checklist](G3_CHECKLIST.md); owner decisions: licence (ADR-012), scrolling/zones (ADR-014), P2d/P2e.
5. Alpha 0.1.0 ([checklist §6](G3_CHECKLIST.md#6-alpha-before-g3), [draft release notes](../release/0.1.0-alpha.md)): the docs now declare KWin 6.7 and 6.8 with their evidence, and `tools/release.py --check` builds the three files reproducibly at `58614e5`. Blocked on the licence (ADR-012); then the ADR-014 decision and some days of normal use of `58614e5` before tagging.

## Conventions

- `artifacts/` holds raw local results (may contain private metadata) and is never committed;
  `docs/status/evidence/` holds redacted summaries.
- Every probe and scenario runs in its own disposable nested KWin through `tools/nested.py`; nothing connects to,
  replaces or restarts the user's compositor.
- Build: `npm ci && npm run check`; `make -C fixtures/client && make -C fixtures/xclient && make -C tools/input`; integration:
  `python3 tests/integration/run.py`.
