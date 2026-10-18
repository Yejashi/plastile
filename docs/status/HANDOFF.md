# Handoff for the next agent (2026-10-18)

This is the context a new agent needs to continue Plastile. Read it after [AGENTS.md](../../AGENTS.md) and before
[START_HERE](../START_HERE.md). It describes the repository as of `main` at `3578f5e`, which the previous
cloud session left on 2026-10-18. That session moves to the owner's real PC next.

[STATUS.md](STATUS.md) and the root README were rewritten on 2026-10-18 and are current; sections 2, 4 and 6 below
are the previous session's view and are partly superseded by STATUS.md.

## 1. What Plastile is now

Plastile is a working automatic tiler, packaged as a KWin 6 declarative script. It has been tested only in
**nested KWin sessions** (`kwin_wayland --virtual`) and the unit test suite. **It has not run in a physical
Plasma session yet.**

- `src/`: a TypeScript core, bundled by esbuild ([tools/build.mjs](../../tools/build.mjs), target ES2016)
  into `package/contents/code/plastile.mjs`. The bundle is **not** committed (`/package/contents/code/` is gitignored); run `npm run build` after any `src/` change and before nested runs. CI builds it itself.
  - `src/core/`: the engine, the geometry ledger (desired, requested and observed geometry kept separate),
    classification, commands, navigation, and the layouts (master/stack, BSP, monocle, scrolling).
  - `src/config/`: schema, validation, compilation and rule matchers. Configuration is data; no user JS runs.
  - `src/adapters/kwin/`: the only module that touches KWin objects.
    [kwinTypes.ts](../../src/adapters/kwin/kwinTypes.ts) lists the script-visible API surface as measured.
  - `src/persist/` and `src/runtime/persistence.ts`: T27 session persistence (ADR-013), stored by the
    `plastile-state` helper over asynchronous D-Bus since ADR-020 (`helper/`; the QtCore `Settings` store is
    gone).
  - `src/runtime/`: wiring, shortcuts, and the inspector/explain view.
- `package/contents/ui/main.qml` is the entry point; there are also `Inspector.qml`, `Persistence.qml` and the
  KCM `config.ui`.
- Decisions: [DECISIONS.md](../design/DECISIONS.md) ADR-001 to ADR-017. The recent ones:
  - ADR-013: persistence via QtCore Settings, with a cost addendum; its storage path is superseded by ADR-020
    (the `plastile-state` helper over asynchronous D-Bus).
  - ADR-014: scrolling and zones are experimental and opt-in.
  - ADR-015: D-Bus reload and the shortcut report.
  - ADR-016: the inspector is Plastile's own UI.
  - ADR-017: the drop preview is deferred; live peer resize is opt-in.

## 2. Branches

| Branch | State |
|---|---|
| `main` (`3578f5e`) | All merged work. `npm run check` (319/319 unit tests, typecheck, bundle) and `tools/check_docs.py` passed locally before the push. The **hosted CI run for this commit was not checked**; earlier runs were cancelled by newer pushes. |
| `wip/m9-zones` (`7c7f768`) | M9/T37 zones layout, experimental and opt-in: model, config, engine, commands, overlay, unit, replay and runtime tests, nested scenarios, docs (+2067/-37 in 28 files). `main` is already merged into it. The agent reported its unit tests green after that merge, but was stopped **before re-running its nested scenarios** on the merged tree. Merge it into `main` once `npm run check` and its scenarios `zones-assign-M9` and `zones-overlay-M9` pass. |
| `wip/perf-g2` (`e541963`) | T20/T34 performance qualification, **unverified**. `f5dc18e` fixes the P05/P03 workload sizing (the tall output is sized with the gaps). `e541963` is an uncommitted-work snapshot taken when the agent was stopped: a pure-engine workload, churn and runner changes, and a Nix measurement environment. It has no G2 report yet. |

## 3. Commands

```sh
export PATH=/opt/node26/package/bin:$PATH   # cloud container only; CI pins Node 26 (tests run .ts directly)
npm ci
npm run check            # typecheck (two tsconfigs) + node --test tests/core/*.test.ts + bundle
python3 tools/check_docs.py    # links, evidence pins, backlog cards; must print PASS
python3 tools/release.py --check --out dist   # reproducible .kwinscript
python3 tests/integration/run.py --list
python3 tests/integration/run.py              # every nested scenario; report under artifacts/integration/<ts>/
python3 tests/integration/run.py --only persist-reload-restart-T27,reload-Q09   # exact names, comma-separated
```

