# plastile-xclient

A small, controllable X11 (xcb) client for measuring how KWin and Plastile treat
XWayland windows and their ICCCM/EWMH hints: minimum/maximum size, size
increments, aspect ratio, fixed size and transient dialogs (TEST_MATRIX G10).
It is a test fixture only. It is not part of any Plastile runtime.

Run it only against a disposable nested session's Xwayland (a `kwin_wayland
--virtual --xwayland` started by `tools/nested.py` / `tests/integration/harness.py`),
with `DISPLAY` set to that session's display. Never point it at the desktop's own
display. `tests/integration/scenarios_xwayland.py` discovers the nested display from the
X lock file owned by the nested KWin PID (KWin owns the socket and starts Xwayland
lazily on the first X connection).

## Build

Requires `libxcb`, `xcb-util-wm` (`xcb-icccm`), `pkg-config` and a C11 compiler.

```sh
make            # -> build/plastile-xclient (-std=c11 -Wall -Wextra -Werror -O2)
make clean
```

## CLI

| Flag | Meaning |
|---|---|
| `--title STR` | `WM_NAME` and `_NET_WM_NAME` (default `plastile-xclient`). The dialog is titled `<title> dialog`. |
| `--class STR` | `WM_CLASS` instance and class (both set to STR; default `plastile-xclient`). |
| `--size WxH` | Initial window size and `WM_NORMAL_HINTS` size (default 400x300). |
| `--min WxH`, `--max WxH` | `WM_NORMAL_HINTS` min/max size (main window only). |
| `--inc WxH` | `WM_NORMAL_HINTS` resize increments, with base size = `--min` (or 0x0). |
| `--aspect N:M` | `WM_NORMAL_HINTS` aspect, min aspect = max aspect = N:M. |
| `--fixed` | min = max = `--size`. |
| `--dialog` | Also map a 300x200 second window with `WM_TRANSIENT_FOR` = main and `_NET_WM_WINDOW_TYPE_DIALOG`. |
| `--exit-after-ms N` | Exit cleanly after N ms (timerfd). |

Both windows set `WM_PROTOCOLS` (`WM_DELETE_WINDOW`), `_NET_WM_PID`, `WM_CLIENT_LEADER`
and `_NET_WM_WINDOW_TYPE` (`NORMAL` for the main window). Each window is filled with a
solid colour derived from the title (background pixel plus a repaint on expose/resize).
The client accepts every size the window manager configures; it never re-requests
its own size except on the `resize` command.

## stdin commands

| Command | Effect |
|---|---|
| `resize W H` | `ConfigureWindow` width/height on the main window (a client-initiated resize request). |
| `quit` | Exit cleanly. End of stdin is logged and otherwise ignored. |

A close request (`WM_DELETE_WINDOW`) on the main window exits; on the dialog it destroys the dialog only.

## Log (JSON Lines on stdout)

Every record has `t_ns` (CLOCK_MONOTONIC nanoseconds) and `ev`. Window records carry `win`
(`main` or `dialog`).

| `ev` | Fields |
|---|---|
| `start` | pid, display, options, root size |
| `size_hints` | the `WM_NORMAL_HINTS` flags and values written |
| `create`, `map_request`, `map`, `unmap`, `destroy` | window lifecycle (`create` has xid, title, class, type, transient) |
| `reparent` | new parent, whether it is the root |
| `configure` | `x`, `y` (relative to the parent, i.e. inside KWin's frame after reparenting), `w`, `h`, `border`, `resized`, `synthetic`, running count `n` |
| `expose` | exposed rectangle and count |
| `property` | property atom name changed on the window (e.g. `_NET_WM_STATE`, `_NET_FRAME_EXTENTS`) |
| `command`, `resize_request`, `close_requested`, `stdin_eof` | input handling |
| `error` | X errors and usage problems |
| `exit` | reason (`quit`, `close`, `exit-after`, `display-error`), code, configure count |

The ConfigureNotify size is what the X server applied to the client window. It is not
proof that a frame was presented.
