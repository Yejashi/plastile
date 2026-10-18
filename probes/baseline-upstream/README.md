# Upstream baseline (T04): Polonium vs Plastile

This probe runs an upstream automatic tiler, Polonium, and the Plastile package. Both get the same three fixture clients, the same workload and the same oracle. Each tiler runs in its own disposable nested KWin on the virtual backend.

Everything here is a nested-session measurement. It is not a physical-session or presentation measurement. Commands go through the kglobalaccel D-Bus API (`invokeShortcut`), not through input devices.

## Files

- `run.py` runs one measurement and writes raw output to `artifacts/baseline-upstream/<stamp>/`. The output covers each tiler's `kwin.log`, `fixture-*.jsonl` and `samples.json`, plus a `summary.json`.
- `aggregate.py` pools the repetitions and the control runs into `docs/status/evidence/baseline-upstream.json`.

## Upstream package (research pin)

- **Pin:** `227967ed448205d42b5e63e4cc4b868d72606467` (SOURCE_INDEX P04).
- **Package used:** the GitHub release asset `nightly/polonium.kwinscript`, version 1.2.2, sha256 `b7c18863…fa15`. No tagged release exists for 1.2.2; the latest tag is v1.2.1.
- **Verified equal to the pin.** The pin source archive (`archive/<pin>.tar.gz`) has a pax comment that holds the pin commit. Every package file was compared with that archive:
  - The QML files, `config.ui`, `main.xml` and `main.js` are identical.
  - `metadata.json` is `res/metadata.json` after the Makefile's `%NAME%` and `%VERSION%` substitution.
  - `contents/code/main.mjs` was rebuilt from the pin in a separate directory. The rebuild is byte-identical (sha256 `08245872…1d91`).
- **Rebuild steps.** Copy `package.json`, `package-lock.json`, `tsconfig.json` and `src/` out of the extracted tree, then run:
  - `npm ci --ignore-scripts`
  - `node_modules/.bin/esbuild --bundle src/index.ts --outfile=polonium.mjs --format=esm --platform=neutral`

  That esbuild command is the Makefile's `polonium.mjs` rule. The Makefile itself was read but never run, because its `install` target writes into `$HOME`.

Download into fresh directories under `/tmp/claude-1000/upstream/` and treat the downloads as untrusted data:

```
curl -L -o .../nightly-zip/polonium.kwinscript https://github.com/zeroxoneafour/polonium/releases/download/nightly/polonium.kwinscript
curl -L -o .../polonium-pin.tar.gz https://github.com/zeroxoneafour/polonium/archive/227967ed448205d42b5e63e4cc4b868d72606467.tar.gz
```

The package is installed only into the nested session's private data home: `kpackagetool6 -t KWin/Script -i` with `env=NestedKwin.env()`, run in the `prepare` hook before KWin starts. It is enabled by `[Plugins] poloniumEnabled=true` in that session's kwinrc. Polonium's configuration is read from `[Script-polonium]`.

## The Activities service is required for Polonium

Polonium builds its display keys from `window.activities` (src/controller/event.ts `Display.generateWindow`). In the default harness session there is no Activities service. There, `workspace.currentActivity === ""` and every window has `activities.length === 0`. Polonium then registers windows but never rebuilds a layout: the windows stay overlapped and no command produces a configure. This was measured; see `controls.noActivitiesService` in the evidence.

`run.py` therefore starts `/usr/lib/kactivitymanagerd` on the session's private bus in the `prepare` hook, with the session's private XDG dirs and `QT_QPA_PLATFORM=offscreen`. It starts it for both tilers, so the environments are identical. It is terminated by the PID the script started. `--no-activities` reproduces the failure.

## Workload and metrics

The workload uses 3 fixtures (`--ssd`), with fixture 1 made active. For each spacing (25 ms primary, 250 ms sparse), it runs 100 swap-like commands, then 100 resize-like commands:

