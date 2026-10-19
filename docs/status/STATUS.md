# Implementation status

**Product state:** a working automatic tiler, packaged as a KWin 6 declarative script (`package/`) with a
TypeScript core (`src/`). It is a **release candidate in preparation, not a release**: everything below was
validated in unit/replay tests and in disposable nested KWin sessions, and the [physical runbook](../validation/PHYSICAL_RUNBOOK.md)
has run on one desktop at build `97fec4a` (results below). Gate G3 is open: see the [G3 checklist](G3_CHECKLIST.md).

Updated 2026-10-19 at `main` (see `git log`). [HANDOFF](HANDOFF.md) has the working context for the next
agent; this file is the short status.

## Tested environments and last results

| Layer | Environment | Last result |
|---|---|---|
| Unit/replay | Node 26 (`node --test tests/core/*.test.ts`), mock host and fake KWin, replay fixtures recorded from nested KWin (`tests/fixtures/replay/`) | 517/517 (`main` at `cf5fe36`), including QV4-vs-V8 iteration scenarios run in the `qml` tool (Qt 6.12.0) where installed. CI's core job has no Qt and skips them; the `native-tools` job now runs them with `PLASTILE_REQUIRE_QV4=1` (hosted run 39300522170: 17/17, skipped 0) |
| Nested, virtual backend | Reference host: Arch Linux, KWin 6.7.5, Qt 6.12.0, KF 6.30.0 ([ENVIRONMENT](ENVIRONMENT.md)) | `3297b6d` (`wf/rekey-review`): 1897/1897 checks, 141/141 scenarios, 1 expected SKIP ([evidence](evidence/integration-host-3297b6d.json)); earlier `521eb6c` (`wf/rekey`, [evidence](evidence/integration-host-521eb6c.json)) and `eb23093`, the same counts ([evidence](evidence/integration-host-eb23093.json)) |
| Nested, virtual backend (CI) | Ubuntu 26.10 sandbox: KWin 6.7.5, Qt 6.11.2, KF 6.29.0, QPainter compositing | `cf5fe36`: 1664/1664 checks, 128/128 scenarios, 4 expected SKIPs (run 39300522170). Red from `97fec4a` to `eca2df5`: the fake OSD needed PyGObject, missing from the image, and one maximized-open race check did not reproduce there; both fixed in `459bae8` |
| Nested, virtual backend (CI, provisional) | Nix: KWin 6.8.0, Qt 6.11.2, KF 6.30.0, llvmpipe | `5229536`: 1619/1619 checks, 125/125 scenarios, 5 expected SKIPs (run 39232013184). At `459bae8` the two `Q09` RSS bounds failed (run 39219911863); they fail in some runs only. At `e5ffed1` and `2eb05dd` `package-upgrade-bindings-T26-T32` failed once each: KWin 6.8's tile manager saved its default `[Tiling]` layout to kwinrc while `install.sh` ran (1 of 10 looped runs on a diagnostic branch); the check now names changed keys and leaves KWin's own `[Tiling]` groups out (`4f859a0`, passed on 6.8 in run 39290027258, where only `reload-Q09` failed). `workarea-hidden-desktop-O07` expects 6.8 to leave hidden windows in place (6.8 removed `checkWorkspacePosition`'s strut confinement). Stays provisional: its RSS checks fail in some runs on KWin 6.8's own heap growth (below) |
| Nested, windowed on the real GPU | Reference host: nested KWin 6.7.5's outputs are windows on the live compositor (`PLASTILE_NESTED_HOST_DISPLAY`), OpenGL on the real GPU, 144 Hz host output; private bus, config and XDG dirs | Latency kit at full protocol (30,000 taps): every Plastile workload `pass` against its matched baseline; 19/19 chords delivered; real apps, real `plasmashell` panels, GL tile editor pass ([runbook §1](../validation/PHYSICAL_RUNBOOK.md#1-what-was-validated-where)). Labelled `nested-windowed-gpu`, never physical |
| Physical session | Reference desktop (KWin 6.7.5, HDMI-A-1 144 Hz, DP-2 100 Hz, DP-1 60 Hz, scale 1), runbook with the owner's consent, installed build `97fec4a` | P0, P1, P2a–c, P3, P4, P5, P7, P8b idle pass; P8a soak 3.83 h unattended: no growth (KWin RSS +4 KiB, connections 175, errors 0) but no window activity, so the normal-use soak is open ([evidence](evidence/physical-runbook-20261018.json)). **P6 latency** (5 × 1000 samples per workload): 60 Hz pass for every Plastile workload; 144 Hz swap pass, **ratio fail** (+11.5 ms median vs quick tile, the difference is in KWin's commit→present of resized windows; Plastile's input→configure is 0.6 ms) and **focus fail** (+10.3 ms vs KWin's window switch). The focus gap is mostly the Aurorae decoration's re-render on activation, which grows with window area: P00-switch ran on KWin's 400×300 placement, P03-focus on Plastile's tiles; in nested KWin a script activation costs the same as KWin's own and Plastile adds under 0.1 ms ([PERFORMANCE §5.1](../validation/PERFORMANCE.md#51-focus-activation-cost-depends-on-the-decoration-and-window-size)); a 1.2 ms residual at equal area is open, and the kit now has a P00-switch-tiled control. 100 Hz incomplete (re-run pending). Plastile did one solve per command, no corrections, and 0 solves/writes for 10,500 focus commands. Found and fixed: a hidden-desktop window diverged on a panel change (`a5642dd`). The owner's kitty opens maximized and was left suspended: windows that open maximized are now un-maximized and tiled (ADR-021, `0a371c9`, nested only). Open: physical re-check of `a5642dd` and ADR-021 (needs a re-login), a soak with normal use, P2d/P2e skipped by the owner. Earlier: the owner's laptop (eDP-1, scale 1.35), by hand ([evidence](evidence/physical-first-run-20261018.json)) |

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
| Closed as deferred | T31 (ADR-018) |
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

1. Physical: after the owner's re-login, re-check the hidden-desktop panel case (P3) and windows that open maximized; re-run P6 at 100 Hz with P00-switch-tiled; a soak during normal use (P8a).
2. Done: QV4 `for...of` deletion audit (ADR-022). Five loops could skip an entry when a host read re-keyed an output mid-walk (identical second monitor); fixed, each fix proven to fail when reverted in QV4 (`qml` tool, not KWin), and `tools/itercheck.ts` now fails the build on `for...of`/`next()`/`yield*`/`Array.from(…, fn)` over a non-array in `src/`. Command-path A/B: no change beyond noop outer p50 0.346→0.359 ms (nested; [evidence](evidence/qv4-iteration-perf.json)). Open: whether KWin ever delivers that first key lookup inside a loop needs two identical monitors (physical). Optional: the adapter's per-write allocations (outer p99 1.1–1.6 ms). Done on `wf/rekey`: the adapter's queries no longer re-key the engine. New keys are staged and committed on the adapter's deferred turn or at `screensChanged`, with the same renames in the same order. The final state is the same as before in nine event orders and a two-stage re-key (unit; the review added the two-stage tests after a mutation check found staged-order bugs undetected) and in the QV4 scenarios ([evidence](evidence/output-rekey-convergence.json)). CI's `native-tools` job now runs the QV4 tests with `PLASTILE_REQUIRE_QV4=1` (hosted run 39300522170: 17/17, skipped 0).
3. The open rows of the [G3 checklist](G3_CHECKLIST.md); owner decisions: licence (ADR-012), scrolling/zones (ADR-014), P2d/P2e.

## Conventions

- `artifacts/` holds raw local results (may contain private metadata) and is never committed;
  `docs/status/evidence/` holds redacted summaries.
- Every probe and scenario runs in its own disposable nested KWin through `tools/nested.py`; nothing connects to,
  replaces or restarts the user's compositor.
- Build: `npm ci && npm run check`; `make -C fixtures/client && make -C fixtures/xclient && make -C tools/input`; integration:
  `python3 tests/integration/run.py`.
