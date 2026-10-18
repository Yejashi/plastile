# Implementation status

**Product state:** a working automatic tiler, packaged as a KWin 6 declarative script (`package/`) with a
TypeScript core (`src/`). It is a **release candidate in preparation, not a release**: everything below was
validated in unit/replay tests and in disposable nested KWin sessions. **No physical Plasma session has run
it.** Gate G3 stays open until the [physical runbook](../validation/PHYSICAL_RUNBOOK.md) has been run.

Updated 2026-10-18 at `main` (see `git log`). [HANDOFF](HANDOFF.md) has the working context for the next
agent; this file is the short status.

## Tested environments and last results

| Layer | Environment | Last result |
|---|---|---|
| Unit/replay | Node 26 (`node --test tests/core/*.test.ts`), mock host and fake KWin | 384/384 |
| Nested, virtual backend | Reference host: Arch Linux, KWin 6.7.5, Qt 6.12.0, KF 6.30.0 ([ENVIRONMENT](ENVIRONMENT.md)) | `67772ee`: 990/990 checks, 99/99 scenarios, 1 expected SKIP ([evidence](evidence/integration-host-67772ee.json)) |
| Nested, virtual backend (CI) | Ubuntu 26.10 sandbox: KWin 6.7.5, Qt 6.11.2, KF 6.29.0, QPainter compositing | `67772ee`: 807/807 checks, 88/88 scenarios, 2 expected SKIPs (run 39109880796) |
| Nested, virtual backend (CI, provisional) | Nix: KWin 6.8.0, Qt 6.11.2, KF 6.30.0, llvmpipe | `67772ee`: 773/778 checks, 84/87 scenarios; failures below |
| Nested, windowed on the real GPU | Reference host, nested KWin's outputs shown as windows on the live compositor (`PLASTILE_NESTED_HOST_DISPLAY`); private bus, config and XDG dirs | In progress; labelled `nested-windowed-gpu`, never physical |
| Physical session | [Runbook](../validation/PHYSICAL_RUNBOOK.md) P0–P8 | **Never run** |

Expected SKIPs: `output-negative-origin-G02` (KWin normalizes output origins, so a negative origin cannot
occur); `native-editor-toggle-L14` only where compositing is QPainter (the tile editor is GL-only).

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
| Complete (nested evidence) | T00–T03, T05, T08, T13–T15, T18, T23, T25, T27 (6.7.5), T29, T30 |
| Complete (unit/replay evidence) | T09, T11, T12, T17, T21 |
| Closed as deferred | T31 (ADR-018) |
| Superseded by G1 | T06, T07 (native spike; ADR-003) |
| Partial | T04 (raw upstream samples not committed; below 5000 samples), T10 (no recorded-fixture replay directory), T16 (dialogs following parent visibility), T19 (resume/reconcile with missed events unit-only), T20 (no G2 report), T22 (no unload-in-monocle check), T24 (no per-send reflow count), T26 (rebinds across a package update), T28 (no live preview: ADR-019; settings dialog never clicked through), T32 (no version-to-version upgrade test), T33 (6.8 job red), T34 (no G2 protocol run; 6.8 RSS), T35 (no G3 checklist; licence), T36/T37 (experimental, ADR-014) |

## Outstanding failures

| Item | Where | State |
|---|---|---|
| `reload-Q09` and `persist-reload-cycles-Q09`: KWin RSS grows 26–28 MiB over 100 reloads (bound 16 MiB) and 12.6 MiB over 20 (bound 8 MiB) | KWin 6.8.0 only (6.7.5: +0.5 MiB) | Reproduced in two CI runs; absent at `ae4061a`, present from `81b57e2`. Bisect running on branch `ci/q09-bisect` |
| `persist-no-qtcore-Q05`: the QtCore shadow does not take effect | KWin 6.8.0 Nix only | Test-environment issue (nixpkgs adds `NIXPKGS_QT6_QML_IMPORT_PATH` above the standard variables); the first fix did not find a wrapper; diagnostics running |

## Measurements

Nested only; none is a physical input-to-photon measurement.

- Ratio command, dispatch to last frame request, 32 windows: p95 1.24 ms, p99 1.39 ms; pure solve p95 0.21 ms
  ([perf-p03-nested](evidence/perf-p03-nested.json), 300 samples per cell: p99 indicative only).
- Persistence save: 1.6–3.6 ms p50, up to 7.85 ms p99 per save, off the command path
  ([persistence-t27-cost](evidence/persistence-t27-cost.json)).
- Reload cycles on 6.7.5: steady connection and window counts, one shortcut per command, RSS +0.5 MiB over 100
  cycles, no idle work (`reload-Q09`, `suspend-idle-C14`).

## Next tasks

1. Root-cause the KWin 6.8 RSS growth from the bisect; fix Q05's environment detection.
2. Finish the windowed real-GPU runs (latency kit, chord delivery, panels with a real `plasmashell`, real
   applications, idle) and record them as `nested-windowed-gpu`.
3. G2 report from `wip/perf-g2` on a quiet machine.
4. Remaining partial-task tests listed above; G3 checklist; physical runbook with the owner's consent.

## Conventions

- `artifacts/` holds raw local results (may contain private metadata) and is never committed;
  `docs/status/evidence/` holds redacted summaries.
- Every probe and scenario runs in its own disposable nested KWin through `tools/nested.py`; nothing connects to,
  replaces or restarts the user's compositor.
- Build: `npm ci && npm run check`; `make -C fixtures/client && make -C fixtures/xclient && make -C tools/input`; integration:
  `python3 tests/integration/run.py`.
