# Continuous integration and test-layer coverage

Workflow: [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) (GitHub Actions, the hosted-runner
part of task T33). This page says what CI proves, what it only builds, and which
[test matrix](../validation/TEST_MATRIX.md) scenarios can never run in CI.

**CI cannot run KWin.** Hosted runners have no `kwin_wayland` 6.7+, no Plasma session and no
compositor, so the nested and physical layers are reported as *not run*, never folded into a
passing count. A green CI run is a statement about the pure/replay layer and the builds only. It
is not a performance claim and not a compositor compatibility claim (see [STATUS](STATUS.md) for
the real tested environment).

Status of the workflow itself (2026-10-17):

- Parsed with PyYAML; every `run:` block passes `bash -n` and `shellcheck` (measured).
- The core job's commands were run in a clean copy of the working tree on Arch Linux with
  Node 26.11.1, npm `ci`, Python 3.14.8 (measured): `npm ci`, `npm run typecheck`, `npm test`
  (97 tests, 97 pass), `npm run build` (135562-byte bundle, sanity grep clean),
  `python3 tools/check_docs.py` (PASS), `python3 tools/release.py --check --out dist`
  (reproducible), `run.py --list` (34 scenarios), `make -C fixtures/client`,
  `make -C fixtures/xclient`, `make -C tools/input` (all built).
