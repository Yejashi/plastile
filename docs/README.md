# Plastile documentation

Start with the part that matches what you want to do.

## Using Plastile

| Document | Contents |
|---|---|
| [User guide](user/README.md) | What Plastile does, layouts, "is it working?", current status |
| [Install](user/INSTALL.md) | Build, install, enable, update, uninstall, recovery |
| [Shortcuts](user/SHORTCUTS.md) | Every command, its default key, conflicts |
| [Configuration](user/CONFIGURATION.md) | Settings, JSON overrides and rules, examples |
| [Troubleshooting](user/TROUBLESHOOTING.md) | Logs, diagnostics, known limitations, reporting problems |
| [0.1.0 alpha release notes](release/0.1.0-alpha.md) | What is in the first release and what is not checked |

## How it is designed

| Document | Contents |
|---|---|
| [Architecture](design/ARCHITECTURE.md) | Modules, scheduler, the geometry protocol |
| [Behavior specification](design/BEHAVIOR_SPEC.md) | Exact user-visible behavior and edge cases |
| [Configuration design](design/CONFIGURATION.md) | Settings model, precedence, command vocabulary |
| [Decision records](design/DECISIONS.md) | Every architectural decision (ADR-001 onward), with evidence |
| [Scrolling](design/SCROLLING.md), [Zones](design/ZONES.md) | The experimental layouts |

## Validation and status

| Document | Contents |
|---|---|
| [Status](status/STATUS.md) | Short current status: test results, gates, open items |
| [Release checklist (G3)](status/G3_CHECKLIST.md) | What the first stable release still needs |
| [Performance report (G2)](status/G2_REPORT.md) | Measured results against the latency budgets |
| [Performance protocol](validation/PERFORMANCE.md) | How performance is measured, and the budgets |
| [Test matrix](validation/TEST_MATRIX.md) | Scenarios and their independent oracles |
| [Physical runbook](validation/PHYSICAL_RUNBOOK.md) | Procedure for testing on a real desktop |
| [CI](status/CI.md) | What continuous integration runs and its known flakes |
| [Environment](status/ENVIRONMENT.md), [API profile](status/API_PROFILE.md) | Tested machines, and the KWin scripting API as measured |
| [Evidence](status/evidence/) | Redacted, machine-readable results that the documents cite |

## Research

| Document | Contents |
|---|---|
| [State of the art](research/STATE_OF_THE_ART.md) | Analysis of existing KWin tilers and other window managers |
| [KWin internals](research/KWIN_INTERNALS.md) | How KWin implements window management, from its source |
| [Source index](research/SOURCE_INDEX.md) | Pinned upstream sources behind the research |

## Project planning and process

Plastile was planned before it was built, and the planning documents are kept as the record of why things are
the way they are.

| Document | Contents |
|---|---|
| [Roadmap](implementation/ROADMAP.md) | Milestones M0–M9 and their decision gates |
| [Backlog](implementation/BACKLOG.md) | Task cards T00–T37 with acceptance criteria |
| [Open questions](validation/OPEN_QUESTIONS.md) | Risks and deferred decisions |
| [Agent entry point](START_HERE.md), [handoff](status/HANDOFF.md), [agent prompt](implementation/AGENT_PROMPT.md) | Working context for coding agents (see [AGENTS.md](../AGENTS.md)) |
