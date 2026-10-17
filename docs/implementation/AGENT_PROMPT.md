# Ready-to-use implementation instruction

Copy the following instruction into the implementing agent's initial task. The repository's `AGENTS.md` and detailed documents remain authoritative for the implementation contract.

---

Implement Plastile in this repository: a fast, predictable, configurable tiling layer for KDE Plasma that preserves KWin. Performance and snappiness are the highest priorities, alongside correctness and reliable cleanup. This repository already contains a detailed source-backed research dossier, design, behavior specification, benchmark protocol, roadmap, and task backlog. Read `AGENTS.md`, `docs/START_HERE.md`, `docs/implementation/ROADMAP.md`, and `docs/design/DECISIONS.md` first; read the KWin internals, architecture, behavior, configuration, and validation documents before the corresponding work.

Follow milestones M0–M7 and task IDs T00–T35. Start by discovering the actual environment, verifying script-visible APIs, building a minimal load/unload probe, establishing timing and a controlled client fixture, and collecting a baseline. Then implement the small direct-geometry and native-tile spikes using the same workload. Resolve G1 with correctness evidence and measured latency/mutation counts before hardening the production backend. The provisional architecture is a TypeScript pure core in a declarative KWin script with one narrow adapter; direct geometry is provisional, not an ideological requirement. Add native integration only for a reproduced capability gap or a measured benefit.

Do not begin with a large settings GUI, every layout, a daemon, animations, or executable user plugins. Build the single-authority model, full-context identity, scheduler, master/stack, placement diff, requested/observed ledger, and teardown first. Preserve structural events during apply, reject stale callbacks by generation, issue no redundant no-op writes, and bound convergence instead of fighting clients. Complete lifecycle/constraints gates before BSP, monocle, configuration, drag polish, and packaging. Scrolling and manual zones are later M8/M9 work after the initial release gate.

Use the source index's immutable links to understand prior work; do not copy old KWin APIs or whole upstream engines blindly. Distinguish observed source, inference, proposal, upstream report, and measurement. Keep all benchmark targets labeled as targets until measured. A Node benchmark does not prove KWin/QV4 performance; a geometry signal does not prove physical presentation. Run the required independent tests and preserve raw evidence. Use nested/disposable sessions for risky compositor experiments, and do not automatically restart the user's active Wayland compositor.

Work in scoped commits and maintain a concise implementation status with completed task IDs, exact tested versions, raw-result locations, outstanding failures, decisions, and next eligible task. Complete each milestone's acceptance criteria before expanding scope. When an integration/physical test is unavailable, continue independent useful work but leave that gate explicitly open. Deliver working code and truthful validation, not placeholders or a README claiming untested features.

Begin with T00. Your first implementation handoff should contain the environment/capability report, minimal runnable probe, baseline measurement plan/results where available, and the next eligible task—not an unverified full tiler.

---
