# Plastile

A fast, predictable, configurable tiling layer for KDE Plasma 6 that keeps KWin as the window manager. It is
a KWin declarative script with a TypeScript core: master/stack, BSP, monocle and floating layouts; validated
configuration and rules; keyboard commands; session persistence; an explain view. Scrolling and manual zones
exist as experimental opt-in layouts (ADR-014). Plastile places windows at once; an optional, separate KWin
effect, Plastile Motion (`effect/`, off by default, ADR-023), can animate how windows slide into place, drawing
only: tested in nested KWin 6.8.1, not yet on a physical display.

**Status: release candidate, not a qualified release.** It is tested by unit/replay tests and in disposable
nested KWin sessions (KWin 6.7.5 on the reference machine and in CI; KWin 6.8.0 only in a provisional CI job
with open failures), and by a physical-session runbook on one desktop (KWin 6.7.5, build `97fec4a`). That
runbook is not complete: input-to-visible latency passes at 60 Hz but fails for two workloads at 144 Hz and is
incomplete at 100 Hz, the soak so far covered an idle session only, the owner skipped the unplug and suspend checks, and later
builds have not run physically. Nested numbers are labelled as nested, physical numbers as physical. The open
gates are in the [G3 checklist](docs/status/G3_CHECKLIST.md); results and failures in
[STATUS](docs/status/STATUS.md).

- Users: [install](docs/user/INSTALL.md), [configuration](docs/user/CONFIGURATION.md),
  [shortcuts](docs/user/SHORTCUTS.md), [troubleshooting](docs/user/TROUBLESHOOTING.md).
- Developers: `npm ci && npm run check`, then `python3 tests/integration/run.py` (nested KWin; never touches
  your running compositor). [HANDOFF](docs/status/HANDOFF.md) has the working context.
- Licence: not decided yet (ADR-012). Nothing is to be distributed until it is.

## Start here

1. [Agent entry point](docs/START_HERE.md): reading order, first actions, and completion rules.
2. [Implementation roadmap](docs/implementation/ROADMAP.md): milestones, dependencies, decision gates, and deliverables.
3. [Implementation backlog](docs/implementation/BACKLOG.md): work packages with acceptance tests.
4. [Ready-to-use agent instruction](docs/implementation/AGENT_PROMPT.md).

## Research

- [State of the art and project-by-project source analysis](docs/research/STATE_OF_THE_ART.md).
- [How KWin and Plasma actually implement window management](docs/research/KWIN_INTERNALS.md).
- [Pinned source index and research limitations](docs/research/SOURCE_INDEX.md).
- [Machine-readable acquisition manifest](docs/research/sources.lock.json).

## Design

- [Architecture and runtime contracts](docs/design/ARCHITECTURE.md).
- [Window behavior specification](docs/design/BEHAVIOR_SPEC.md).
- [Configuration and command interface](docs/design/CONFIGURATION.md).
- [Architecture decision records](docs/design/DECISIONS.md).

## Validation

- [Performance methodology and latency budgets](docs/validation/PERFORMANCE.md).
- [Correctness and compatibility test matrix](docs/validation/TEST_MATRIX.md).
- [Open questions, experiments, and risk register](docs/validation/OPEN_QUESTIONS.md).

The implementation is a TypeScript layout/policy core running inside a declarative KWin script. A narrow adapter owns geometry and KWin object lifetimes. Geometry is placed directly; the native-tile comparison prototype was measured and rejected at gate G1 (ADR-003). Native C++ integration remains an evidence-gated alternative, not assumed to be faster merely because it is compiled.

Priorities, in order: desktop correctness and responsiveness; predictable interaction; measured low latency; configuration; additional layouts and visual features. The initial product is an automatic tiler with master/stack, BSP, monocle, and floating behavior; scrolling (M8) and manual zones (M9) are experimental opt-ins.

Research date: **17 October 2026**. Fourteen upstream repositories were sampled, including all eleven tiling projects discussed, KWin, i3, and bspwm. KWin development and the Plasma/6.7 and Plasma/6.8 branches were inspected separately. Two Codeberg homes were inaccessible; their pinned GitHub snapshots are explicitly identified as potentially stale. See the source index before interpreting maintenance or compatibility claims.

Run the documentation integrity check with:

```sh
python3 tools/check_docs.py
```

Read [AGENTS.md](AGENTS.md) before implementing anything.
