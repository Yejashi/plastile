# Plastile

An implementation blueprint for a fast, predictable, configurable tiling layer for KDE Plasma.

**Repository status:** research and implementation plans, plus M0 environment/capability probes and measurement tooling (see [implementation status](docs/status/STATUS.md)). No tiler has been implemented, installed, or benchmarked yet. Performance budgets in the plans are acceptance targets, not measured Plastile results.

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

The proposed initial implementation is a TypeScript layout/policy core running inside a declarative KWin script. A narrow adapter owns geometry and KWin object lifetimes. It starts with direct geometry placement; a small native-tile comparison prototype is required before that backend decision is frozen. Native C++ integration is an evidence-gated alternative, not assumed to be faster merely because it is compiled.

Priorities, in order: desktop correctness and responsiveness; predictable interaction; measured low latency; configuration; additional layouts and visual features. The initial product is an automatic tiler with master/stack, BSP, monocle, and floating behavior. Scrolling and manual zones have separate later milestones.

Research date: **17 October 2026**. Fourteen upstream repositories were sampled, including all eleven tiling projects discussed, KWin, i3, and bspwm. KWin development and the Plasma/6.7 and Plasma/6.8 branches were inspected separately. Two Codeberg homes were inaccessible; their pinned GitHub snapshots are explicitly identified as potentially stale. See the source index before interpreting maintenance or compatibility claims.

Run the documentation integrity check with:

```sh
python3 tools/check_docs.py
```

Read [AGENTS.md](AGENTS.md) before implementing anything.
