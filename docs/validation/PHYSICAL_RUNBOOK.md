# Physical-session validation runbook

G3 ([ROADMAP §10](../implementation/ROADMAP.md#10-m7-packaging-documentation-and-initial-release)) cannot pass without checks that only a real Plasma 6 Wayland session can run: real outputs and refresh rates, plasmashell panels, the real Activities service, real applications, input-to-visible latency, and the user's own keymap. This runbook tells the owner of such a machine how to run those checks **safely and reproducibly**, what to record, what counts as a pass, and where results go. The tools it uses live in [`tools/physical/`](../../tools/physical/README.md).

Reference machine ([ENVIRONMENT](../status/ENVIRONMENT.md#reference-machine)): Arch Linux, KWin 6.7.5, Qt 6.12, AMD RX 9070 XT (OpenGL), three outputs: DP-1 1920×1080 @ 60 Hz, HDMI-A-1 2560×1440 @ 144 Hz (primary), DP-2 1920×1080 @ 100 Hz, all scale 1, VRR incapable.

Nothing in this document has been run in a physical session yet. Until it is, Plastile remains a **candidate** with the physical gate open.

## 1. What was validated where

The kit was built in a cloud container without a desktop or GPU. Everything that could be exercised there was; everything else is marked **not run**.

| Part | Validated where | Evidence | Not validated |
|---|---|---|---|
| `keytap.c`, uinput backend (`plastile-keytap`) | Builds with `-Wall -Wextra -Werror` (host container: gcc 13.3.0, clang 18.1.3, also with gcc `-Wshadow -Wconversion`; Ubuntu 26.10 sandbox: gcc 15.3.0). Session guard refusals unit-tested with fake compositor sockets and processes, and against a real nested KWin 6.7.5 (`--virtual`), which it refuses | `tools/physical/tests/test_keytap.py`; the guard self-check at the start of every nested dry run | **Creating a uinput device and injecting into a physical KWin has never run.** The container has no `/dev/uinput` and no physical session |
| `keytap.c`, libei backend (`plastile-keytap-ei`) | Nested KWin 6.7.5 in the Ubuntu 26.10 sandbox (virtual backend, QPainter, libei 1.5.0) | `nested_dryrun.py` runs | Not used physically |
| Correlation (`latency.py`) and record schema | Synthetic logs; logs recorded from the real fixture in nested KWin 6.7.5 (committed, trimmed, in `tools/physical/tests/data/`) | `test_latency.py`, `test_recorded.py` | Physical presentation timing |
| Block engine (`orchestrate.py`: plan, conditions, warmup, pacing, safety stops, offline correlation) | Fakes (dry injector, fake fixture processes) and nested dry runs that drive the same engine through `NestedDriver` | `test_orchestrate.py`, `nested_dryrun.py` | `LiveDriver` (manual and D-Bus condition switching, journal counters, fixtures in the live session): **not run** |
| `orchestrate.py keys` (default bindings on the real keymap) | Same check through libei in nested KWin 6.7.5: with the defaults after the D10 fix (`Meta+Ctrl+=`, `Meta+Ctrl+-`, `Meta+Ctrl+S`), all 19 injected default chords reached Plastile; with the earlier defaults `Meta+Shift+=` and `Meta+Shift+-` stored as user bindings, those two did not, so the check does detect undelivered chords | `nested_dryrun.py --keys [--binding ACTION=CHORD]` | Physical keymap: **not run** |
| `summarize.py` (statistics, p99 refusal, bootstrap by run, verdicts) | Synthetic data; nested dry-run data | `test_summarize.py` | — |
| `session_check.py`, `observe.py`, `soak.py`, `checklist.py` | Refusal outside a KWin Wayland session; pure helpers; checklist bundle | `test_common.py`, `test_tools.py` | Live runs: **not run** |

Run the unit tests anywhere (no desktop needed): `python3 -m unittest discover -s tools/physical/tests`. A nested dry run of the latency pipeline (never a physical result; every record says `"layer": "nested-dry-run"`): `tools/sandbox/run.sh -- python3 tools/physical/nested_dryrun.py --keys` after `make -C tools/physical all ei` inside the sandbox.

Nested dry-run results are summarized in [evidence/physical-kit-nested-dryrun.json](../status/evidence/physical-kit-nested-dryrun.json) (Ubuntu 26.10 sandbox, KWin 6.7.5, QPainter, synthetic 60 Hz timeline). The protocol-scale run (P02-quicktile and P03-ratio, 3 windows, 5 runs × 1000 samples each in randomized order) completed all 10,000 samples successfully; the summarizer reported p99 because each workload reached 5000 samples, produced a `pass` verdict, and Plastile's counters showed one write per window per command and no corrections. That exercises the whole pipeline end to end; as a nested measurement it says nothing about physical latency. A six-workload run (2 runs × 40 samples) covered every workload (all 480 samples successful; the P03-focus blocks issued zero solves and zero writes), and the key-delivery check is described in the table above.

**Windowed nested runs on the reference machine's GPU (2026-10-18, layer `nested-windowed-gpu`).** With
`PLASTILE_NESTED_HOST_DISPLAY=$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY`, `tools/nested.py` starts the nested KWin with its
wayland backend: each nested output is a window on the running desktop, composited with OpenGL on the real GPU, and
presented at the host output's rate (144 Hz on the reference machine); the bus, configuration and XDG directories stay
private and the live KWin is never touched. This is still not a physical session: presentation is the nested KWin's
timeline driven by the host compositor's frame callbacks, not scanout, and input comes through the nested KWin's EIS
socket, not the kernel. Results:

- Latency kit (P6 workloads, 4 windows, 5 runs × 1000 samples each, 30,000 taps, all successful): every Plastile
  workload `pass` against its matched baseline and the controls. Median input-to-first-present: P03-ratio 10.27 ms and
  P03-swap 10.11 ms against P02-quicktile 13.22 ms; P03-focus 14.03 ms against P00-switch 13.72 ms. One P03-focus block
  issued one solve and zero writes (a `CHECK:` line; the cause was not captured, the trace having rolled over).
  [evidence](../status/evidence/latency-windowed-gpu-20261018T042052.json)
- Key delivery (P7, default bindings): 19 of 19 bound chords reached Plastile.
  [evidence](../status/evidence/keys-windowed-gpu-20261018T041604.json)
- Scenarios (P3/P5 and GL-only checks): real applications (Dolphin, System Settings, GNOME Calculator on Wayland and
  X11, Alacritty, Firefox, Chromium, xmessage, zenity), panels from a real `plasmashell` (`plasmashell-panels-O07`),
  the GL tile editor (`native-editor-toggle-L14`), drags, resizes and idle passed.
  [evidence](../status/evidence/integration-windowed-gpu-20261018.json)
- Not coverable this way: fractional scale (the wayland backend reports scale 1 even with `--scale`, and ignores
  kscreen-doctor scale changes), real monitors and refresh rates, cable unplug, system suspend, and the user's own
  panels, activities, keymap and applications.

A uinput device cannot reach a nested virtual-backend KWin: kernel input goes to the compositor of the physical seat. That is why the uinput backend refuses to start when the compositor serving `WAYLAND_DISPLAY` runs with `--virtual`, `--wayland-display` or `--x11-display`, and why the nested dry run substitutes the libei backend.

## 2. Prerequisites

- A Plasma 6 **Wayland** session on the machine under test, logged in as yourself (not root). The tools refuse to run unless `XDG_SESSION_TYPE=wayland`, the `WAYLAND_DISPLAY` socket is served by your own non-nested `kwin_wayland` (directly or through `kwin_wayland_wrapper`), and `org.kde.KWin` on your session bus belongs to that same process.
- No other tiling script enabled (`session_check.py` fails if it finds Polonium, Krohnkite, Bismuth and similar).
- Tools: Python ≥ 3.11 (standard library only), a C compiler, `make`, `wayland-scanner`, `wayland-protocols` and `libwayland-client` (for the fixture client), Node ≥ 26 and npm (to build Plastile), `kpackagetool6`, `kscreen-doctor`, `busctl` and `journalctl` (systemd), optionally `qdbus6`.
- Build on the machine under test (not inside the sandbox, whose binaries link against its own libraries):

```sh
npm ci && npm run build          # package/contents/code/plastile.mjs
make -C fixtures/client          # fixtures/client/build/plastile-fixture
make -C tools/physical           # build/physical/plastile-keytap (no extra dependencies)
python3 -m unittest discover -s tools/physical/tests
```

- One results directory per session, used by every step below:

```sh
export RUN=artifacts/physical/$(date +%Y%m%dT%H%M%S)
python3 tools/physical/checklist.py new "$RUN"
```

- For long runs, keep the machine awake without changing settings: prefix the command with `systemd-inhibit --what=idle:sleep --why="Plastile validation"`. The inhibitor ends with the command. Whether Plasma's screen locker honours the logind idle inhibitor was not checked; if the screen locks during a latency run, the block stops because keyboard focus leaves the fixture windows.

## 3. Consent points and safety rules

Each consent point changes something in your session. Decide on each one explicitly. The tools that inject input or load and unload Plastile print what they will do and ask before acting; no tool performs a consent step silently.

| # | What | What it changes | Persists? | How to undo |
|---|---|---|---|---|
| C1 | Install and enable Plastile in the live session (P1) | Copies the package to `~/.local/share/kwin/scripts/plastile/`; enabling writes `[Plugins] plastileEnabled=true` in `kwinrc`; loading registers 46 `plastile.*` shortcuts in `~/.config/kglobalshortcutsrc` under `[kwin]`; the settings dialog writes `[Script-plastile]` in `kwinrc` | The shortcut entries **stay after removal** (measured in nested KWin; inert without the script) | [§6](#6-uninstall-and-clean-up) |
| C2 | Rebind shortcuts (P6, P7) | Your chosen chords in `kglobalshortcutsrc`, through System Settings > Keyboard > Shortcuts | Yes | Reset them in the same page |
| C3 | Virtual keyboard (P6, P7) | Access to `/dev/uinput` for your user, then a virtual keyboard named `plastile-keytap` that presses Meta chords in **this** session | ACL: until reboot | `sudo setfacl -x u:$USER /dev/uinput` |
| C4 | Let the orchestrator load/unload Plastile (`--toggle dbus`, P6, P8) | Calls `org.kde.kwin.Scripting.unloadScript plastile` and `org.kde.kwin.Scripting.start`. Neither writes `kwinrc`; `start` also makes KWin re-read `kwinrc` | No; the initial loaded state is restored on every exit path | Without consent, use `--toggle manual` (the default) and switch in System Settings yourself |
| C5 | Output changes (P2): scales, priorities, unplugging cables, suspend | KScreen stores output configuration in `~/.local/share/kscreen/` | Yes | Record `kscreen-doctor -j` first and set the values back |
| C6 | Create and delete activities (P4) | Activity database of `kactivitymanagerd` | Yes | Delete the test activities |
| C7 | Panel changes (P3) | `plasma-org.kde.plasma.desktop-appletsrc` | Yes | Revert in Edit Mode, or remove the test panel |
| C8 | G1 repeat (P9) | Loads the M1 spike packages and one-shot oracle scripts into the live KWin | No | Unload them; not automated by this kit |

Rules that hold throughout:

- **Never restart or replace the compositor.** `kwin_wayland --replace` ends a Wayland session. Nothing in this kit does it, and no step asks you to.
- **The kit never writes `kwinrc` or `kglobalshortcutsrc`.** It reads them. Every change in the table above is made by you (System Settings, `tools/install.sh`, `kscreen-doctor`) or, for C4 only, by D-Bus calls that do not write configuration.
- **The nested suite stays nested.** `tests/integration/run.py` and `nested_dryrun.py` start their own `kwin_wayland --virtual` on a private D-Bus and never touch the live session.
- **The injector only sends Meta chords**, at most one every 40 ms, and only from the session user (it refuses to run under `sudo`). A chord that is not a global shortcut therefore cannot type text into an application.
- **Runs stop by themselves.** A block stops when keyboard focus leaves the fixture windows (the next block opens new, focused fixtures); the whole run stops after 10 consecutive chords without effect, when the fixtures open on another output than the one under test, or when you press Ctrl-C. The injector completes the chord it is pressing (key releases are always sent) and destroys its device on exit. If it is killed with `SIGKILL`, closing `/dev/uinput` destroys the device; the kernel input core is expected to release keys held by a disconnecting device (not verified here). If a modifier still seems stuck, press and release it on your real keyboard.
- Run latency blocks on an **empty virtual desktop** of the output under test, keep the pointer on that output, and do not use the keyboard or mouse while a run is going.

**uinput access (C3).** Load the module if needed (`sudo modprobe uinput`), then grant your user access until the next reboot and check it:

```sh
sudo setfacl -m u:$USER:rw /dev/uinput
python3 tools/physical/session_check.py --no-json | grep uinput
```

## 4. Where results go

Everything is written below `$RUN` (inside `artifacts/`, which is gitignored and may contain private metadata such as process ids and configuration values). Suggested layout:

```text
$RUN/
  checklist.json                 checklist.py new / set
  session.json                   session_check.py --json
  latency-60hz/  latency-100hz/  latency-144hz/      orchestrate.py run --out
      session.json plan.json context.json keytap.jsonl blocks.jsonl
      blocks/NNN-<workload>-n<N>/{taps.jsonl, fixture-*.jsonl, block.json}
      samples.jsonl  warmup.jsonl  summary.json  summary-redacted.json
  keys/                          orchestrate.py keys --out
  observe-<topic>/               observe.py --out: phases.jsonl, observe-summary.json, fixture-*.jsonl
  soak/  idle/                   soak.py sample|idle --out
  report.json                    checklist.py report (private)
  report-redacted.json           checklist.py report (publishable)
```

Raw latency records follow [PERFORMANCE §8](PERFORMANCE.md#8-raw-result-schema) plus extensions (`layer`, `inputSource`, `inputNs`, `inputToFirstPresentNs`, `inputToSettledNs`, `refreshNsObserved`, `warmup`, and so on). Fields a physical run cannot observe (dispatch, solve, last request, observed geometry, per-sample engine counters) are `null` with the reason in `unavailableReasons`.

**Publishing.** Only `report-redacted.json` (and `summary-redacted.json` files) are meant for the repository: `checklist.py report "$RUN" --publish docs/status/evidence/physical-<stamp>.json`. They contain versions, output modes, statuses, your notes and statistics, without window titles, host names, serial numbers, process ids or raw logs. Your checklist notes are published verbatim, so keep private details out of them. Updating STATUS, the TEST_MATRIX version row and the G3 gate is the maintainers' step after review; `checklist.py report` prints a draft row.

## 5. Procedures

Each procedure lists its consent points, steps, what to record, the pass criteria (from [TEST_MATRIX](TEST_MATRIX.md) and [PERFORMANCE](PERFORMANCE.md)), and its checklist items. Record each outcome with `python3 tools/physical/checklist.py set "$RUN" <ID> pass|fail|blocked|skipped "<what you saw>"`. A failure caused by a known product defect is recorded as a fail with the defect named; it is never re-labelled.

### P0. Session check

Read-only; no consent needed.

```sh
python3 tools/physical/session_check.py --json "$RUN/session.json"
```

It reports the session and compositor (pid, not nested), KWin and Qt versions, compositing type and renderer, every output with mode, refresh rate, scale, position, priority and VRR policy, whether Plastile is installed, enabled in `kwinrc` and loaded, whether the installed bundle matches this checkout, Plastile and KWin shortcut bindings with duplicates, whether the tile editor effect is loaded, activities and desktops, logind state, uinput access and the CPU governor.

- **Record:** `$RUN/session.json`.
- **Pass (PHY-00):** exit code 0; KWin 6.7.x; the expected outputs and refresh rates; no other tiler enabled.

### P1. Install and smoke test

Consent: C1.

1. `tools/install.sh install` (use `upgrade` if an older copy is installed; if that older copy already ran in this session, log out and in before step 2, or KWin starts the older version again: [INSTALL](../user/INSTALL.md#updating)). It refuses to install without the built bundle and prints, but never runs, the enable commands.
2. System Settings > Window Management > KWin Scripts: tick **Plastile** and Apply. If it is not listed yet, wait half a minute or log out and in (measured in nested KWin: a package installed while KWin runs was found only after about 20 s).
3. Open Plastile's settings dialog from the same page, change nothing, press Apply, then run `qdbus6 org.kde.KWin /KWin reconfigure` (the dialog's Apply alone does not reach the running script; see [INSTALL](../user/INSTALL.md#applying-settings-changes)). The dialog has never been clicked through in a live session before.
4. Confirm the start and the diagnostics in the journal (reading the journal in a physical session is itself untested; see [TROUBLESHOOTING](../user/TROUBLESHOOTING.md#reading-the-log)):

```sh
journalctl --user -b | grep -E 'plastile notice (started|restored)|usedbeforedeclared'
qdbus6 org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component.invokeShortcut plastile.inspect.counters
qdbus6 org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component.invokeShortcut plastile.inspect.explain-window
journalctl --user --since=-1min | grep -E 'plastile (counters|notice explain)'
```

5. Open three Konsole windows on an empty desktop. They should tile master/stack without overlap. Run `python3 tools/physical/session_check.py --require-plastile loaded --json "$RUN/session-loaded.json"`.

- **Record:** the journal lines (keep them in `$RUN/`, they may contain window captions), a screenshot, the second session report.
- **Pass (PHY-01):** `plastile notice started` appears once (at the default log level) and no `qt.qml.usedbeforedeclared` warning names `plastile.mjs`; the counters line parses and shows `errors: 0`; explain shows a classification for the active window; the three windows tile without overlap; the dialog opens and applies.

### P2. Real outputs

Use `observe.py` for each change: it opens fixture windows, and for every labelled phase reports per window the configures received, size reversals (A→B→A), the final size, which refresh rate the window presents at (a proxy for its output), whether the windows went quiet, and Plastile's counter deltas. It cannot see positions: placement is your visual check.

```sh
python3 tools/physical/observe.py --windows 4 --out "$RUN/observe-<topic>"
```

Its automatic hint is "converged; no reversals" when every window went quiet within the tail timeout, no size returned to an earlier value, and no window received more than 3 configures for a single change (one request plus at most two corrections, the corrective budget in [PERFORMANCE §4](PERFORMANCE.md#4-proposed-budgets)).

Before any change, record the output state: `kscreen-doctor -j > "$RUN/kscreen-before.json"` (read-only). Afterwards restore it and compare with `kscreen-doctor -j`.

#### P2a. Mixed refresh rates (O02)

1. Put two or three windows (Konsole, fixtures) on each of DP-1, HDMI-A-1 and DP-2. Each output's windows must tile in that output's work area, independently of the others.
2. With `observe.py` running on one output, use *Send window to next output* (`Meta+Shift+O`) on a fixture. Its reported refresh rate must change to the target output's rate and both outputs must re-tile.
3. The independent timing report for O02 is P6 run on each output.

- **Pass (PHY-02a):** correct logical placement on every output (visual); send-to-output converges on the target output; P6 completed at 60, 100 and 144 Hz.

#### P2b. Fractional scaling (G03, physical half)

Consent: C5.

1. Start `observe.py --windows 4 --out "$RUN/observe-g03"` with its windows on DP-1, plus a Konsole window there.
2. Phase "scale 1.25": `kscreen-doctor output.DP-1.scale.1.25`, wait until stable, Enter. Repeat for 1.5 and 1.75, then a phase back to 1.
3. Look for gaps or overlaps between tiles at each scale.

- **Pass (PHY-02b, TEST_MATRIX G03):** every phase converged with no reversals, at most 3 configures per window per change, and Plastile's `corrections` delta stays small and does not grow phase over phase (no repeated fractional corrections); no visible gap or overlap beyond one physical pixel.
- **Restore:** `kscreen-doctor output.DP-1.scale.1`.

#### P2c. Output priority and reordering (O03)

Consent: C5.

1. Before the change, give one output a non-default layout (for example *Monocle layout*, `Meta+Shift+M`, on DP-2) and note each output's arrangement.
2. In `observe.py`, phase "priority": `kscreen-doctor output.DP-2.priority.1`. Then restore the recorded priorities in another phase.

- **Pass (PHY-02c, TEST_MATRIX O03):** no window changes output (its reported refresh rate is unchanged), each output keeps its layout choice and arrangement, phases converge.

#### P2d. Unplug and replug (O05, E16)

Consent: C5 (physically unplugging a cable).

1. Tile windows on DP-2 with a non-default layout (BSP), and run `observe.py`.
2. Phase "unplug DP-2": pull the cable, wait until stable, Enter. Phase "replug DP-2": plug it back, wait, Enter.
3. If two identical monitors are available, swap their cables in a third phase (ambiguous replug, O05).

- **Pass (PHY-02d, TEST_MATRIX O04/O05):** after unplug every window is visible on the remaining outputs and no error is counted; after replug the arrangement is recovered deterministically or the fallback is explained in the log. Record which.

#### P2e. Suspend and resume

1. With tiled windows on every output and `observe.py` running, phase "suspend": `systemctl suspend`, wake the machine, wait, Enter.
2. Compare `kscreen-doctor -j` with `$RUN/kscreen-before.json`.

- **Pass (PHY-02e):** windows stay tiled on their outputs, the phase converges, no errors, outputs come back with their modes.

### P3. Panels with plasmashell (O07)

Consent: C7. Run `observe.py --windows 4 --out "$RUN/observe-o07"` on the output that has (or gets) the panel, plus a Konsole window, and make one phase per change:

| Item | Change |
|---|---|
| PHY-03a | Add a panel (right-click the desktop > Add Panel > Empty Panel), then remove it |
| PHY-03b | Panel visibility Auto Hide on, then off (panel Edit Mode) |
| PHY-03c | Floating panel on, then off |
| PHY-03d | Change the panel height |
| PHY-03e | Move the panel to another screen edge and to another screen |

- **Record:** phases, and a screenshot after each change.
- **Pass (TEST_MATRIX O07):** no tile under a panel that reserves space; the gap between tiles and the panel equals the configured outer gap (no double subtraction); with Auto Hide the tiles use the area KWin reports; every phase converged without reversals. Defect D2 (tiles stayed under a panel added later; the reduced area persisted after removal) was found in nested KWin and addressed on main (26459be); this is its first physical check. If it reproduces, record a fail naming D2.

### P4. Activities (E08, O09)

Consent: C6.

1. Create a second activity (Activities manager, `Meta+Q`, or System Settings > Activities). The change from one to two activities is where defect D1 stranded tiles before it was addressed on main (0a37a67); check it first.
2. Open and tile windows on both activities; switch between them several times (`Meta+Tab`); create and delete a third activity while windows are tiled.
3. Put one window on all activities and check it floats (L16 policy, ADR-009).

- **Pass (PHY-04, TEST_MATRIX E08/O09/L16):** new windows on an activity tile into that activity's layout without overlapping existing tiles; switching never applies a stale layout; the all-activities window floats; deleting an activity leaves no orphaned tiles. The native-root part of O09 is not applicable (ADR-003 chose direct geometry).

### P5. Real applications (G14, G15)

Record each application's package version in the checklist note.

| Item | Application and what to try |
|---|---|
| PHY-05-konsole | Konsole: tile, resize steps, tabs (`Ctrl+Shift+T`), split view, fullscreen (`Ctrl+Shift+F`) |
| PHY-05-kate | Kate: tile; check that its minimum size is respected (defect D3, stale size constraints, was found with Kate in the sandbox and addressed on main in 34204e2; check it here) |
| PHY-05-dolphin | Dolphin: tile, split view, its dialogs float |
| PHY-05-browser | Firefox or Chromium: tile, video fullscreen and back, its file dialogs |
| PHY-05-dialogs | A dialog-heavy application (for example LibreOffice or GIMP): transient dialogs float above their parent; monocle with a dialog (L07) |
| PHY-05-xwayland | An XWayland application (for example `QT_QPA_PLATFORM=xcb kate` or `xterm`): tiles and respects size increments |
| PHY-05-g14 | With a tiled window: window menu (`Alt+F3`) > More Actions > No Titlebar and Frame, then turn it back on |
| PHY-05-g15 | After tiling and a few resize steps, click titlebar buttons (minimize, maximize, close) and tabs of tiled Konsole, Dolphin and the browser |

For G14 you can also run `observe.py --windows 1` and toggle the border on the fixture: its configured size should grow by the decoration size and return exactly to the previous size.

- **Pass (TEST_MATRIX §4, G14, G15):** windows tile without overlap and keep their tiles; dialogs float; fullscreen and maximize are respected and restored; G14: the frame stays in its slot and turning the border back on restores the previous geometry without drift; G15: every click lands on the control under the pointer.

### P6. Input-to-visible latency (P00-P03)

Consent: C2 (if you rebind), C3, and C4 only if you choose `--toggle dbus`.

**What is measured.** For each sample, the injector reads `CLOCK_MONOTONIC` immediately before the `write()` that carries the trigger key's press (the kernel's evdev timestamp lies between that and the end of the write, recorded as `inputWriteNs`). Fixture windows log the xdg configures they receive, the commits that ack them, and `wp_presentation` feedback for those commits, on the same clock. Per sample:

- `inputToFirstPresentNs`: first presentation of any commit answering a configure caused by this input ([PERFORMANCE §3](PERFORMANCE.md#3-metrics) input-to-first-visible);
- `inputToSettledNs`: presentation of the commit answering the last configure of every affected window, the slowest window (t9_settled).

It excludes keyboard hardware and USB polling before the write, and the panel's response after KWin's reported presentation time; a photodiode or high-speed camera would be needed for those. VRR is not covered: the reference machine reports VRR as incapable.

Keep your desktop effects as they are, identical for every workload ([PERFORMANCE §6](PERFORMANCE.md#6-experimental-protocol): do not disable features for one side only). KWin effects that animate maximize or tiling transitions (the reference machine loads `maximize`, among others) can delay the *visual* end of a P00/P02 transition after the first presentation; the session report lists the loaded effects so the comparison can be interpreted.

**Workloads** ([`tools/physical/workloads.json`](../../tools/physical/workloads.json)), all on the same N fixture windows:

| Workload | Condition | Chords (actions) | Expected effect |
|---|---|---|---|
| P00-maximize | No tiler loaded | KWin *Maximize Window* toggle (`Meta+PgUp`) | Resize of the active window |
| P02-quicktile | No tiler loaded | *Quick Tile Left* once, then alternating *Quick Tile Top* and *Bottom* (`Meta+Left`, `Meta+Up`, `Meta+Down`); this alternates left half and top-left quarter and never repeats a mode, so the window never jumps to another output (observed source: kwin v6.7.5 `src/window.cpp`, `combineQuickTileMode`, `handleQuickTileShortcut`) | Resize |
| P00-switch (optional) | No tiler loaded | *Switch to Window to the Right* (`Meta+Alt+Right`); KWin must place the fixtures with distinct centres, which its placement did in the nested runs, otherwise the chords have no effect and the run stops | Activation change |
| P03-ratio | Plastile loaded | Grow and Shrink focused tile, alternating | Every window in the context resizes |
| P03-swap | Plastile loaded | Swap with master, repeated | Two windows exchange slots of different sizes |
| P03-focus | Plastile loaded | Focus next | Activation change; Plastile must issue zero solves and zero writes |

The matched baselines for the verdict are P02-quicktile for P03-ratio and P03-swap, and P00-switch for P03-focus. All other pairs are reported as controls; a master/stack ratio change is not the same action as a quick tile ([PERFORMANCE §5](PERFORMANCE.md#5-workload-suite)). Direct placement (P01) and third-party tilers such as Polonium are not part of this kit: P01 needs the timing probe loaded into the live KWin, and comparing another tiler needs its installation (both would be further consent points).

**Bindings.** The orchestrator reads your active chords from `kglobalshortcutsrc` and injects exactly those. Since the D10 fix, Grow, Shrink and Suspend default to `Meta+Ctrl+=`, `Meta+Ctrl+-` and `Meta+Ctrl+S` ([SHORTCUTS](../user/SHORTCUTS.md#default-bindings-measured-with-real-key-presses)); earlier builds registered `Meta+Shift+=`, `Meta+Shift+-` and `Meta+Shift+S`, and the first two never reach Plastile. If an earlier build was ever loaded in this session, kglobalaccel may still hold those chords as your active bindings (not tested): check the bindings `session_check.py` prints, and rebind in System Settings > Keyboard > Shortcuts > KWin (C2) if needed. If a binding is missing, the run refuses to start; if a chord has no effect, the block stops after 10 misses. The text-to-keycode mapping assumes a US layout; on another layout pass `--binding ACTION=KEY_LEFTMETA+KEY_LEFTCTRL+KEY_EQUAL` style evdev names.

**Steps, once per refresh rate** (DP-1 60 Hz, DP-2 100 Hz, HDMI-A-1 144 Hz):

1. Switch the output under test to an empty virtual desktop and leave the pointer on it. New fixture windows open on the active output; the run checks this from the refresh interval in their presentation feedback and stops if they opened elsewhere (outputs with equal refresh rates cannot be told apart this way; check visually then).
2. Preview the randomized plan: `python3 tools/physical/orchestrate.py plan --rounds 5 --samples 1000 --windows 4 --seed 60`.
3. Run it:

```sh
systemd-inhibit --what=idle:sleep --why="Plastile latency" \
  python3 tools/physical/orchestrate.py run --output DP-1 --rounds 5 --samples 1000 --warmup 50 \
    --windows 4 --workloads P00-maximize,P02-quicktile,P00-switch,P03-ratio,P03-swap,P03-focus \
    --toggle manual --seed 60 --out "$RUN/latency-60hz"
```

   Each round runs every workload once in a new random order; each block is one run of 50 warmup taps (written to `warmup.jsonl`, never pooled) and 1000 measured taps, paced by the windows going quiet plus a random 30-90 ms gap. Five rounds give each workload 5 runs and 5000 samples, the minimum for a p99 ([PERFORMANCE §6](PERFORMANCE.md#6-experimental-protocol)). With `--toggle manual` you are asked to enable or disable Plastile in System Settings when the condition changes; the script verifies it read-only. Expect very roughly 2-4 minutes per block, so 1-2 hours per refresh rate.

4. Optional scaling runs: add `--windows 2,4,8` for the P03 workloads. Windows that do not fit (Plastile overflow) invalidate a block; the summary flags it.

The summary is written at the end (`summary.json`, `summary-redacted.json`) and can be recomputed from the raw logs at any time with `python3 tools/physical/orchestrate.py correlate "$RUN/latency-60hz"`, or pooled across directories with `python3 tools/physical/summarize.py "$RUN"/latency-*/samples.jsonl --warmup "$RUN"/latency-*/warmup.jsonl --json "$RUN/latency-summary.json"`.

**What the summarizer guarantees.** Per run and pooled median, p95, p99 and max (nearest-rank quantiles); p99 is printed only when its sample count is at least 5000; failed samples are counted by reason, never dropped; confidence intervals resample whole runs (blocks); per-block checks flag aborted blocks, Plastile overflow or errors, focus commands that wrote geometry, and presentations off the refresh grid.

- **Record:** the four `latency-*` directories; the printed summaries; any `CHECK:` lines.
- **Pass (PHY-06-60/100/144, [PERFORMANCE §4](PERFORMANCE.md#4-proposed-budgets) "physical input-to-first-visible"):** for each refresh rate and each Plastile workload against its matched baseline, the median difference is below one output refresh interval and the p95 difference is at most one interval, with at least 5 runs and 5000 samples per side (the summarizer's verdict `pass`); success rate reported with every failure reason; P03-focus blocks show zero solves and writes. A `fail` verdict is a fail; `inconclusive` means more data is needed, not a pass. These budgets are proposed targets: report the actual values in any case.

### P7. Shortcuts on the real keymap (D10 and the tile editor)

Consent: C3.

1. With Plastile loaded and your current bindings, press every bound Plastile chord once through the virtual keyboard while three fixture windows are focused:

```sh
python3 tools/physical/orchestrate.py keys --out "$RUN/keys"
```

   It reads Plastile's command counter (through the journal) before and after each chord and prints `delivered`, `NOT delivered` or `unknown` (no counters in the journal). It skips *Suspend/resume tiling* (it suspends tiling; test it by hand) and the inspect and reload commands. Because the injector sends key codes and KWin applies your keyboard layout, this tests the chords on your real keymap; the text-to-keycode step assumes a US layout.

2. By hand, with your real keyboard: press your *Suspend/resume tiling* chord (default `Meta+Ctrl+S`): tiling must suspend, and pressing it again must resume it. Press `Meta+Shift+S`: it should start Spectacle's region capture and leave Plastile alone (Esc closes Spectacle); press `Meta+T` with Plastile loaded: KWin's tile editor must open (Esc closes it); quick-tile a tiled window with `Meta+Left`: Plastile must yield it (L13), and *Adopt natively tiled window* must take it back.

- **Record:** `$RUN/keys/keys.json`, and what the manual chords did.
- **Pass:** PHY-07a: every default chord reaches Plastile, or the ones that do not are listed in the checklist note (in nested KWin 6.7.5 all injected defaults did after the D10 fix; the earlier `Meta+Shift+=` and `Meta+Shift+-` did not). PHY-07b: the tile editor opens with Plastile loaded and Plastile does not fight a native quick tile.

### P8. Soak and idle

Soak (P15, Q09): several hours of normal use with Plastile loaded.

```sh
python3 tools/physical/soak.py sample --interval-min 10 --duration-h 4 --out "$RUN/soak"
```

Every interval it records `kwin_wayland`'s RSS, CPU time and context switches from `/proc`, and Plastile's connection, window, context and error counts. The summary gives first, last, maximum and a least-squares slope per hour for each series.

Idle (C14): Plastile loaded versus not loaded, in a seeded random order, three periods each, with your hands off the machine:

```sh
python3 tools/physical/soak.py idle --seconds 300 --repeats 3 --toggle manual --out "$RUN/idle"
```

With Plastile loaded it also snapshots Plastile's counters before and after each idle period, so any flush, deadline, solve or write during idle shows up directly.

- **Pass:** PHY-08a: Plastile's connection and tracked-window counts follow the number of open windows and do not climb steadily at a stable window count; `errors` stays 0; no monotonic RSS growth that persists across hours (PERFORMANCE §4 "post-warmup resource counts"). PHY-08b: zero Plastile flushes, deadlines, solves and writes during idle, and no kwin CPU or context-switch increase beyond the spread of the unloaded periods. Never report "0 % CPU".

### P9. G1 physical repeat (optional, consent)

ADR-003 ([DECISIONS](../design/DECISIONS.md#adr-003-direct-geometry-is-provisional-compare-native-tiles-early)) chose direct geometry over native tiles from a nested-only comparison and lists a physical repeat as part of G3. That repeat loads the M1 spike packages (`probes/spikes/direct`, `probes/spikes/native`) and one-shot oracle scripts into the live KWin (consent C8). `probes/spikes/run.py` only drives disposable nested sessions; this kit does **not** automate a live-session repeat, and no step here loads spike code into your session.

If you consent and want the decisive part checked physically with the production backend instead, run `observe.py --windows 3 --fixture-arg=--configure-delay-ms --fixture-arg=300`, let Plastile tile the three delayed fixtures, then press Grow and Shrink within 300 ms in one phase: the window that was resized must end at its original (A) size, with at most one correction in the counter delta (the nested G05 result). Record this under PHY-09 with a note that it is the production-backend variant, not the spike comparison.

## 6. Uninstall and clean up

1. Untick Plastile in System Settings > Window Management > KWin Scripts and Apply. Plastile disconnects its signals, stops its timer, restores borders it changed and leaves windows where they are.
2. `tools/install.sh remove`, then `tools/install.sh status` (expect `installed : no`).
3. Optional configuration clean-up (by hand; the kit never does it): remove the `[Script-plastile]` group and the `plastileEnabled` line from `~/.config/kwinrc`, and the `plastile.*` entries under `[kwin]` in `~/.config/kglobalshortcutsrc` (see [INSTALL](../user/INSTALL.md#6-uninstall-cleanly)). Reset any shortcuts you rebound for P6 and P7.
4. Undo the other consent steps: output scales and priorities (C5), test panels (C7), test activities (C6), and the uinput ACL: `sudo setfacl -x u:$USER /dev/uinput` (or reboot).
5. `python3 tools/physical/session_check.py --no-json` should report Plastile not installed and not loaded.
6. `artifacts/physical/` stays on your machine until you delete it.

- **Pass (PHY-10, Q11):** the package is gone, nothing is loaded, windows and outputs are as you left them.

## 7. Reporting and publishing

```sh
python3 tools/physical/checklist.py show "$RUN"
python3 tools/physical/checklist.py report "$RUN" --publish docs/status/evidence/physical-<stamp>.json
```

`report` validates the checklist (a fail, blocked or skipped item needs a note), merges the session report, latency summaries, observe phases and soak/idle summaries, and prints the physical gate state and a draft TEST_MATRIX §8 version row. The physical gate is closed only when every required item (all except PHY-09) passes. Review the redacted file before committing it.

## 8. Known limitations of the kit

- The uinput path, the live driver, the journal-based counters and every live-session tool have only been tested against fakes and refusal cases; their first real run is the user's.
- Position-only changes produce no client commit, so `wp_presentation` cannot time them. The workloads are chosen so that every sample resizes a window or changes its activation; a swap between two equal-sized slots would not be measurable.
- Presentation times are those KWin reports to the client. They are not photon times, and the nested dry runs use the virtual backend's synthetic 60 Hz timeline.
- `kglobalshortcutsrc` can lag KGlobalAccel's in-memory state right after a change; confirm a rebinding with `session_check.py` before a run.
- The harness runs on the machine it measures. Its pipe reading is event-driven, and the same load is present in every condition.
- Text-to-keycode mapping assumes a US layout; non-US layouts need evdev names in `--binding`.
