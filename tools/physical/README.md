# Physical-session validation kit

Tools for the checks that only a real Plasma 6 Wayland session can run. The procedure, the consent points and the pass criteria are in [docs/validation/PHYSICAL_RUNBOOK.md](../../docs/validation/PHYSICAL_RUNBOOK.md); read it before running anything here against your session.

None of these tools has run in a physical session yet. What was validated in the cloud container and in the nested KWin sandbox is listed in [§1 of the runbook](../../docs/validation/PHYSICAL_RUNBOOK.md#1-what-was-validated-where).

## Safety contract

- Every live-session entry point refuses to run unless `XDG_SESSION_TYPE=wayland`, the `WAYLAND_DISPLAY` socket is served by a non-nested `kwin_wayland` (or `kwin_wayland_wrapper`) of the same user, `org.kde.KWin` on the session bus belongs to that same process, and that KWin reports the DRM output backend in `supportInformation` (`common.guard_live_session`). The backend check catches a nested KWin started without a backend flag (a nested Plasma, or `kwin_wayland --socket X` from a terminal), whose command line looks physical. The C injector repeats all of these checks itself (the bus ones through `busctl`) before it opens `/dev/uinput`, and holds off `SIGINT`, `SIGTERM`, `SIGHUP` and job-control stops (Ctrl-Z) until a chord's key releases are sent.
- Nothing here writes `kwinrc` or `kglobalshortcutsrc`, and nothing restarts or replaces the compositor. Configuration files are only read.
- Python standard library only, plus the system's `busctl`, `kscreen-doctor` and `journalctl` (read-only use). The injector has no dependencies beyond the kernel headers.

## Files

| File | Role |
|---|---|
| [`keytap.c`](keytap.c), [`Makefile`](Makefile) | `plastile-keytap`: timestamped Meta-chord injector. `--backend uinput` (virtual keyboard, physical sessions), `--backend dry` (no device, tests). `make ei` builds `plastile-keytap-ei` with a libei backend for nested dry runs |
| [`latency.py`](latency.py) | Correlates injector taps with fixture `configure`/`commit`/`presented` logs on `CLOCK_MONOTONIC`; builds and validates PERFORMANCE §8 records (with the block's Plastile Motion state; no t9_settled when motion is on) |
| [`summarize.py`](summarize.py) | Per-run and pooled median/p95/p99/max, bootstrap-by-run CIs, p99 withheld below 5000 samples, verdicts against the matched baseline (or `missing`); groups never mix builds, KWin versions or motion states |
| [`orchestrate.py`](orchestrate.py) | `plan`, `run` (randomized blocks of P00/P02/P03 workloads in the live session), `correlate` (recompute from raw logs), `keys` (does every bound chord reach Plastile on the real keymap) |
| [`workloads.json`](workloads.json) | Workload definitions: condition, KWin/Plastile actions, expected effect, matched baseline |
| [`session_check.py`](session_check.py) | Read-only pre-flight report of the live session |
| [`observe.py`](observe.py) | Labelled phases with fixture windows while you change outputs, panels, activities or borders: convergence, reversals, output per window, counter deltas |
| [`soak.py`](soak.py) | `sample` (long-session resource series) and `idle` (Plastile loaded vs not, randomized) |
| [`checklist.py`](checklist.py) | Checklist of every physical item, and the private/redacted report bundle |
| [`nested_dryrun.py`](nested_dryrun.py) | Runs the same block engine in a disposable nested KWin with the libei injector. Results are labelled `nested-dry-run`, never physical |
| [`common.py`](common.py) | Guards, read-only KConfig and shortcut parsing, key-chord mapping, `/proc` readers |
| [`tests/`](tests) | Unit tests; no desktop needed. `tests/data/` holds trimmed fixture logs recorded in nested KWin 6.7.5 |

## Build and test

```sh
make -C tools/physical                        # build/physical/plastile-keytap (-Wall -Wextra -Werror)
python3 -m unittest discover -s tools/physical/tests
```

Nested dry run (inside the KWin sandbox, or on any machine with KWin, libei and python-dbus):

```sh
tools/sandbox/run.sh -- bash -euc 'npm run build && make -C fixtures/client && make -C tools/physical all ei'
tools/sandbox/run.sh -- python3 tools/physical/nested_dryrun.py --keys
```

The dry run first checks that both the uinput injector and the Python guard refuse the nested session, then runs randomized blocks of every workload, the per-chord delivery check with `--keys`, and writes `artifacts/physical/nested-<stamp>/`. `--binding ACTION=CHORD` stores a user binding in the nested `kglobalshortcutsrc` before KWin starts (kglobalaccel keeps it over the registered default); for example `--binding plastile.resize.grow=Meta+Shift+=` reproduces the pre-fix D10 default, which the `--keys` check reports as not delivered.
