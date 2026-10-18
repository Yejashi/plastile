# plastile-state: the persistence helper

A small session-bus service that stores Plastile's saved session preferences, so that KWin's
compositor thread never does persistence file I/O ([ADR-020](../docs/design/DECISIONS.md#adr-020-persistence-goes-through-an-asynchronous-d-bus-helper)).
Plastile calls it asynchronously through KWin's `DBusCall`. Without it Plastile works and keeps
its preferences in memory only (one `persistence unavailable` diagnostic).

## Interface

Bus name `org.kde.plastile.State`, object `/State`, interface `org.kde.plastile.State`:

| Method | Reply | Meaning |
|---|---|---|
| `Read()` | `as` | The stored text of slot 0 and slot 1, always two entries; `""` for a slot that is absent or unreadable. |
| `Write(i slot, s text)` | `b` | Atomically replace a slot's text. `true` once stored; `false` when the file could not be written (the reason is logged). A slot other than 0 or 1, or a text over 1 MiB (UTF-8), is refused with `org.freedesktop.DBus.Error.InvalidArgs`. |

The helper never interprets the text: Plastile's TypeScript side validates the schema
(`src/persist/snapshot.ts`). It only makes sure a stored file becomes a valid D-Bus string: bytes
that are not UTF-8 and NUL characters reach Plastile as U+FFFD, so a damaged file is reported as
damaged. Requests are processed one at a time, in arrival order.

## Files and lifetime

- `$XDG_STATE_HOME/plastile/state-0.json` and `state-1.json` (`QStandardPaths::GenericStateLocation`,
  default `~/.local/state`). The directory is made 0700 and the files 0600 (a slot made read-only,
  by restoring a backup say, is made writable again first). Each write is a
  `QSaveFile` commit: a temporary file, `fsync`, then a rename onto the slot. The `fsync` blocks
  only the helper.
- No lock file: owning the bus name is what makes one helper the only writer. A second instance
  cannot get the name and exits with status 1.
- The session bus starts the helper on the first call (D-Bus activation, the
  `org.kde.plastile.State.service` file). It exits after 60 s without a request, giving its name
  back first; the next call starts it again. It also exits when the bus goes away.
- Logging: category `plastile.state`. Failures are warnings; one line per request at debug level
  (`QT_LOGGING_RULES=plastile.state.debug=true`).

## Build and install

```sh
cmake -S helper -B build/helper -DCMAKE_BUILD_TYPE=Release
cmake --build build/helper
tools/install.sh install-helper     # builds, installs into ~/.local and asks the bus to reload
tools/install.sh remove-helper
```

Installing with CMake directly: choose the prefix when configuring
(`-DCMAKE_INSTALL_PREFIX=$HOME/.local`, then `cmake --install build/helper`). The activation
file's `Exec=` and its directory are fixed at configure time, so `cmake --install --prefix`
puts the binary somewhere the activation file does not name.

It needs CMake, a C++17 compiler and the Qt 6 (6.5 or later) Core and DBus development files.
`install-helper` puts the binary in `$PLASTILE_HELPER_PREFIX/libexec` (default `~/.local`) and
the activation file in `$XDG_DATA_HOME/dbus-1/services`, where the session bus looks. The release
builds a source tarball, `dist/plastile-state-<version>.tar.gz` (`tools/release.py`); the
`.kwinscript` itself stays script-only.

## Test-only knobs

These exist for the nested scenarios (`tests/integration/scenarios_persist.py`) and are never needed
in normal use:

- `PLASTILE_STATE_TEST_DELAY_MS`: wait this long before processing each request (a slow helper).
- `PLASTILE_STATE_TEST_IDLE_MS`: the idle period before exiting (default 60000).
