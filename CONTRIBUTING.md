# Contributing to Plastile

Thanks for your interest! Bug reports, test results from setups we haven't seen, documentation fixes and code
are all welcome. This page covers how to set up, how to test, and the few rules every change has to follow.

By contributing you agree that your contribution is licensed under the project's licence,
[GPL-3.0-or-later](LICENSE).

## Ways to help without writing code

- **Try it on your setup** and [report what happens](https://github.com/Yejashi/plastile/issues/new/choose),
  good or bad. Plastile has been run physically on very few machines; reports from other KWin versions, GPUs,
  monitor layouts, HiDPI, VRR, laptops (suspend, docking) and unusual applications are valuable.
- **Improve the docs** in [docs/user/](docs/user/README.md). If something confused you, it will confuse others.

## Development setup

You need Node.js 26 (CI pins it; the tests run the TypeScript sources directly), npm and Python 3. A Plasma 6
Wayland session is only needed to try the result.

```sh
git clone https://github.com/Yejashi/plastile.git
cd plastile
npm ci
npm run check        # type check (strict), unit and replay tests, bundle
```

`npm run build` writes `package/contents/code/plastile.mjs` (not committed). Install your build into your own
session with `tools/install.sh install` (or `upgrade`), then **log out and back in**: KWin keeps running the
version it loaded first.

## Repository layout

| Path | What it is |
|---|---|
| `src/core/` | The policy engine: layouts, commands, the geometry ledger. Pure TypeScript, no KWin. |
| `src/config/` | Configuration schema, validation and compilation. |
| `src/adapters/kwin/` | The only code that touches KWin objects, and the only geometry writer. |
| `src/runtime/`, `src/persist/` | Wiring, shortcuts, the inspector, saved preferences. |
| `package/` | The KWin script package (QML entry point, settings dialog, KConfig schema). |
| `effect/` | Plastile Motion, the optional animation effect. |
| `helper/` | `plastile-state`, the optional D-Bus persistence helper (C++/Qt). |
| `tests/core/` | Unit and replay tests (Node, mock and fake KWin hosts). |
| `tests/integration/` | Scenarios that run in nested KWin sessions. |
| `fixtures/` | Controlled Wayland and X11 test clients for the nested suite. |
| `tools/` | Build, install, release, nested-session, sandbox and measurement tools. |
| `probes/` | One-off experiments and measurements behind design decisions. |
| `docs/` | User guide, design, decision records, validation and status ([map](docs/README.md)). |

## Testing

Plastile separates three layers, and results from one never stand in for another:

1. **Unit and replay** (`npm test`): fast, run anywhere. Every change needs these to pass.
2. **Nested KWin** (`python3 tests/integration/run.py`): each scenario starts a private
   `kwin_wayland --virtual` session with its own D-Bus bus, config and data directories, drives it with real
   input and reads window frames back from KWin. **It never touches your running desktop.** It needs KWin
   installed and a few fixtures built once:

   ```sh
   make -C fixtures/client && make -C fixtures/xclient && make -C tools/input
   cmake -S helper -B build/helper && cmake --build build/helper
   python3 tests/integration/run.py --list
   python3 tests/integration/run.py --only adopt-open-close,reload-Q09
   ```

   Changes to behaviour in `src/` should come with a scenario, or extend one, when they can be observed in
   KWin. [tools/sandbox](tools/sandbox/README.md) has a reproducible Ubuntu environment like the one CI uses.
3. **Physical session:** your real desktop. Report what you checked by hand in the pull request. The
   [physical runbook](docs/validation/PHYSICAL_RUNBOOK.md) is the full procedure.

Also run `python3 tools/check_docs.py` when you touch documentation (it checks every local link), and
`python3 tools/release.py --check` when you touch packaging.

CI runs the unit tests, the docs check, the reproducible-release check, native tool builds and the full nested
suite on KWin 6.7.5 and 6.8.0.

## Rules every change follows

These come from the project's [architecture](docs/design/ARCHITECTURE.md) and
[decision records](docs/design/DECISIONS.md); a pull request that breaks one will be asked to change.

- **One geometry writer.** All window geometry goes through the adapter's single coalesced flush. No second
  code path may set a window's frame or drive KWin's native tiles.
- **Desired, requested and observed geometry stay separate.** Window and context generations discard stale
  callbacks.
- **Nothing on the command path waits:** no fixed timers, synchronous D-Bus, file I/O or network. No idle
  polling; pointer polling only during an active drag, stopped on every exit path.
- **No file I/O on KWin's thread.** Persistence goes through the asynchronous helper.
- **Every signal, timer and overlay has a teardown path.** Connect through the adapter's owned-connection
  registry; `reload-Q09` checks 100 unload/reload cycles.
- **No `for…of` over a `Map`, `Set` or iterator in `src/`.** KWin's QV4 engine skips entries when one is deleted
  during iteration; the build rejects it (ADR-022). Use `forEach` or an array snapshot.
- **Respect the user and KWin:** explicit floating, maximize, fullscreen and native quick tiling win. Never
  fight an application indefinitely to force a rectangle.
- **Configuration is data.** No user JavaScript runs inside KWin.
- **Only script-visible KWin APIs**, confirmed against the installed KWin version
  ([API profile](docs/status/API_PROFILE.md)).
- **Original code.** Other tilers were studied, not copied. Do not paste code from other projects without
  discussing it first: licences differ.
- **Honest numbers.** A performance claim names its environment (unit, nested or physical), workload and clock.
  A Node timing never stands in for KWin, and a geometry signal is not a presented frame. See
  [PERFORMANCE](docs/validation/PERFORMANCE.md).

A change that departs from a recorded decision needs a new ADR in [DECISIONS.md](docs/design/DECISIONS.md)
with its evidence and consequences.

## Pull requests

- Keep each pull request to one change, and explain the behaviour change and how you tested it (which layers,
  which KWin version).
- Update the user documentation when behaviour, defaults or shortcuts change, and add a line under
  *Unreleased* in [CHANGELOG.md](CHANGELOG.md).
- Never commit private data: window titles, machine-specific paths or raw physical-session logs. Generated
  results go to `artifacts/` (ignored); only redacted summaries belong in `docs/status/evidence/`.

## AI coding agents

The repository is set up to be worked on by coding agents as well as people. [AGENTS.md](AGENTS.md) holds the
instructions they follow, and [docs/status/HANDOFF.md](docs/status/HANDOFF.md) the working context. The same
rules and review apply to their changes.
