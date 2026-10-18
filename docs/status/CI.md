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
- `tools/input/plastile-input.c` type-checks (`cc -fsyntax-only -Wall -Wextra -Werror`) against the
  libei **1.2.1** public header, the version Ubuntu 24.04 ships (measured); it has not been
  linked against 1.2.1.
- **The workflow has not run on GitHub**; nothing has been pushed. Runner labels, action versions
  and Ubuntu package names were checked against `actions/runner-images`, the action release pages
  and packages.ubuntu.com on 2026-10-17 (observed source), not on a live runner.

## 1. Jobs

| Job | Runner | Fatal? | Steps |
|---|---|---|---|
| `core` | `ubuntu-latest` (Ubuntu 24.04 per runner-images on 2026-10-17) | yes | `actions/setup-node@v7` (Node 26) and `actions/setup-python@v7` (3.14), Node major guard, `npm ci`, `npm run typecheck`, `npm test`, `npm run build` + bundle sanity grep, `python3 tools/check_docs.py`, `python3 tools/release.py --check --out dist`, `python3 tests/integration/run.py --list` (import check only), `make -C fixtures/client` (`libwayland-dev wayland-protocols pkg-config`), `make -C fixtures/xclient` (`libxcb1-dev libxcb-icccm4-dev`) |
| `core`, optional steps | same | no (`continue-on-error`) | `apt-get install libei-dev` (1.2.1 on 24.04) then `make -C tools/input`. Non-fatal until seen green on the runner; the outcome is written to the job summary |
| `native-tools` | `ubuntu-26.04` | no (job-level `continue-on-error`) | `tools/measure` (needs Qt >= 6.5; 24.04 has Qt 6.4.2) and `tools/settings-check` (needs Qt6 UiTools and KF6Config/KF6ConfigWidgets; 24.04 has no KF6). Ubuntu 26.04 has Qt 6.10 and KF 6.24 (`libkf6configwidgets-dev` 6.24.0, `qt6-tools-dev` ships `Qt6UiToolsConfig.cmake`). Build only: `plastile-settings-check` needs a display to run |

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

Replay half only, KWin half needs the nested runner or a physical session: C02, C04, C06, C07,
C08, C09, C11, C12, C14, G02, G04, G05, G06, G08, G09, G11, G12, I01, I03, L08–L13, L15, L16,
O01, O06, Q01.

### 2b. Needs the nested KWin runner (not run in CI)

Command (a local machine with KWin 6.7.x installed, after `npm run build`,
`make -C fixtures/client` and, for the input scenarios, `make -C tools/input`; each scenario
starts its own disposable `kwin_wayland --virtual` through `tools/nested.py` with a private D-Bus
and XDG tree, and never touches the live compositor):

```sh
python3 tests/integration/run.py                 # all scenarios
python3 tests/integration/run.py --only a,b      # a subset
python3 tests/integration/run.py --list          # names (authoritative; CI runs this import check)
```

Scenario names from `--list` on 2026-10-17 (34; other agents add `scenarios_*.py` modules, so
re-run `--list` for the current set):

| Scenario | Matrix IDs exercised |
|---|---|
| `adopt-open-close` | lifecycle, no ID |
| `noop-and-focus-C11-C12` | C11, C12 |
| `ratio-reversal-G05` | G05 |
| `swap-move-layouts-L06` | L06 |
| `burst-C09` | C09 |
| `constraints-G08-G12` | G08, G12 |
| `app-resize-G11` | G11 |
| `states-L09-L12` | L09, L10, L11, L12 |
| `native-quicktile-L13` | L13 |
| `float-toggle-L08` | L08 |
| `transient-dialog-L07` | L07 |
| `outputs-O01` | O01 |
| `desktops-L15` | L15 |
| `reload-Q09` | Q09 |
| `config-Q01` | Q01 |
| `suspend-idle-C14` | C14 |
| `fractional-scale-G03` | G03 (nested half) |
| `rotation-portrait-O02` | O02 (logical placement half) |
| `unplug-O04` | O04, O05 |
| `reconcile` | ledger reconciliation, no ID |
| `drag-I01-I02` | I01, I02 (real libei input; needs `build/input/plastile-input`) |
| `resize-I03` | I03 (real libei input) |
| `drag-teardown-I04` | I04, I06 (real libei input) |
| `package-install-autoload-T32` | Q11 (install, autoload, disable, upgrade, remove; `kpackagetool6` in the nested session only) |
| `package-post-start-discovery-T32` | Q11 (post-start discovery) |
| `realapps-dolphin`, `realapps-systemsettings`, `realapps-systemsettings-tall`, `realapps-gnome-calculator`, `realapps-gnome-calculator-tall`, `realapps-alacritty`, `realapps-firefox`, `realapps-chromium` | matrix section 4 "representative real applications" sweep (nested half) |
| `realapps-xmessage` | section 4 XWayland client (nested XWayland; not the G10 hint fixture) |

The `realapps-*` scenarios depend on what is installed on the host: a missing binary is recorded
as a failed "installed" check, not a pass, and the version lookup uses `pacman` (Arch-specific).
They are not portable to a generic runner as written.

IDs that have *only* nested coverage: G03, I02, I04, I06, L06, L07, O02, O04, O05, Q09, Q11.

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

G07, G10 (an X11 fixture client, `fixtures/xclient`, is built in CI but no scenario uses it for
increment/aspect hints yet), G13, G14, G15, I05, L01, L03, L04, L14, O03, O07, O08, O09, O10,
Q04, Q05, Q06, Q07, Q08, Q10, Q12. Section 7 later-feature gates (scrolling, zones, native
presentation) have no tests because the features do not exist.

## 3. What a CI pass does not mean

- It does not prove the bundle loads in QV4 or that any KWin API behaves as modelled; that is
  what the nested runner and the M0 probes are for ([API_PROFILE](API_PROFILE.md)).
- It does not measure latency. No timing assertion exists in `tests/core`; performance claims
  come only from the measurement protocol in [PERFORMANCE](../validation/PERFORMANCE.md).
- It does not prove install/update/remove (Q11); only that the release zip is reproducible.
- A failing optional step (libei, Qt6/KF6 tools) does not fail the workflow; it is visible in the
  job summary and should be read, not ignored. Make a step fatal once it has been seen green on
  the runner image.

## 4. Open items

- First run on GitHub (not pushed). Expect to adjust Ubuntu package names in `native-tools`.
- Make `tools/input` and `native-tools` fatal after one green run each.
- Nested scenarios in CI would need a self-hosted runner with KWin 6.7/6.8 installed (the
  "reproducible nested fixtures for supported KWin families" part of T33); not done.
