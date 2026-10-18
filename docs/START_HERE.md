# Agent entry point

> **Continuing implementation?** Read [status/HANDOFF.md](status/HANDOFF.md) first: it describes the current code, branches, test results and next work. Measured nested results against the performance budgets, by scenario and environment, are in [status/G2_REPORT.md](status/G2_REPORT.md). `status/STATUS.md` and the root README are stale until rewritten.

## Mission

Implement a tiling layer that preserves KDE Plasma and KWin while making ordinary window management immediate, predictable, and configurable. The user gives performance and snappiness the highest priority. Interpret that as low and stable input-to-visible-response latency, bounded work in KWin, no geometry fights, no surprise focus movement, and no persistent idle work. It does not mean minimizing the layout function alone.

This repository deliberately supplies implementation instructions before code. Do not mistake pseudocode, proposed settings, budgets, or suggested file paths for existing APIs or a working implementation.

## Reading order

| Order | Document | Decision it supports |
|---|---|---|
| 1 | [Roadmap](implementation/ROADMAP.md) | What to build first and when to stop adding scope |
| 2 | [Decisions](design/DECISIONS.md) | Initial architecture and evidence required to change it |
| 3 | [KWin internals](research/KWIN_INTERNALS.md) | Correct API, coordinate, state, and resize semantics |
| 4 | [Architecture](design/ARCHITECTURE.md) | Module boundaries, scheduler, and geometry protocol |
| 5 | [Behavior](design/BEHAVIOR_SPEC.md) | Exact user-visible behavior and edge cases |
| 6 | [Configuration](design/CONFIGURATION.md) | Settings, precedence, rules, and command vocabulary |
| 7 | [Performance](validation/PERFORMANCE.md) | Measurement and release gates |
| 8 | [Test matrix](validation/TEST_MATRIX.md) | Scenarios, independent oracles, and integration layers |
| 9 | [Backlog](implementation/BACKLOG.md) | Concrete task cards and dependencies |
| 10 | [State of the art](research/STATE_OF_THE_ART.md) | Prior solutions, tradeoffs, and code reading map |

Keep [open questions](validation/OPEN_QUESTIONS.md) and [source index](research/SOURCE_INDEX.md) available throughout implementation.

## First implementation session

1. Inspect the repository and installed tooling. Record the current revision, OS, session type, KWin version, Qt version, available QML modules, output geometry/scales/refresh rates, effects, window rules, and whether a nested Wayland compositor is possible.
2. Create a status file and `artifacts/` convention for locally generated results; avoid committing private window titles or machine-specific secrets. Store public benchmark summaries and reproducible fixture data in the repository.
3. Implement the M0 capability probe, including script loading/unloading, shortcut registration, observing a test window, direct placement, native `rootTile` and `manage` availability, current desktop per output, and rectangle value conversion. Do not assume a function exists because an upstream `.d.ts` file mentions it.
4. Establish a no-tiler baseline and one comparable upstream baseline on the same machine. Test each tiler separately. Capture a minimal trace before any optimization.
5. Build the M1 prototype: two or three controlled windows, immediate command dispatch, one batched solve, geometry diffing, and complete unload. Compare direct geometry and native tile mutation on that exact workload.
6. Record the backend decision and its evidence. Then start the production core, lifecycle model, and layouts in the order in the roadmap.

## Initial scope and defaults

- Plasma 6 Wayland is the primary environment. Plan validation against the pinned 6.7 and 6.8 API families; the user's actual installed version must be discovered before claiming support. Earlier versions need a deliberate compatibility task.
- A declarative KWin script with a TypeScript core is the initial integration. Node is a build/test dependency, not a runtime service.
- Direct geometry is the provisional default backend. The native-tile comparison gate can select native tiles instead if it demonstrates better correctness/integration without unacceptable mutation overhead or ownership conflicts. Ship one default owner, not two competing writers.
- Master/stack first, then persistent BSP, monocle, and floating. Keyboard commands precede drag polish. Scrolling and manual zone editors are later, separately gated work.
- Geometry changes are instantaneous by default. Animation is optional and must not delay commands or drive a stream of real client resizes.
- Float dialogs, utility surfaces, fixed-size windows, and ambiguous multi-context windows by default. Preserve user preferences and restores.
- Configuration supports global settings, output/desktop/activity overrides, and ordered application rules. Validate and compile it outside hot paths.

## Evidence labels

Use these labels in implementation notes:

- **Observed source:** supported by a pinned file/function.
- **Upstream report:** a reporter's issue, not a reproduced defect or current-version verdict.
- **Inference:** a plausible consequence of an implementation, requiring measurement.
- **Proposal:** a Plastile design choice or target.
- **Measured:** includes fixture, versions, clock definition, repetitions, raw results, and uncertainty.

## Stop conditions for a milestone

Do not move on because the happy path looks good. Pause feature growth when window state loops, teardown leaks, missing capability checks, geometry oscillation, incorrect output selection, or unexplained latency outliers remain. Continue debugging and produce a reproducible trace. If the machine cannot run the required integration tests, complete independent core work but explicitly leave that gate open.

The final implementation handoff must say what works, which versions were tested, what was measured, and what remains unverified. The first milestone is not a public release.
