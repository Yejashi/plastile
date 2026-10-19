# G3 release checklist

**Verdict (2026-10-19, `main` at `5773b61`): Plastile 0.1.0 is a release candidate, not a qualified release.**
G3 ([ROADMAP §10](../implementation/ROADMAP.md#10-m7-packaging-documentation-and-initial-release)) and T35
([BACKLOG](../implementation/BACKLOG.md#t35--release-documentation-and-g3)) are not met. The gates that are
missing:

1. **Physical input-to-visible latency (P6).** 60 Hz passes. At 144 Hz *ratio* and *focus* fail against their
   matched baselines; 100 Hz is incomplete and needs a re-run.
2. **Physical soak (P8a).** It is running now; its result is pending.
3. **The current code has not run physically.** The physical runbook ran on build `97fec4a`. Two changes since
   then touch `src/`: the hidden-workarea fix (`a5642dd`) and windows that open maximized (ADR-021, merged
   `0a371c9`). Testing them needs an install and a re-login (KWin keeps running the old code until it restarts).
4. **Owner decisions:** the licence (ADR-012; the package says `"License": "Undecided"` and the repository has no
   licence file); whether the experimental scrolling and zones layouts ship (ADR-014); whether the skipped P2d
   (unplug) and P2e (suspend) checks become declared limitations or get run; the optional P9 G1 repeat.
5. **KWin 6.8** is only a provisional CI job (RSS noise from KWin 6.8's own allocation), so 6.8 cannot be
   declared supported.
6. **Smaller open items:** the nested pure-solve p99 budget is not met (G2), physical uninstall (PHY-10) has not
   run, and no test checks that the live trace leaves out private data.

States: **met**, **partly met**, **open**, **owner decision**, **pending**. Layers: **unit** (Node, mock host or
fake KWin), **nested** (a disposable `kwin_wayland --virtual` session, never physical), **nested-windowed-gpu**
(nested KWin whose outputs are windows on the live desktop; still not physical), **physical** (the owner's real
Plasma session). A nested result never stands in for a physical one.

## 1. G3 acceptance (ROADMAP §10)

| # | Clause | State | Layer | Evidence |
|---|---|---|---|---|
| G3-1 | All initial mandatory test scenarios pass on the declared support versions: KWin 6.7.5, nested | met at `5773b61` | nested | [integration-host-5773b61.json](evidence/integration-host-5773b61.json): 141 scenarios run, 1897/1897 checks, 1 expected SKIP (`output-negative-origin-G02`), including `maximized-open-*-T17` (ADR-021) and `workarea-hidden-desktop-O07`. The previous full run, [integration-host-0f55edf.json](evidence/integration-host-0f55edf.json), is the code of physical build `97fec4a` |
| G3-1a | The same on the second CI environment (Ubuntu 26.10 sandbox, KWin 6.7.5, QPainter) | met at `0652336` | nested | 1527/1527 checks, 113/113 scenarios, 4 expected SKIPs, CI run 39141496877 ([STATUS](STATUS.md), [CI](CI.md)). That commit is older than the current code |
| G3-1b | KWin 6.8 | open (provisional) | nested | CI Nix job, 1484/1484 checks at `0652336`, but `reload-Q09` and `persist-reload-cycles-Q09` fail in some runs on KWin 6.8's own heap growth: an empty script grows KWin by 45–77 MiB over 100 reloads ([q09-kwin68-control.json](evidence/q09-kwin68-control.json)). Until this is resolved, the docs declare only KWin 6.7 ([INSTALL](../user/INSTALL.md)) |
| G3-1c | Mandatory physical scenarios | partly met at `97fec4a` | physical | [physical-runbook-20261018.json](evidence/physical-runbook-20261018.json): P0, P1, P2a (mixed refresh), P2b (fractional scale), P2c (output priority), P3 (panels), P4 (activities), P5 (real apps), P7 (shortcuts) pass. P2d (unplug) and P2e (suspend) were **skipped by the owner**. P5 did not test in-app actions (G14 border toggle, G15 titlebar clicks): the injector sends Meta chords only |
| G3-2 | Physical-session smoke test complete | met at `97fec4a`; open for `5773b61` | physical | P0 and P1 in [physical-runbook-20261018.json](evidence/physical-runbook-20261018.json): session check exit 0, `plastile notice started` in the user journal, 68 shortcuts, errors 0, helper activated by the session bus. Earlier hand-run smoke test on a laptop: [physical-first-run-20261018.json](evidence/physical-first-run-20261018.json). The settings dialog was not clicked through physically (covered nested by `settings-dialog-T28`) |
| G3-3 | Physical input-to-visible tests complete | open | physical | P6 in [physical-runbook-20261018.json](evidence/physical-runbook-20261018.json), 5 runs × 1000 samples per workload, 4 windows. **60 Hz (DP-1): pass** for every Plastile workload against its matched baseline. **144 Hz (HDMI-A-1):** swap pass; **ratio fail** against quick tile (+11.5 ms median, +30.3 ms p95). Plastile's input→configure is 0.6 ms; the difference is in KWin's commit→present of the resized windows (grow 84.5 ms, shrink 43.2 ms, quick tile 35.8–53.2 ms median). **Focus fail** against KWin's window switch (+10.3 ms median): mostly the Aurorae decoration's re-render, which grows with window area ([PERFORMANCE §5.1](../validation/PERFORMANCE.md#51-focus-activation-cost-depends-on-the-decoration-and-window-size), [focus-latency-nested-20261019.json](evidence/focus-latency-nested-20261019.json)); a 1.2 ms residual at equal area stays open. **100 Hz (DP-2): incomplete.** The run stopped in block 4 after 10 taps without effect, so it needs a re-run |
| G3-4 | Long-session churn and repeated reload show no growing resource counts | partly met | nested met; physical pending | Nested 6.7.5: P14 (100 reloads with pending work: connections 80/80, script objects 1, kglobalaccel names 235/235) and P15 (20 min churn, 4254 operations), RSS bounded with an explanation ([G2_REPORT §7](G2_REPORT.md#7-resource-tracking-p14-p15-and-the-rss-bisection), [g2-churn.json](evidence/g2-churn.json), [g2-rss-bisect.json](evidence/g2-rss-bisect.json)). 6.8: see G3-1b. **Physical soak (P8a): pending, in progress** |
| G3-4a | Idle produces no periodic Plastile work | met | nested and physical | Nested: [G2_REPORT §3](G2_REPORT.md#3-4-budgets) idle row (`suspend-idle-C14`). Physical P8b, 3 × 300 s loaded and unloaded in a seeded order: 0 flushes, deadlines, solves, writes and corrections while idle. KWin CPU median 1.540 % loaded vs 1.537 % unloaded (per period 1.530–1.553 vs 1.530–1.540), context switches median 567 vs 568 per s (567–576 vs 437–571) ([physical-runbook-20261018.json](evidence/physical-runbook-20261018.json) `P8`). This is not a claim of 0 % CPU |
| G3-5 | Trace export is bounded and redacted | partly met | unit, nested; source reading | Bounded: *Log trace* prints a ring buffer of `traceCapacity` events, validated to 64–65536 (`tests/core/config.test.ts`, `tests/core/invalidation.test.ts`). Redacted: replay recordings replace titles and drop KWin window and desktop ids, checked by the nested `replay-capture-T10` ([scenarios_replay.py](../../tests/integration/scenarios_replay.py)). The live trace records event kinds, Plastile's window and context ids (connector name, desktop and activity ids) and rectangles. Reading every `trace.record` call in `src/core/engine.ts` shows no title or application id, but no test asserts this. Physical evidence is published only through the redacted report ([runbook §4](../validation/PHYSICAL_RUNBOOK.md#4-where-results-go)) |
| G3-6 | Package removal releases all owned state | partly met | nested; physical open | Unload releases signals, timer, borders and windows (`reload-Q09`, `monocle-unload-T22`, `scrolling-unload-M8`; [G2_REPORT §10](G2_REPORT.md#10-teardown)). Removal (`package-install-autoload-T32`, [package-install.json](evidence/package-install.json)). The `plastile.*` shortcut entries outlive removal (KWin behaviour) until `kglobalaccel … cleanUp` is run, which removed all 68 in `package-upgrade-bindings-T26-T32` ([package-upgrade-T26-T32.json](evidence/package-upgrade-T26-T32.json), [INSTALL §6](../user/INSTALL.md#6-uninstall-cleanly)). Saved state in `~/.local/state/plastile/` is kept by design and its removal is documented. **Physical uninstall (PHY-10) not run** |
| G3-7 | If physical validation is incomplete, label the build a candidate and list the missing gates | met | docs | This file; [README](../../README.md); [user guide](../user/README.md#status-read-this-first) |

## 2. Release evidence (ROADMAP §10)

| # | Clause | State | Layer | Evidence |
|---|---|---|---|---|
| RE-1 | Publish hardware and software, workloads, baselines, clocks, percentiles, raw-result location, confidence and limitations | partly met | nested, physical | Nested: [G2_REPORT](G2_REPORT.md) §1–§8 and §14, raw samples in [g2-p03-samples.csv.xz](evidence/g2-p03-samples.csv.xz) and [g2-baselines-samples.csv.xz](evidence/g2-baselines-samples.csv.xz). The G2 session logs were deleted (G2 §14), so the diagnostic analyses can only be repeated by running the probes again. Physical: redacted summaries with pooled percentiles and run-bootstrap intervals in [physical-runbook-20261018.json](evidence/physical-runbook-20261018.json). Its raw logs stay on the owner's machine under `artifacts/physical/` and are not committed |
| RE-2 | Engine speed, command-to-request, observation and presentation stated separately | met | nested, physical | Nested: pure solve, dispatch → last request, configure, commit and virtual present in separate columns ([G2_REPORT §3, §4, §8](G2_REPORT.md#3-4-budgets)). Physical: input→configure, configure→commit and commit→present per workload (`P6.byRefresh.*.stagesMs`) |
| RE-3 | No "fastest KDE tiler" claim without a reproducible matched comparison | met | docs | No document makes that claim. The one upstream comparison (Polonium 1.2.2, nested only) is labelled as such ([G2_REPORT §8](G2_REPORT.md#8-baselines-t04-nested-virtual)). The package description says "Fast, predictable", which describes a goal and is not a measured ranking |

## 3. Initial release feature boundary (ROADMAP §10)

| # | Clause | State | Layer | Evidence |
|---|---|---|---|---|
| FB-1 | Master/stack, BSP, monocle, floating, keyboard commands, window rules, scoped settings, correct topology and lifecycle | met in nested; partly physical | unit, nested, physical | The scenarios listed in [integration-host-5773b61.json](evidence/integration-host-5773b61.json); physical P2a–c, P3, P4, P5 and P7 at `97fec4a` |
| FB-2 | Measured responsiveness | partly met | nested met; physical open | Nested budgets in [G2_REPORT §3](G2_REPORT.md#3-4-budgets): dispatch → last request met at 32 windows; **pure-solve p99 1.06–1.07 ms against 1 ms, not met**; the command path is 12 % slower at the median than `b60e618`, cause not attributed (G2 §15). Physical: G3-3 |
| FB-3 | Animation optional and disabled by default | met | unit | No animation exists ([ADR-018](../design/DECISIONS.md#adr-018-close-t31-presentation-as-deferred-animation-stays-disabled)); the `animation` setting accepts only `{ "enabled": false, "durationMs": 0 }` ([CONFIGURATION](../user/CONFIGURATION.md#settings-patch)) |
| FB-4 | Scrolling (M8) and zones (M9) in or out of the first release | owner decision | nested only | Experimental and off unless selected ([ADR-014](../design/DECISIONS.md#adr-014-start-m8m9-as-experimental-opt-in-layouts-before-g3-physical-sign-off)); no physical check of either |
| FB-5 | The G1 backend decision repeated physically ("part of G3", ADR-003) | owner decision (optional P9) | physical | Not run. The runbook makes P9 optional and needs consent C8 ([runbook P9](../validation/PHYSICAL_RUNBOOK.md#p9-g1-physical-repeat-optional-consent)) |

## 4. T35 acceptance (BACKLOG)

| # | Clause | State | Layer | Evidence |
|---|---|---|---|---|
| T35-1 | G3 checklist complete | met as a checklist; the gates it lists are open | docs | This file |
| T35-2 | No proposed target is presented as measured | met for the user docs and the README at `c9775ca` | docs | [PERFORMANCE §4](../validation/PERFORMANCE.md#4-proposed-budgets) labels every budget a proposal. The [user guide's performance section](../user/README.md#performance-what-was-measured) gives each number its layer and links the evidence |
| T35-3 | Screenshots and claims match the package | met at `c9775ca` | docs | The repository has no screenshots. Settings keys, defaults and choices were checked against `package/contents/config/main.xml`, `package/contents/ui/config.ui` and `src/config/schema.ts`; the 68 commands and 20 default keys against `src/core/commands.ts`; metadata (`EnabledByDefault: false`, `X-Plasma-API-Minimum-Version: 6.7`, version 0.1.0) against `package/metadata.json` |
| T35-4 | Owner licence and reuse decision recorded before distribution | owner decision (open) | — | [ADR-012](../design/DECISIONS.md#adr-012-license-and-upstream-reuse-are-deliberate). `package/metadata.json` says `"License": "Undecided"`; there is no licence file. Nothing may be distributed until this is decided |
| T35-5 | Publish candidate status when physical gates remain unavailable | met | docs | Verdict above; [README](../../README.md); [user guide](../user/README.md#status-read-this-first) |
| T35-w1 | Supported versions written | met | docs | [INSTALL](../user/INSTALL.md): KWin 6.7 on Wayland, tested on 6.7.5 nested and physically; 6.8 provisional; others untested |
| T35-w2 | Feature and default semantics | met | docs | [user guide](../user/README.md), including windows that open maximized (`maximizedOnOpen`, ADR-021) |
| T35-w3 | Configuration and rule help | met | docs | [CONFIGURATION](../user/CONFIGURATION.md) |
| T35-w4 | Shortcut conflicts | met | docs, physical | [SHORTCUTS conflict report](../user/SHORTCUTS.md#conflict-report) and [known conflicts](../user/SHORTCUTS.md#known-conflicts-on-real-desktops): `Meta+Ctrl+S` is also the Wacom tablet stylus-mode toggle on the reference desktop, and it still reached Plastile there (P1 and P7) |
| T35-w5 | Recovery and uninstall steps | met in docs; physical uninstall not run | docs, nested | [TROUBLESHOOTING](../user/TROUBLESHOOTING.md), [INSTALL §6](../user/INSTALL.md#6-uninstall-cleanly); PHY-10 open (G3-6) |
| T35-w6 | Limitations | met | docs | [TROUBLESHOOTING known limitations](../user/TROUBLESHOOTING.md#known-limitations) |
| T35-w7 | Benchmark methods and results | met in docs; results incomplete | docs | [user guide performance section](../user/README.md#performance-what-was-measured), [G2_REPORT](G2_REPORT.md), [PHYSICAL_RUNBOOK P6](../validation/PHYSICAL_RUNBOOK.md#p6-input-to-visible-latency-p00-p03) |
| T35-w8 | Planning status replaced by implemented status only when justified | maintainer step | docs | [STATUS](STATUS.md) is kept by the maintainers. This branch does not change it |

## 5. Physical runbook items

All at build `97fec4a` on the reference desktop (KWin 6.7.5, Qt 6.12.0, OpenGL; HDMI-A-1 2560×1440 @ 144 Hz,
DP-2 1920×1080 @ 100 Hz, DP-1 1920×1080 @ 60 Hz, all scale 1), with the owner's consent;
[physical-runbook-20261018.json](evidence/physical-runbook-20261018.json).

| Item | State | Note |
|---|---|---|
| P0 session check | pass | |
| P1 install and smoke | pass | Plastile and session_check reported one shortcut conflict: `Meta+Ctrl+S` (Wacom stylus mode). Finding: the owner's kitty opens maximized, which ADR-021 addresses after this build |
| P2a mixed refresh | pass | |
| P2b fractional scale | pass | Applied to HDMI-A-1 instead of DP-1 (deviation recorded) |
| P2c output priority | pass | |
| P2d unplug and replug | skipped by the owner | |
| P2e suspend and resume | skipped by the owner | |
| P3 panels | pass | First attempt found a defect: a tiled window on a hidden desktop was moved by KWin and Plastile corrected it toward a stale tile. Fixed in `a5642dd`, after this build; not re-run physically |
| P4 activities | pass | |
| P5 real applications | pass | In-app actions (G14, G15) not tested |
| P6 latency | 60 Hz pass; 144 Hz fail (ratio, focus); 100 Hz incomplete | G3-3 |
| P7 shortcuts | pass | 19/19 injected chords delivered; *Suspend/resume* by hand; `Meta+Shift+S` (Spectacle) not tested |
| P8a soak | pending, in progress | |
| P8b idle | pass | G3-4a |
| P9 G1 repeat | not run (optional) | FB-5 |
| PHY-10 uninstall | not run | G3-6 |