Nested scenarios need the fixture clients, the libei injector and the persistence helper built for the machine
that runs KWin: `make -B -C fixtures/client && make -B -C fixtures/xclient && make -B -C tools/input` and
`cmake -S helper -B build/helper && cmake --build build/helper` (each session installs the helper's activation
file on its private bus; `PLASTILE_STATE_HELPER` selects another build). The packages the
sandbox installs are listed in [tools/sandbox/packages.txt](../../tools/sandbox/packages.txt). Among them are
`kwin-common`, `kactivitymanagerd`, `python3-dbus`, `libkscreen-bin` (`kscreen-doctor`), `libei-dev`, `xwayland` and the
Wayland/X11 dev headers.

Each nested session ([tools/nested.py](../../tools/nested.py)) runs on a private D-Bus bus, a private XDG data
home and a private `kwinrc` under a 0700 temp directory. It never touches the live compositor, which makes it
safe to run on the owner's PC while Plasma is running.

## 4. Test layers and last results

| Layer | Where | Last result |
|---|---|---|
| Unit/replay | `tests/core/*.test.ts` with `mockHost.ts` and `fakeKwin.ts` | 319/319 on `main` (2026-10-18) |
| Nested KWin 6.7.5 | Ubuntu 26.10 debootstrap sandbox, [tools/sandbox](../../tools/sandbox/README.md) (QPainter compositing) | 67/67 scenarios, 637/637 checks, 2 SKIP, before the persistence merge. Persistence and D6 scenarios (6) passed separately on their branch. **The full suite has not been re-run on `main` since the persistence merge.** |
| Nested KWin 6.8.0 | Nix environment, [tools/sandbox/nix](../../tools/sandbox/nix/README.md) (llvmpipe and a udmabuf shim) | Passed locally earlier; the CI job `integration-nested-kwin68` is `continue-on-error`. Its runner segfault (exit -11, no usable render device) has a fix in `840a6b9` that is **unconfirmed on a hosted runner**. |
| Physical session | [tools/physical](../../tools/physical/README.md) and the [runbook](../validation/PHYSICAL_RUNBOOK.md) | **Never run.** |

The 2 expected SKIPs:
- `native-editor-toggle-L14`: needs GL (the tile editor effect).
- `output-negative-origin-G02`: KWin normalizes output origins, so a negative origin cannot occur.

CI ([.github/workflows/ci.yml](../../.github/workflows/ci.yml), notes in [CI.md](CI.md)) has four jobs:
- core;
- native-tools;
- integration-nested (6.7.5 sandbox; was green on hosted run 39094402153);
- integration-nested-kwin68 (provisional).

## 5. Invariants that must not regress

Beyond [AGENTS.md](../../AGENTS.md):

- **One geometry writer:** the engine's single coalesced flush. Native tiles are only observed or yielded to
  (quick-tile, explicit floating), never driven in parallel.
- Ledger entries carry a per-entry tolerance, `frameTolerance(scale)`: `0.5 + 1/scale` when the scale is not 1,
  otherwise `0.5`. This stops KWin's rounding from being learned as a constraint.
- Corrections are bounded. Window and context generations, and tombstones, discard stale callbacks.
- **No timers on the command path and no idle polling.** Persistence saves through one debounce, never during a
  command. **KWin's thread does no persistence file I/O** (ADR-020): a save is one asynchronous `DBusCall` to the
  `plastile-state` helper, about 0.2 ms of KWin's time for a typical state
  ([evidence](evidence/persistence-helper-cost.json)); the old in-process QSettings saves cost 1.6–3.6 ms p50
  and stalled 31.9 s on a held lock ([evidence](evidence/persistence-t27-cost.json)). Do not add file I/O back
  to KWin's thread.
- Every signal goes through the adapter's owned-connection registry. KWin keeps plain closures alive after
  unload; `reload-Q09` checks that across 100 cycles.
- Plastile's own windows (the inspector, and the zones overlay on the WIP branch) are excluded from tiling, and
  the real-app oracle ignores them.
- Label every result with the layer it came from: unit, nested, or physical. A Node or nested timing never
  stands in for QV4 on a physical session, and a geometry signal never counts as a presented frame.

## 6. Next work, in order

