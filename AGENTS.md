# Instructions for implementing Plastile

This repository currently contains a research-backed specification, not a working window manager. Preserve that distinction in reports, README claims, and benchmarks.

## Required reading

Read `docs/START_HERE.md`, `docs/implementation/ROADMAP.md`, and `docs/design/DECISIONS.md` first. Read the architecture and behavior contracts before changing runtime code. Consult the source index for immutable upstream links. Read the performance protocol before making speed claims.

## Working contract

- Follow the milestone order and decision gates. Start with environment discovery, capability probes, and latency instrumentation. Do not jump directly to a settings GUI or a broad feature implementation.
- A task is complete only when its acceptance criteria are demonstrated. Distinguish mock tests, nested compositor tests, physical-session checks, and unperformed checks.
- Never claim that a Node benchmark proves QV4/KWin performance, or that a geometry signal proves a frame was presented.
- Use a single authoritative policy model and a single writer for window geometry. No second tiling engine may simultaneously own the same window.
- Keep desired, last-requested, and observed geometry separate. Window and context generations invalidate stale callbacks. Preserve genuine lifecycle events during geometry application.
- Normal focus, swap, resize-step, open, and close actions must not wait for fixed settle timers, synchronous IPC, file I/O, network I/O, or user-script loading.
- Do not introduce an idle polling loop. Pointer polling is permissible only during an active interaction and must stop on every exit path.
- Preserve the distinction between script-visible APIs and internal C++ methods. Confirm capabilities against the installed KWin version; do not paste old Plasma 5 type declarations into a Plasma 6 adapter.
- Make unload/reload, removal during callbacks, multiple outputs, fractional scaling, size constraints, fullscreen, and minimize first-class cases. Every owned signal, timer, overlay, and callback must have a teardown path.
- Respect explicit floating and native quick-tile actions. Do not fight a user or application indefinitely to force a rectangle.
- Configuration is data and is validated before activation. Do not add arbitrary user JavaScript execution inside KWin as an initial extension mechanism.
- Cite upstream source when a design depends on it. Upstream code has multiple licenses; use original implementation unless a deliberate, documented code-reuse decision has been made and appropriate notices retained.
- Use nested/disposable sessions for experiments that can destabilize KWin. Never automatically replace or restart the user's active Wayland compositor.
- Maintain a short implementation status document as work proceeds: completed task IDs, exact tested versions, outstanding failures, measurements, and next task. Do not mark proposed work as shipped.
- Keep source changes scoped to the current task. Record any deviation from the roadmap in an ADR with evidence and consequences.

## Definition of done

Meaningful behavioral tests pass, the relevant compositor scenarios pass, performance counters stay within the current milestone's budgets, teardown is demonstrated, documentation matches actual behavior, and any remaining physical-session validation is explicitly reported. A benchmark regression may not be hidden by changing the workload, dropping slow samples, or relabeling presentation latency as engine time.