| | swap-like | resize-like |
|---|---|---|
| Polonium | `PoloniumPlaceRight` / `PoloniumPlaceLeft` alternating ("place window in direction" moves the window into the neighbouring tile; Polonium has no pure swap) | `PoloniumResizeRight` / `PoloniumResizeLeft` alternating (`Tile.resizeByPixels`, 10 px) |
| Plastile | `plastile.swap.right` / `plastile.swap.left` alternating | `plastile.resize.grow` / `plastile.resize.shrink` alternating |

Each metric comes from a source that is independent of both tilers:

- **Latency:** the harness send time (`CLOCK_MONOTONIC`, taken just before the D-Bus call) to the first `configure` record in any fixture log, within `[t_send, t_next_send)`. The fixture logs also use `CLOCK_MONOTONIC`.
  - At 25 ms spacing, a reply later than 25 ms would be attributed to the next command. The 250 ms pass checks for that censoring.
  - A pure move sends no configure, so this metric only sees size or state changes.
- **Churn:** configures per command, summed over all fixtures.
- **Fights:** configures arriving ≥ 1 s after a phase's last command, within a 2 s observation window.
- **Geometry:** one-shot KWin oracle frames judged by `harness.tiling_errors` (inside the work area, no overlap), after every phase.

The layouts differ, and the comparison is not layout-identical. Polonium's default BTree uses 4 px gaps and puts window 2 on the right at full height. Plastile's master-stack uses 8 px gaps.

## Results (measured, KWin 6.7.5, nested virtual backend)

There were 3 repetitions. Every sample is pooled, giving n = 300 commands per cell; no samples were dropped. Latency is send → first fixture configure, in ms.

| tiler | phase | p50 | p95 | p99 | configures/cmd | idle configures | oracle errors |
|---|---|---|---|---|---|---|---|
| Polonium | swap @25 | 12.24 | 13.44 | 13.85 | 3 | 0 | 0 |
| Polonium | resize @25 | 0.69 | 0.90 | 1.68 | 3 | 0 | 0 |
| Polonium | swap @250 | 11.55 | 12.68 | 13.88 | 3 | 0 | 0 |
| Polonium | resize @250 | 0.73 | 0.98 | 1.57 | 3 | 0 | 0 |
| Plastile | swap @25 | 0.95 | 1.48 | 1.78 | 2 | 0 | 0 |
| Plastile | resize @25 | 0.96 | 1.31 | 1.86 | 3 | 0 | 0 |
| Plastile | swap @250 | 0.99 | 1.79 | 2.02 | 2 | 0 | 0 |
| Plastile | resize @250 | 1.01 | 1.57 | 2.23 | 3 | 0 | 0 |

Every command produced at least one configure, for both tilers. Teardown completed for both: the script was unloaded, `isScriptLoaded` was false afterwards, and kactivitymanagerd was terminated.

**Control: Polonium with `RebuildDelay=1` (default 10).** Swap latency was 3.03 / 3.80 / 4.33 ms (p50 / p95 / p99, n = 100 at 25 ms spacing). This measures that about 9 ms of Polonium's swap latency is its debounce timer. The source shows the same thing: `config.ts` sets `RebuildDelay` to 10 by default, and the controller's `eventTimer` waits for it before every layout rebuild. Polonium's resize calls `resizeByPixels` synchronously inside the shortcut handler, which is why it is about 0.7 ms.

## Not shown here

These results do not show any of the following:

- presentation or frame timing
- physical input latency
- multi-output behaviour
- behaviour with real applications
- QV4 engine time

## Reproduce

```
python3 probes/baseline-upstream/run.py                                   # x3 (primary)
python3 probes/baseline-upstream/run.py --tilers polonium --polonium-config RebuildDelay=1
python3 probes/baseline-upstream/run.py --no-activities --commands 20 --spacings-ms 25 --polonium-config LogLevel=3
python3 probes/baseline-upstream/aggregate.py --primary S1,S2,S3 --control-rebuild-delay S4 \
    --control-no-activities S5 --provenance probes/baseline-upstream/provenance.json
```