1. **CI:** open the latest Actions run on `main`. If `integration-nested-kwin68` is green, remove its
   `continue-on-error` and update [CI.md](CI.md). If it is red, the job's "Diagnostics on failure" step prints
   the device nodes and the first KWin log.
2. **Zones:** check out `wip/m9-zones`, run `npm run check`, the zones scenarios and a smoke set
   (`--only zones-assign-M9,zones-overlay-M9,adopt-open-close,reload-Q09`), then merge into `main`.
3. **Performance and G2 (T20/T34):** continue from `wip/perf-g2`.
   - A **known real defect** needs a root cause: **P05 at n=32 windows overlaps windows in the overflow case**.
     `f5dc18e` changes how the workload sizes the output; confirm whether that only removes an infeasible
     workload or whether the engine is actually wrong.
   - Write `docs/status/G2_REPORT.md`, marking each [PERFORMANCE](../validation/PERFORMANCE.md) §4 budget as
     met, not met or inconclusive for each environment.
   - Never drop slow samples or change the workload to pass a gate.
4. **Full nested suites on both KWin versions** on the merged `main`, ideally on the PC's own KWin as well.
   Record the exact versions.
5. **Docs rewrite to match reality:**
   - [STATUS.md](STATUS.md): completed task IDs, versions, test counts, failures and next task.
   - The root README.
   - [API_PROFILE.md](API_PROFILE.md): add `maximizeableChanged`, `decorationChanged` and
     `clientGeometryChanged`, which the adapter uses for constraints and decoration margins, and
     `VirtualDesktop.nameChanged`. Its "Unresolved" table is outdated: activities, XWayland, panels, fractional
     scale, interactive move/resize and post-start discovery now have nested scenarios.
   - [TEST_MATRIX](../validation/TEST_MATRIX.md): add a 6.7.5/6.8.0 version matrix.
6. **Backlog audit:** check every card in [BACKLOG.md](../implementation/BACKLOG.md) against its acceptance
   criteria and evidence (an audit was started and stopped before it reported). STATUS.md listed T04, T16, T18,
   T24, T25/T26, T28, T30 and T32–T35 as partial; most of that predates later work, so re-verify it rather than
   trust it.
7. **T35 and G3:** write the release docs and a release-candidate checklist, leaving the physical gates open.
   Then run a final adversarial review.
8. **Physical session:** follow the [runbook](../validation/PHYSICAL_RUNBOOK.md) P0–P8, consent points first.
   It covers session check, install, real outputs and scaling, panels, activities, real apps, input-to-visible
   latency, shortcuts on the real keymap, and soak/idle. Results are private by default; publish only redacted
   summaries.

## 7. Owner decisions still open

- **License:** "Undecided" (ADR-012). Nothing can be released until the owner picks one. Upstream code stays
  reference-only.
- Whether the experimental scrolling and zones layouts ship in the first release or stay opt-in previews
  (ADR-014).

## 8. Gotchas learned the hard way

- **Never restart, replace or reload the live `kwin_wayland`.** Use `tools/nested.py` sessions. Kill nested
  KWin processes only by exact PID; `pkill -f` once killed the agent's own shell.
- Build fixtures and tools in **one environment per run**. Rebuilding on the host during a chroot run
  overwrote binaries linked against a different glibc. Before Nix runs, rebuild on the host with `make -B`.
- Integration evidence goes to `artifacts/evidence/` (gitignored) unless `PLASTILE_PUBLISH_EVIDENCE=1`. Commit
  only redacted, reproducible summaries to `docs/status/evidence/`, and pin new files where `check_docs.py`
  expects them.
- `minSize`/`maxSize` have no NOTIFY signal. The adapter re-reads them on `maximizeableChanged`, and on
  `clientGeometryChanged` after `decorationChanged`, as measured.
- Assigning `workspace.activeWindow` takes effect asynchronously under load. The harness waits for it with
  `wait_active()`; this flaked on 6.8 before the wait was added.
- KWin 6.8 has no QPainter compositing. Its virtual backend needs a render node or `/dev/udmabuf`, and the Nix
  wrapper's shim covers kernels without either.
- Every push to `main` cancels the CI run in progress (a concurrency group). Wait for a run to finish before
  pushing again if you need its result.
- Commit message trailers and the "no model identifiers in the repository" rule come from the session
  instructions; keep following whatever the current session specifies.
