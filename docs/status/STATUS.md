# Implementation status

**Product state:** no tiler exists yet. The repository contains M0 environment/capability probes and measurement tooling only. Nothing here is a release or a performance claim about Plastile.

| Field | Value |
|---|---|
| Current milestone | M0 (environment discovery, capability evidence) |
| Completed tasks | T00 |
| In progress | T01–T04 |
| Tested environment | KWin 6.7.5 (tag `ab7df7cc`), Qt 6.12.0, KF 6.30.0, Arch Linux, Linux 7.2.9 ([ENVIRONMENT](ENVIRONMENT.md)) |
| Test layers used | nested KWin (virtual backend) only; the physical session has **not** been used by any probe |
| Raw results | `artifacts/` (local, gitignored); committed summaries in [evidence/](evidence/) |
| Next eligible task | T01 |

## Conventions

- `artifacts/<area>/<timestamp>/` — raw local results, which may hold private metadata. Never committed.
- `docs/status/evidence/` — redacted summaries and small reproducible raw files: fixture-only window data, virtual outputs, relative paths.
- Each probe has a runner that starts its own disposable nested KWin through `tools/nested.py`. No probe connects to, replaces or restarts the user's compositor.
