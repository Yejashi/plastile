# Open questions, experiments, and risks

These items must remain explicit until implementation evidence resolves them. They are not reasons to stop all work: perform independent core tasks while preserving the relevant gate.

## 1. Experiment register

| ID | Question | Required experiment | Decision/output |
|---|---|---|---|
| E01 | What KWin/Qt environment will actually run Plastile? | T00 environment inventory and packaged-version probes | Support/capability profile |
| E02 | Does current Codeberg Krohnkite/Fluid Tile change the research conclusions? | Read current immutable source refs when accessible | Addendum to source dossier; original pins retained |
| E03 | Which public APIs are script-callable in the target package? | Minimal QML probe of each required property/signal/invokable | Adapter contract; unsupported feature list |
| E04 | Can direct geometry handle rapid request reversal reliably? | Delayed client A→B→A with independent observation/protocol markers | Request ledger design or native bridge requirement |
| E05 | Does native tile integration reduce correctness work without excess churn? | Same targets/client fixture for direct/native spikes | G1 backend decision |
| E06 | What is the actual scheduler delay? | Immediate, stable `Qt.callLater`, and QML timer probe under bursts | Scheduling policy; no assumptions from interval values |
| E07 | What size/increment/aspect constraints are visible to a script? | Native Wayland and XWayland constrained clients | Constraint solver surface and bounded-learning fallback |
| E08 | How are all-activity/multi-desktop windows represented? | Runtime membership probes with Activities enabled/disabled | Normalized context semantics |
| E09 | How do per-output desktops affect root/visibility behavior? | Different current desktop per output, then send/switch | Correct context lookup and native root use |
| E10 | Can script unload leave connections/timers/shortcuts alive? | 100 enable/disable/reload cycles with pending work | Lifecycle mechanism and package safety |
| E11 | How are native quick-tile/editor actions observed? | Explicit user actions in each backend while requests are pending | Yield/adopt/manual mode policy |
| E12 | What minimum helper is needed for rich settings/persistence? | Supported KConfig/QML loading and asynchronous helper prototype | Exact config transport, failure behavior |
| E13 | Are timing stages observable accurately without production native code? | Profiler/test-harness clock calibration and marker correlation | Measurement scope and uncertainty |
| E14 | Does optional animation preserve input alignment? | Physical click-marker test while retargeting and disabling | Presentation acceptance or feature deferral |
| E15 | Can scrolling be polished with script-visible geometry alone? | Adjacent outputs, off-screen input/transients/opacity | Script limitation versus narrow effect |
| E16 | Can output identity survive replug/identical monitors? | Reorder/unplug/replug and ambiguous identity fixtures | Stable key strategy and explicit fallback |

For every experiment record: exact version/commit; fixture; steps; expected/actual result; trace/raw data; conclusion; unresolved limitations. A source comment or issue report can motivate an experiment but cannot close it.

## 2. Risk register

| Risk | Impact | Early indicator | Mitigation and owner task |
|---|---|---|---|
| Geometry feedback loop | Desktop stutter/oscillation | Multiple corrections for unchanged intent | Request ledger, bounded correction, fallback; T15/T18 |
| Coarse signal suppression | Lost lifecycle state/ghost tiles | Removed windows remain in model | Preserve structural events during apply; T10/T11 |
| Stale callback after removal | Wrong placement or native lifetime fault | Late events referencing old generation | Tombstones and generation checks; T09/T15/T19 |
| Duplicate instance after reload | Multiplied work/competing writes | More than one handler per command | Owned lifecycle and repeated reload tests; T02/T26 |
| Native tree rebuild churn | Excess signals/configures/latency | Split/remove count on simple ratio step | Stable projector; G1/T13 |
| False no-op during outstanding resize | Late wrong final frame | A→B→A ends at B | Desired/requested/observed separation; E04/T15 |
| App hints unavailable in script | Infeasible frames/oscillation | Repeated client divergence | Explicit capability limits and learned constraints; T18 |
| Full-context ambiguity | Wrong output/activity placement | Deferred work uses current global state | Carry context/revisions; T09/T24 |
| Panel/work-area instability | Visible jumps and bad margins | Repeated area changes after tile | KWin clientArea, bounded topology handling; T30 |
| Blocking settings/rules | Long compositor callbacks | Tail spikes during title/config changes | Precompile and activate outside hot path; T25/T26 |
| Native plugin ABI changes | Failure to load or session crash | Different packaged KWin headers/paint APIs | Narrow bridge, per-version build/test; T08/T32 |
| Overbuilt daemon/extension architecture | Delayed delivery, synchronization bugs | Core actions require service roundtrips | Scope gate and in-memory runtime; ADR-002/011 |
| Misleading benchmark | Wrong architecture decision | Node-only result called desktop latency | Layered clocks/oracles and matched workload; T03/T34 |
| Off-screen/animation artifacts | Invisible windows or wrong clicks | Opacity/input mismatch after scroll | Dedicated later gate; T31/T36 |
| Incorrect restore | User state overwritten | Float restores tiled size or wrong output | Owned properties and real float history; T19/T27 |

## 3. Deliberately deferred decisions

- Final project license and intentional upstream code reuse: owner decision before distributing implementation. Research is not a license to copy every upstream file.
- Full X11-session support and older Plasma compatibility: separate from initial Wayland/XWayland-client target.
- Executable third-party layout plugins: require a resource/isolation design; declarative layouts first.
- A general daemon, generic IPC automation server, scratchpads, gestures, and shell widgets: only after the core release and a concrete user need.
- Scrolling clipping/pinning and native animation details: dedicated experiments after basic automatic tiling passes.

## 4. Corrections to common assumptions

1. **“All KWin scripts are too slow.”** Not established. Measure callback scheduling, crossings, writes, client redraw, and presentation. A slow algorithm is only one possible component.
2. **“C++ means immediate.”** Not established. Native code can still defer, block, serialize IPC, or send redundant work.
3. **“Native tiles make placement atomic.”** False as an implementation assumption. Tile mutations emit changes, and independent clients commit asynchronously.
4. **“`frameGeometry` changed, so the user saw the result.”** It is an observation layer, not physical presentation.
5. **“Timer interval 1 ms means a 1 ms response.”** QML timer scheduling and clocks do not support that inference.
6. **“Writing `window.tile` is the modern path.”** Inspected KWin uses a deprecated compatibility setter; prefer native manage/unmanage when using tiles.
7. **“The layout belongs only to the desktop.”** Output and activity policy matter; native roots and policy contexts have different dimensions.
8. **“A user script can be stopped with try/catch.”** A synchronous infinite loop cannot be interrupted by catching an exception that never occurs.
9. **“An old project-ending issue proves current source is dead.”** Polonium's newer source and commit history demonstrate why the exact revision matters.
10. **“A README feature implies tested support.”** Source, runtime capability, and actual integration validation are distinct evidence levels.

## 5. Gate disposition

An agent may mark an experiment resolved only with evidence at the required layer. If a capability cannot be tested in the available environment, keep the gate open and state exactly what a target-machine run must do. Continue independent model/config/documentation work without pretending that the integration or release is complete.
