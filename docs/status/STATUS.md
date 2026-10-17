# Implementation status

**Product state:** no tiler exists yet. The repository contains M0 environment/capability probes, a controlled client fixture, and measurement tooling. Nothing here is a release, and nothing is a performance claim about Plastile.

| Field | Value |
|---|---|
| Current milestone | M0 complete at the nested layer; G0 passed for nested KWin, physical gates open |
| Completed tasks | **T00**, **T01**, **T02**, **T03** (each with nested-KWin evidence) |
| Partially complete | **T04**: nested no-tiler P01/P02 baselines done. Open: upstream tiler baseline, physical-session baseline |
| Tested environment | KWin 6.7.5 (tag `ab7df7cc`), Qt 6.12.0, KF 6.30.0, Arch Linux, Linux 7.2.9, RX 9070 XT / Mesa 26.2.4 ([ENVIRONMENT](ENVIRONMENT.md)) |
| Test layers used | nested `kwin_wayland --virtual` only. **No probe has run in the physical session.** |
| Reports | [M0 probe report](M0_PROBE_REPORT.md), [script API profile](API_PROFILE.md) |
| Raw results | `artifacts/` (local, gitignored). Committed summaries and redacted raw data are in [evidence/](evidence/) |
| Next eligible task | **T05** (direct geometry spike), then **T06** (native tile spike). T07/G1 additionally needs the T04 remainder |

## Decisions and findings that bind M1

- **Mandatory connection registry.** Plain closures connected to `Workspace` signals survive unload (measured).
- **Ledger must handle reversal.** With B outstanding, a return-to-A frame request is dropped by KWin when A equals the committed size, so the window settles at B (E04 measured). The ledger needs outstanding-request tracking and a bounded correction.
- **Re-entrancy is real.** Position-only writes re-enter the apply loop synchronously. Resizes are asynchronous.
- **Tolerance-based comparison.** Geometry is floating point.
- **Pre-clamping is the solver's job.** KWin does not clamp to `minSize`, which is in client coordinates.
- **Release quick-tile ownership explicitly.** Native quick-tile is a `window.tile` association that a direct write does not clear; use `unmanage`.
- **Conservative TypeScript output.** QV4 rejects class fields, object spread, `async`, `??=` and BigInt, and lacks `Array.flat/at`, `Object.fromEntries` and `globalThis`.
- **No ADR changes.** The native measurement module and C fixture are test-only, as T03 permits. ADR-003 (backend) stays provisional until G1.

## Outstanding / open gates

| Item | Why open | What closes it |
|---|---|---|
| Physical-session checks: input-to-visible latency, panels and work area, real 60/100/144 Hz outputs, activities | Needs the user's live session. The capability probe's `ShortcutHandler` would also leave a `kglobalshortcutsrc` entry there | User-approved read-only run of the capability probe in the live session, then physical latency tooling |
| Upstream automatic-tiler baseline (T04) | Not installed. Third-party code would run only in nested sessions | Install the pinned Polonium in a nested session, run the same P01-equivalent workload |
| E02 Codeberg refresh | Not attempted | Fetch the current Krohnkite/Fluid Tile refs, add an addendum |
| E07 XWayland hints, E08 activities, E16 output replug, interactive move/resize | Not exercised | T18 / T24 / T30; needs XWayland, Activities and input-injection experiments |
| Long-session heap/object trend | RSS only so far | T34 |
| Post-start package discovery | Inference only | T32 |

## Known failures

None outstanding in the probes. The defects found while building them were fixed and re-run:

- partial-line log reads in the harness;
- workload mislabelling (P02 was position-only, then a no-op);
- a summary key bug.

## Conventions

- `artifacts/<area>/<timestamp>/` holds raw local results, which may contain private metadata. Never commit it.
- `docs/status/evidence/` holds redacted summaries and small reproducible raw files: fixture-only window data, virtual outputs, relative paths.
- Each probe runner starts its own disposable nested KWin through `tools/nested.py`. No probe connects to, replaces or restarts the user's compositor.
- Rebuild prerequisites: `make -C fixtures/client` and `cmake -S tools/measure -B build/measure && cmake --build build/measure`.
