# Implementation status

**Product state:** a working automatic tiler, packaged as a KWin 6 declarative script (`package/`) with a
TypeScript core (`src/`). It is a **release candidate in preparation, not a release**: everything below was
validated in unit/replay tests and in disposable nested KWin sessions. **A physical Plasma session has run it only
once, by hand (part of P0/P1).** Gate G3 stays open until the [physical runbook](../validation/PHYSICAL_RUNBOOK.md) has been run.

Updated 2026-10-18 at `main` (see `git log`). [HANDOFF](HANDOFF.md) has the working context for the next
agent; this file is the short status.

## Tested environments and last results

| Layer | Environment | Last result |
|---|---|---|
| Unit/replay | Node 26 (`node --test tests/core/*.test.ts`), mock host and fake KWin, replay fixtures recorded from nested KWin (`tests/fixtures/replay/`) | 429/429 (`52314ed`) |
| Nested, virtual backend | Reference host: Arch Linux, KWin 6.7.5, Qt 6.12.0, KF 6.30.0 ([ENVIRONMENT](ENVIRONMENT.md)) | `52314ed`: 1759/1759 checks, 126/126 scenarios, 1 expected SKIP ([evidence](evidence/integration-host-52314ed.json)) |
| Nested, virtual backend (CI) | Ubuntu 26.10 sandbox: KWin 6.7.5, Qt 6.11.2, KF 6.29.0, QPainter compositing | `0652336`: 1527/1527 checks, 113/113 scenarios, 4 expected SKIPs (run 39141496877) |
| Nested, virtual backend (CI, provisional) | Nix: KWin 6.8.0, Qt 6.11.2, KF 6.30.0, llvmpipe | `0652336`: 1484/1484 checks, 110/110 scenarios, 5 expected SKIPs (run 39141496877). Stays provisional: its RSS checks fail in some runs on KWin 6.8's own heap growth (below) |
| Nested, windowed on the real GPU | Reference host: nested KWin 6.7.5's outputs are windows on the live compositor (`PLASTILE_NESTED_HOST_DISPLAY`), OpenGL on the real GPU, 144 Hz host output; private bus, config and XDG dirs | Latency kit at full protocol (30,000 taps): every Plastile workload `pass` against its matched baseline; 19/19 chords delivered; real apps, real `plasmashell` panels, GL tile editor pass ([runbook §1](../validation/PHYSICAL_RUNBOOK.md#1-what-was-validated-where)). Labelled `nested-windowed-gpu`, never physical |
| Physical session | Owner's laptop: Arch, KWin 6.7.5, Qt 6.12.0, eDP-1 2256×1504 @ 60 Hz, scale 1.35, at `d7445d8` | First run by hand (part of P0/P1): installs, registers 68 shortcuts with no conflict, places windows, persistence active across a re-login; the owner could not tell monocle from a dead tiler ([evidence](evidence/physical-first-run-20261018.json)). Runbook P0–P8 **not run** |

Expected SKIPs: `output-negative-origin-G02` (KWin normalizes output origins, so a negative origin cannot
occur); `native-editor-toggle-L14` only where compositing is QPainter (the tile editor is GL-only);
`plasmashell-panels-O07` and `settings-dialog-T28` in CI (no plasmashell or kcmshell6 in the sandbox images; both run on the reference host).

## Gates

| Gate | State |
|---|---|
| G0 (APIs and measurement viable) | Passed, nested ([M0 report](M0_PROBE_REPORT.md), [API profile](API_PROFILE.md)) |
| G1 (backend decision) | Passed, nested: direct geometry (ADR-003) |
| G2 (integration and performance) | **Open.** Integration passes on 6.7.5; no G2 report yet (`wip/perf-g2`). The P05 burst corrections were a ledger defect fixed in `d6d0de4` ([evidence](evidence/p05-burst-diagnosis.json)) |
| G3 (release) | **Open**: physical session, G2 report, release checklist, licence (ADR-012, owner decision) |

## Tasks

Verdicts from a card-by-card audit against each acceptance text (2026-10-18), updated for the work since.
"Nested" means a nested KWin scenario; "unit" means unit/replay only. Physical clauses are open everywhere.

| State | Tasks |
|---|---|
| Complete (nested evidence) | T00–T03, T05, T08, T10, T13–T16, T18, T19, T22–T25, T27 (helper, ADR-020), T28 (no live preview: ADR-019), T29, T30 |
| Complete (unit/replay evidence) | T09, T11, T12, T17, T21 |
| Closed as deferred | T31 (ADR-018) |
| Superseded by G1 | T06, T07 (native spike; ADR-003) |
| Partial | T04 (raw upstream samples not committed; below 5000 samples), T20 (no G2 report), T26 and T32 (no release-to-release upgrade yet: the old side is a past commit relabelled), T33 (6.8 job provisional: RSS noise), T34 (no G2 protocol run; 6.8 RSS), T35 (no G3 checklist; licence), T36/T37 (experimental, ADR-014) |

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

1. Persistence helper (T27 rework).
2. G2 report (T20/T34), measured with nothing else running.
3. Remaining partial clauses above; G3 checklist (T35); physical runbook with the owner's consent.

## Conventions

- `artifacts/` holds raw local results (may contain private metadata) and is never committed;
  `docs/status/evidence/` holds redacted summaries.
- Every probe and scenario runs in its own disposable nested KWin through `tools/nested.py`; nothing connects to,
  replaces or restarts the user's compositor.
- Build: `npm ci && npm run check`; `make -C fixtures/client && make -C fixtures/xclient && make -C tools/input`; integration:
  `python3 tests/integration/run.py`.