- First GitHub runs (2026-10-18): run 1-2 failed at the `fixtures/client` build (GCC 13 with
  Ubuntu's `_FORTIFY_SOURCE` rejected a stdin read length under `-Werror`; fixed in `2fd8373`).
  Run 39087511435 on `2fd8373` was green in every step, including the libei 1.2.1 install, the
  `tools/input` link against it, and the `native-tools` job on `ubuntu-26.04`. Those steps were
  then made required.

## 1. Jobs

| Job | Runner | Fatal? | Steps |
|---|---|---|---|
| `core` | `ubuntu-latest` (Ubuntu 24.04 per runner-images on 2026-10-17) | yes | `actions/setup-node@v7` (Node 26) and `actions/setup-python@v7` (3.14), Node major guard, `npm ci`, `npm run typecheck`, `npm test`, `npm run build` + bundle sanity grep, `python3 tools/check_docs.py`, `python3 tools/release.py --check --out dist`, `python3 tests/integration/run.py --list` (import check only), `make -C fixtures/client` (`libwayland-dev wayland-protocols pkg-config`), `make -C fixtures/xclient` (`libxcb1-dev libxcb-icccm4-dev`) |
| `core`, input injector | same | yes (seen green 2026-10-18) | `apt-get install libei-dev` (1.2.1 on 24.04) then `make -C tools/input` |
| `native-tools` | `ubuntu-26.04` | yes (seen green 2026-10-18) | `tools/measure` (needs Qt >= 6.5; 24.04 has Qt 6.4.2) and `tools/settings-check` (needs Qt6 UiTools and KF6Config/KF6ConfigWidgets; 24.04 has no KF6). Ubuntu 26.04 has Qt 6.10 and KF 6.24 (`libkf6configwidgets-dev` 6.24.0, `qt6-tools-dev` ships `Qt6UiToolsConfig.cmake`). Build only: `plastile-settings-check` needs a display to run |

The release-zip and X11-fixture steps are guarded with `hashFiles(...) != ''` so the workflow
stays valid if those files are not yet committed; when the files exist the steps are mandatory.

Node: tests are `node --test tests/core/*.test.ts`, relying on Node's built-in type stripping.
`package.json` declares `engines.node >= 26` and the workflow pins `node-version: "26"`, which
`actions/setup-node` resolves from the nodejs.org release index (v26.12.0 listed 2026-10-14). No
transpiler (tsx, ts-node) is added. If a runner can only provide an older Node the job fails at
"Verify Node major version" with an explicit error rather than running on an untested runtime.
npm 11 does not run esbuild's `postinstall` by default (it prints an `install-scripts` warning);
the build still works through esbuild's platform optional dependency (measured locally).

Every optional outcome and every layer CI cannot run is printed in the GitHub job summary, so
a skip is visible rather than silent (T33 acceptance: "CI cannot pass by skipping mandatory tests
unnoticed").

Local equivalents (same commands as CI):

```sh
npm ci && npm run typecheck && npm test && npm run build
npm run check:docs            # python3 tools/check_docs.py
npm run release:check         # python3 tools/release.py --check --out dist
npm run integration:list      # python3 tests/integration/run.py --list
make -C fixtures/client && make -C fixtures/xclient && make -C tools/input
cmake -S tools/measure -B build/measure && cmake --build build/measure
cmake -S tools/settings-check -B build/settings-check && cmake --build build/settings-check
```

## 2. Test matrix coverage by layer

The ID sets come from the IDs named in the test sources (`grep` of `tests/core/*.test.ts` and
`tests/integration/scenarios*.py` on 2026-10-17; observed source, not a claim that each test is
exhaustive for its ID). The matrix's "Required layer" column decides whether CI coverage is
complete for an ID: for a row marked "Replay + KWin", CI runs only the replay half.

### 2a. Covered in CI (pure/replay, `npm test`, 97 tests at the time of writing)

| File | IDs |
|---|---|
| `tests/core/engine.test.ts` | C01–C14, G04, G05, G06, G08, G11, G12, I01, I03, L08–L13, L15, L16, O01, O06 |
| `tests/core/ledger.test.ts` | G05, G06, G12 |
| `tests/core/bsp.test.ts` | G01, G02, G08, G09, L02, L05 |
| `tests/core/masterStack.test.ts` | C05, G01, G02, G08, G09, L02 |
| `tests/core/config.test.ts` | Q01, Q02, Q03 |
| `tests/core/package.test.ts` | package metadata / `main.xml` schema vs runtime keys (no matrix ID) |

Also in CI, without a matrix ID: the bundle build, the release zip's byte-for-byte
reproducibility (part of Q11's packaging precondition, not install/update/remove), and the
fixture/tool builds.

Fully satisfied by CI alone (matrix layer is pure or replay only): C01, C03, C05, C10, C13,
G01, L02, L05, Q02, Q03.

Replay half only in CI; the KWin half needs the nested runner (section 2b) or a physical session:
C02, C04, C06, C07, C08, C09, C11, C12, C14, G02, G04, G05, G06, G08, G09, G11, G12, I01, I03,
L08–L13, L15, L16, O01, O06, Q01. Of these, C02, C08, G04, G06 (explicitly) and O06 still have no
nested scenario.

### 2b. Needs the nested KWin runner (not run in CI)

Command (a machine with KWin 6.7.x, or the [sandbox](../../tools/sandbox/README.md), after `npm run build`,
`make -C fixtures/client`, `make -C fixtures/xclient` and, for the input scenarios, `make -C tools/input`;
each scenario starts its own disposable `kwin_wayland --virtual` through `tools/nested.py` with a private
D-Bus and XDG tree, and never touches the live compositor):

```sh
python3 tests/integration/run.py                 # all scenarios
python3 tests/integration/run.py --only a,b      # a subset
python3 tests/integration/run.py --list          # names (authoritative; CI runs this import check)
```

The table follows `run.py --list` on 2026-10-18 (69 names in the Ubuntu 26.10 sandbox; the `realapps-*`
set depends on the host). The ID column says what the scenario's checks actually exercise; "partial"
names the part of the matrix row that is not asserted. Geometry is judged by the oracle (one-shot KWin
scripts); `tiling_errors()` checks containment, overlap, all four outer margins and the spacing between
facing tiles (>= the configured gap; one device pixel of tolerance at fractional scales).

| Scenario | Matrix IDs exercised |
|---|---|
| `adopt-open-close` | lifecycle (adopt, open, close), no ID |
| `noop-and-focus-C11-C12` | C11, C12 (with positive controls: commands dispatched, the reset re-solved) |
| `ratio-reversal-G05` | G05; G06 only implicitly (no explicit late-commit assertion) |
| `swap-move-layouts-L06` | L06; BSP rotate/mirror/equalize as an overlap smoke test only (L04 is asserted in pure tests) |
| `burst-C09` | C09 partial: one context only, so "one solve per affected context" across two contexts is not asserted |
| `constraints-G08-G12` | G08 (overflow explanation, the client keeps its minimum), G12 (writes sent, learned/diverged fallback recorded, client quiet afterwards) |
| `app-resize-G11` | G11 (self-resizes observed, bounded corrections, outcome explained) |
| `states-L09-L12` | L09 partial (no delayed commits), L10, L11 partial (no rule-enforced maximize), L12 |
| `native-quicktile-L13`, `native-quicktile-repeat-L13`, `native-adopt-noop-L13` | L13 |
| `float-toggle-L08` | L08 |
| `transient-dialog-L07` | transient floats (BEHAVIOR §1); L07: monocle with the dialog's parent selected, dialog visible above it, never written |
| `transient-parent-minimize-T16`, `transient-parent-desktop-T16`, `transient-parent-close-T16` | T16 "dialogs follow parent visibility": parent minimize/restore, parent moved to another desktop (by the user and by `move.desktop-*`), dialog sent alone, parent closed by the user and an orphaned dialog (fixture `close-main`). Minimize and desktop steps are compared with the same steps in a nested KWin without Plastile; the dialog is never written ([evidence](evidence/transients-monocle-t16-t22.json)) |
| `monocle-unload-T22` | T22 "switching layout preserves order and user float geometry" (monocle to master/stack and to BSP after focus commands and a user activation) and "disable does not leave opacity/layer artifacts" (unload, reload, back-to-back reload in monocle: KWin's minimized, hidden, opacity, keepAbove/keepBelow, layer and related properties equal their values before load; every window activates and moves afterwards; [evidence](evidence/transients-monocle-t16-t22.json)) |
| `outputs-O01` | O01 partial: send-to-output with both origins at y = 0 (offset origins: `output-offset-origin-G02`) |
| `desktops-L15` | L15, send-to-desktop without follow (the source context reflows) |
| `reload-Q09` | Q09: 100 cycles with pending work; independent checks (KWin script objects, kglobalaccel names, one-step effect size, KWin idle CPU and RSS) |
| `config-Q01` | Q01 (Q04 rapid reload is not exercised) |
| `suspend-idle-C14` | C14; suspend/resume (resume returns a moved window to its slot) |
| `fractional-scale-G03` | G03 nested half |
| `rotation-portrait-O02` | O02 partial: portrait logical placement only (no mixed scale or refresh) |
| `unplug-O04` | O04; O05 partial: placement validity after replug (KWin decides where windows return; preference recovery not asserted) |
| `reconcile` | diagnostic reconcile, no ID |
| `resume-missed-events-T19` | T19 resume: a close, an open, a desktop move, an output move and two external resizes (one leaving the slot unchanged) while suspended; resume adopts the live state (closed window not revived, one solve per visible context, one write per window out of its slot including the one that drifted in place, none for the window already in it); a reconcile afterwards writes nothing |
| `reenable-missed-events-T19` | T19: the same changes while disabled (unloaded), adopted on enable; 10 suspend/resume and 10 disable/enable cycles leave one engine (KWin script objects, kglobalaccel names, steady connections, one command record and one ratio step per press) |
| `send-reflow-once-T24` | T24 "source/destination reflow once": solves per context (trace `solve` records, keyed by context id) and writes per window for send-to-output and send-to-desktop, with and without `followOnSend`; a context hidden by the send is solved once when shown |
| `send-stale-close-T24` | T24 "stale transfer callbacks do nothing": the sent window closes with its destination write outstanding (delayed acks; asserted from the trace), or straight after the shortcut; nothing is recorded for it after its removal |
| `membership-all-desktops-T24`, `membership-two-desktops-T24`, `membership-two-activities-T24` | T24 "pinned/multi-context windows do not receive conflicting targets", L16: a window on all desktops (two outputs), on two of three desktops, on two of three activities, across repeated desktop/activity switches and sends of peers and of the window itself. It gets no request (trace) and KWin reports no frame change for it (passive listener). Each switch writes each window at most once and only in the shown context, with no frame returning to a rectangle it left. A second round of switches writes nothing. Peers tile each shown context (oracle, member counts). Narrowed to one context, it tiles there with one write |
| `send-activity-switch-T24` | T24 send during an activity switch: a desktop send made inside KWin's activity-switch signal, in the same script as the switch request, or by Plastile's shortcut just before it, with a delayed-ack window in the source context. End state as documented (no follow, the sent window on its destination), no write after the switch, each moved window written once over the race and the return. A window on both activities is never written |
| `drag-I01-I02` | I01, I02 (real libei input; needs `build/input/plastile-input`) |
| `resize-I03` | I03 (real libei input) |
| `drag-teardown-I04` | I04 partial (window removed mid-drag; output removal mid-drag not exercised), I06 partial (unload mid-drag; there is no overlay) |
| `classify-builtin-T16`, `classify-rule-title-T16`, `classify-rule-title-reconfigure-T16`, `classify-tiny-helper-T16` | T16 classification (BEHAVIOR §1), no matrix ID |
| `config-desktop-rename-Q02` | Q02 partial: a desktopName override follows a desktop rename (precedence order is asserted in pure tests) |
| `constraints-runtime-min-G08` | G08 family: a minimum set after mapping is read from KWin (not learned); a decoration change updates the frame minimum |
| `shortcuts-defaults-real-input` | default key bindings reach Plastile with real key events (libei); Q08 partial: reports other registered actions holding a default |
| `classify-rule-border-Q10-T16` | Q10 |
| `per-output-desktops-O08` | O08 |
| `activities-E08`, `activities-late-service-E08`, `activities-add-second-E08` | O09 activity half (the native-root half is N/A after ADR-003) |
| `native-tree-edit-L14`, `native-manage-L14`, `native-unmanage-config-L14` | L14 |
| `native-editor-toggle-L14` | L14 editor toggle; SKIP without OpenGL compositing (the tile editor effect is GL-only) |
| `package-install-autoload-T32`, `package-post-start-discovery-T32` | Q11 partial: install, autoload, disable, upgrade, remove within one KWin version |
| `package-upgrade-bindings-T26-T32` | Q08 update half, Q11 version-to-version: a package built from `34204e2` (relabelled 0.0.1; the current tree relabelled where git history or Node is missing) configured and rebound, upgraded with `install.sh upgrade`, script and KWin restarted (the profile, QML disk cache included, kept across the restart); config, rebinding and unbinding kept (KGlobalAccel, kglobalshortcutsrc, libei key presses), one dispatch per press, the rebound focus keys move KWin's active window, Meta+T untouched; removal leaves no live Plastile action. Needs the full history (`fetch-depth: 0`) |
| `fixed-size-G07` | G07 (Wayland min == max: floats by policy, also when a rule asks to tile it; never written) |
| `max-size-G09` | G09 (held at its maximum, centred in its cell, never configured beyond it, converged) |
| `late-min-size-D3` | defect D3 regression: a client that clamps to its own minimum raises it after mapping (fixture `--late-min-size`); the minimum must be adopted from the hint, not learned from a refused request. Failed before 34204e2, passes after it |
| `write-signal-C06` | C06 (signals emitted inside writes recorded as observations, one solve, no recursion) |
| `create-remove-C04` | C04 KWin half: an X11 window without WM_CLASS removed inside the readiness window gets no write; a Wayland toplevel destroyed in its mapping flush is never reported by KWin; removal right after adoption leaves no stale write |
| `remove-during-apply-C07` | C07 KWin half: removal while requests are outstanding (a Wayland window cannot vanish inside the synchronous write loop) |
| `output-offset-origin-G02` | G02 nested half for non-zero origins on both axes; O01 with offset origins |
| `output-negative-origin-G02` | G02 negative origin: SKIP on KWin 6.7.5, which rejects negative positions for enabled outputs and normalizes logical origins to (0, 0) |
| `output-reorder-O03` | O03 (priority/enumeration reorder and geometric reorder: identity, preferences, send order) |
| `desktops-rename-reorder-remove-O10` | O10 (stable desktop ids, reorder, removal migration, and a name-matched override re-resolved after a rename, which failed before fd0ae38) |
| `all-desktops-L16` | L16 (all-desktop and two-desktop windows float, no geometry targets; tile again on one desktop) |
| `workarea-panel-add-remove-O07`, `workarea-panel-before-load-O07`, `workarea-two-panels-O07`, `workarea-panel-one-output-O07` | O07 (layer-shell panels; auto-hide and floating panels need plasmashell) |
| `xwayland-tile-close-G10`, `xwayland-min-G10`, `xwayland-inc-G10`, `xwayland-fixed-G10`, `xwayland-dialog-G10`, `xwayland-aspect-G10` | G10 |
| `realapps-<app>` | matrix section 4 "representative real applications" sweep (nested half) |
| `replay-capture-T10` | T10 replay fixtures: records the engine's normalized event stream (tools/replay/record.qml) for five shapes (open/close burst, removal while a request is outstanding, ratio A->B->A with a 300 ms client, output disable/enable, quick-tile yield) and replays the fresh recordings with `tests/core/replay.test.ts`; SKIP where `node` is not on PATH |

`realapps-*` scenarios are registered only for applications installed on the host (`shutil.which`): a
missing application is neither a SKIP nor a FAIL, it is simply absent from `--list`. Version lookups go
through `tools/sysinfo.py` (pacman, dpkg or rpm).

IDs whose only automated coverage is nested: G07, G10, I02, I04, I06, L07, O02, O03, O04, O05, O07,
O08, O09, O10, Q09, Q11.

Results of nested runs are recorded under `artifacts/integration/<stamp>/report.json`
(gitignored) and summarised in `docs/status/evidence/` by the task that ran them; see
[STATUS](STATUS.md) for the last run.

### 2c. Needs a physical Plasma session (never in CI, not yet performed)

From the matrix "Required layer"/notes: G03 (physical half: real fractional-scale outputs),
G14 (Qt + real application decorations), G15 (hit regions after tile/resize, physical input),
O02 (mixed refresh frame pacing: "a headless virtual setup cannot certify mixed-refresh frame
pacing"), the section 4 real-application sweep on a real desktop (Konsole, Kate, Dolphin, a
browser, a dialog-heavy application, an XWayland client), and every input-to-visible latency gate
in [PERFORMANCE](../validation/PERFORMANCE.md). These stay open release gates per STATUS.

### 2d. No automated coverage yet (any layer)

G13, G14, G15 (physical), I05, Q04, Q05, Q06, Q07, Q12, and Q08's conflict explanation. L01, L03 and L04 are exercised by
pure tests without carrying their IDs. Section 7 later-feature gates (scrolling, zones, native
presentation) have no tests because the features do not exist.

## 3. What a CI pass does not mean

- It does not prove the bundle loads in QV4 or that any KWin API behaves as modelled; that is
  what the nested runner and the M0 probes are for ([API_PROFILE](API_PROFILE.md)).
- It does not measure latency. No timing assertion exists in `tests/core`; performance claims
  come only from the measurement protocol in [PERFORMANCE](../validation/PERFORMANCE.md).
- It does not prove install/update/remove (Q11); only that the release zip is reproducible.
- Every step is required; none is `continue-on-error`.

## 4. Open items

- Nested scenarios in CI: the `integration-nested` job builds the disposable Ubuntu 26.10 sandbox
  ([tools/sandbox](../../tools/sandbox/README.md)) on the hosted runner and runs the whole suite
  against KWin 6.7.5 (QPainter compositing, so GL-only checks report SKIP). It was enabled once the
  suite passed locally in that sandbox (637/637 checks, 67 scenarios, 2 SKIP on 2026-10-18).
- KWin 6.8 in CI: the `integration-nested-kwin68` job runs the suite in the pinned Nix environment
  ([tools/sandbox/nix](../../tools/sandbox/nix/README.md)). It is `continue-on-error` until seen green on
  a hosted runner; its outcome is written to the job summary either way. The 6.7.5 job was green on
  its first hosted run (39094402153).
