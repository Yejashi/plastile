# plastile-fixture

A small, controllable raw-libwayland xdg-shell client for measuring how KWin
configures, accepts, and presents window geometry (backlog task T03). With
`--panel` it is instead a wlr-layer-shell panel that reserves an exclusive zone
(work-area scenarios, O07). It is a test fixture only. It is not part of any Plastile runtime and proves nothing
about tiling-engine performance by itself.

Run it only inside a disposable nested KWin (`kwin_wayland --virtual ...`) with
`WAYLAND_DISPLAY`/`XDG_RUNTIME_DIR` pointing at that session, unless a
physical-session check is deliberately intended.

## Build

Requires `libwayland-client`, `wayland-protocols`, `wayland-scanner`, `pkg-config`, and a C11 compiler.

```sh
make            # -> build/plastile-fixture (built with -Wall -Wextra -Werror -O2)
make clean
```

Protocol code (xdg-shell, presentation-time, xdg-decoration-unstable-v1) is
generated into `build/` from the installed `wayland-protocols`.

`wlr-layer-shell-unstable-v1` is not part of `wayland-protocols` and no
system-wide copy was installed on the development machine, so
`protocols/wlr-layer-shell-unstable-v1.xml` is a **vendored, unmodified copy**
of the upstream wlr-protocols XML (interface version 5, Copyright © 2017 Drew
DeVault, MIT-style permission notice retained in the file's `<copyright>`
element; upstream: https://gitlab.freedesktop.org/wlroots/wlr-protocols,
`unstable/wlr-layer-shell-unstable-v1.xml`; local sha256
`87e0b9c837aecd6977f76f3c47d73088b7159871f5d979dc1840f6cadb5e2ed8`, taken
byte-identical from the copy bundled in the `wayland-protocols-wlr` 0.3.12
crate). Only generated client glue is linked; no upstream C code is reused.

The final link writes `build/plastile-fixture.tmp` and renames it, so test
sessions that are running the old binary keep working during a rebuild.

## CLI

| Flag | Meaning |
|---|---|
| `--app-id STR` | xdg_toplevel app id (default `plastile-fixture`). KWin 6.7.5 reports it as `resourceClass`, `resourceName`, and `desktopFile`. |
| `--title STR` | Title (default `plastile-fixture <id>`). |
| `--id N` | Marker id, used for the fill color (default 0). |
| `--size WxH` | Initial size, used for the first buffer when the first configure is 0x0 (default 400x300). |
| `--min WxH`, `--max WxH` | `xdg_toplevel.set_min_size` / `set_max_size` (main window only). |
| `--fixed` | min = max = initial size. |
| `--clamp` | Clamp the configured size to the client's own min/max before committing. Without it, the client commits exactly what the compositor sends. |
| `--configure-delay-ms N` | Wait N ms after `xdg_surface.configure` before ack + new buffer + commit (timerfd; other events continue to be dispatched). |
| `--delay-mode latest\|each` | `latest` (default): a newer configure supersedes the pending one; only the newest is acked when the timer fires. The deadline is the first unanswered configure's deadline. It is not reset by newer configures, so a stream of configures cannot starve the client. `each`: each configure is answered in order, N ms after its own arrival. |
| `--ignore-size` | Ack configures but keep committing the current size (main window). |
| `--parent-after-ms N` | N ms after the main window maps, create a transient child (300x200, same app id, title `<title> child`, `set_parent(main)`). |
| `--exit-after-ms N` | Exit cleanly after N ms (counted from start). |
| `--exit-after-map-ms N` | Exit cleanly N ms after the main window mapped (its first buffer commit, which is flushed first). `0` destroys the window right after that flush; the compositor may handle the two in separate dispatches. |
| `--exit-on-map` | Commit the first buffer without flushing it, then destroy the window and exit, so the mapping commit and the destruction reach the compositor in one flush. The `commit` record carries `"flush_deferred": true`. Measured in nested KWin 6.7.5: KWin never reports such a window (no `windowAdded`/`windowRemoved`). |
| `--late-min-size W,H,MS` | MS ms after the main window mapped, set `xdg_toplevel.set_min_size(W, H)` with a bufferless commit (a client that knows its real minimum only once its content exists). Logged as `size_hints` with `reason:"late-min-size"`. Combine with `--clamp` to make the client refuse configures below the new minimum, as toolkits do. |
| `--start-maximized` | Call `xdg_toplevel.set_maximized` before the initial bufferless commit (main window only), so the compositor's first configure carries the `maximized` state and the window maps maximized. Logged as `start_maximized` in the `start` record. |
| `--remaximize-once` | An application that insists on being maximized: on the first configure without the `maximized` state that follows one with it, call `set_maximized` again before that configure is acknowledged (the request reaches the compositor before the ack). Once per run; logged as a `remaximize` record. |
| `--maximize-after-map` | Call `xdg_toplevel.set_maximized` right after the main window's mapping commit is flushed (a client that asks to be maximized only after its first commit). Logged as `maximize_requested` with `reason:"after-map"`. |
| `--ssd` / `--csd` | Request server-/client-side decoration through xdg-decoration. By default, no decoration mode is negotiated and the manager is not bound. |
| `--panel EDGE:SIZE` | Instead of an xdg_toplevel, create a `zwlr_layer_surface_v1` (layer `top`, namespace `dock`) anchored to EDGE (`top`, `bottom`, `left`, `right`) plus both perpendicular edges, `exclusive_zone` SIZE, keyboard interactivity none, requested size SIZE on the anchored axis and 0 (compositor fills) on the other. The window is logged as `win:"panel"`. Every configure is acked and answered with a buffer of exactly the configured size. `zwlr_layer_shell_v1` and `wl_output` (v4, for names) are bound only in this mode. Size flags, decoration, delay and child options do not apply. |
| `--output NAME` | Panel mode only: anchor the panel to the `wl_output` whose `name` event is NAME (for example `Virtual-1`). Without it the compositor chooses the output. An unknown name logs an `error` and exits with code 1. |
| `--panel-scope NAME` | Panel mode only: the layer-surface namespace instead of `dock`. KWin types the window by it, and a namespace it does not list (for example `waybar`) gives a normal, unmanaged window that still reserves its exclusive zone (observed source: kwin v6.8.1 `src/layershellv1window.cpp`). |

The delay, ignore-size, and decoration settings also apply to the child. A
configure size of 0 on an axis uses the current size on that axis. At most one of
`--exit-after-ms`, `--exit-after-map-ms` and `--exit-on-map` may be given, and the
exit, late-minimum and maximize options are refused in panel mode.

## Control commands (stdin, one per line)

`resize W H` (an app-initiated resize: commit a W×H buffer with no configure) ·
`maximize` / `unmaximize` (`xdg_toplevel.set_maximized` / `unset_maximized`, the application's own request) ·
`min W H` / `max W H` (set the hint and make a bufferless commit; 0 = unset) ·
`child` · `close-child` · `close-main` (destroy the main toplevel and keep the child
open, an orphaned dialog; logs `main_destroyed`, and later commands other than
`close-child` and `quit` log an `error`) · `title STR` · `quit`.
In panel mode only `quit` is accepted; other commands log an `error`.
Each command is logged as a `command` event. Unknown commands or bad arguments
log an `error` event. EOF on stdin logs `stdin_eof` and stops reading stdin.
The client keeps running after EOF. Use `</dev/null` with `--exit-after-ms`, or
a FIFO, to drive it.

## Rendering marker

Every commit uses a fresh buffer from a pool. A buffer is reused only after
`wl_buffer.release`, with at most 16 buffers per surface. The buffer is filled
with a solid XRGB8888 color:

```
x = (uint32)(id * 2654435761) ^ (uint32)(seq * 2246822519)
x ^= x >> 15; x *= 2246822519; x ^= x >> 13; x *= 3266489917; x ^= x >> 16
R = 0x40 + ((x >> 16) & 0x7f); G = 0x40 + ((x >> 8) & 0x7f); B = 0x40 + (x & 0x7f)
```

The top-left corner holds a 2-row × 16-column strip of 16×16 px cells encoding
the 32-bit `seq`. Row 0 holds bits 31..16 and row 1 holds bits 15..0, with the
most significant bit leftmost. White (`0xFFFFFF`) is 1 and black (`0x000000`)
is 0. The fill channels stay in 0x40..0xBF, so fill pixels are never pure
black or white. The strip needs 256×32 px and is clipped on smaller buffers.
`seq` is a single process-wide counter (main and child share it), starting at 1.

## Log schema (JSON Lines on stdout, one flush per line)

Every record has `t_ns`, which is `CLOCK_MONOTONIC` in nanoseconds taken when
the record is written, and `ev`. Window-scoped records carry `win`
(`"main"`/`"child"`, or `"panel"` in panel mode).

| `ev` | Fields |
|---|---|
| `start` | `pid`, `args`, `app_id`, `id`, `title`, `size`, `min`/`max` (if set), `configure_delay_ms`, `delay_mode`, `ignore_size`, `clamp`, `exit_on_map`/`exit_after_map_ms`/`late_min_size` (if set), `decoration_request`, `log_clock` |
| `bound` | `globals.{wl_compositor,wl_shm,xdg_wm_base,wp_presentation,zxdg_decoration_manager_v1,zwlr_layer_shell_v1,wl_output}.{advertised,bound}` (null = absent/not bound) |
| `presentation_clock` | `clk_id`, `name`, `same_as_log_clock` |
| `initial_commit` | The bufferless initial commit: `title`, `width`, `height` (intended size). Panel mode: `shell:"layer"`, `layer`, `scope`, `edge`, `exclusive_zone`, `width`/`height` (requested; 0 = compositor fills), `output` (requested name or null), `outputs` (all bound output names) |
| `wm_capabilities` | `caps` |
| `decoration` | `mode` (from `zxdg_toplevel_decoration_v1.configure`) |
| `configure` | Panel mode: `zwlr_layer_surface_v1.configure` with `serial`, `width`, `height`, `states:[]`, `shell:"layer"`, `n`. Otherwise: `serial` (xdg_surface), `width`, `height`, `states` (`maximized`, `fullscreen`, `resizing`, `activated`, `tiled_*`, `suspended`, `constrained_*`, `unknown_N`), `bounds` (if sent), `decoration` (if negotiated), `n` (per-window count). Logged when `xdg_surface.configure` arrives, combined with the preceding toplevel data. |
| `superseded` | `serial` replaced by `by_serial` (latest mode), or `why:"queue_full"` (each mode, 64 deep) |
| `ack` | `serial`, `delay_ns` (ack time − configure arrival) |
| `commit` | `seq`, `width`, `height`, `serial` (acked in this commit, or null), `reason`: `initial` \| `configure` \| `app-resize` \| `ignore-size`. Logged right after `wl_surface_commit` + `wl_display_flush`. |
| `mapped` / `child_mapped` | First buffer commit (client view, not proof of visibility); `child_gen` for the child |
| `frame_done` | `seq`, `cb_time_ms` (compositor-supplied, ms, unspecified base) |
| `presented` | `seq`, `present_ns` (= `tv_sec`·1e9 + `tv_nsec`, presentation clock), `tv_sec`, `tv_nsec`, `refresh_ns`, `seq_hi`, `seq_lo`, `flags_raw`, `flags` |
| `discarded` | `seq` |
| `size_hints` | `min`, `max` (0 = unset); with `--late-min-size` also `reason:"late-min-size"`, `current_width`, `current_height` |
| `maximize_requested` | `reason:"after-map"` (`--maximize-after-map`) |
| `remaximize` | `serial` of the configure that un-maximized the window (`--remaximize-once`) |
| `title_set`, `command`, `stdin_eof`, `signal`, `global_removed` | as named |
| `main_destroyed` | `close-main` destroyed the main toplevel; `child_exists` |
| `close_requested` | `xdg_toplevel.close` (or, in panel mode, `zwlr_layer_surface_v1.closed`, with `shell:"layer"`) received. The main window exits cleanly. The child is destroyed (`child_destroyed`). |
| `error` | `msg` |
| `exit` | `reason` (`close`, `quit`, `exit-after`, `exit-after-map`, `exit-on-map`, `signal`, `display-error`, …), `code`, `commits` |

A frame callback and, when `wp_presentation` is advertised, a presentation
feedback are requested for every buffer commit.

## Limitations

- Buffer scale is always 1. The client ignores fractional-scale,
  viewporter, preferred-buffer-scale, and output enter/leave (`wl_compositor`
  is bound at v4; `wl_output` is bound only in panel mode, for its name). The fixture is not a fractional-scaling oracle yet.
- KWin 6.7.5 (nested, measured) reports the panel as `dock: true`,
  `windowType: 2` (Dock), `managed: true`, empty `caption`, and
  `resourceClass`/`resourceName` `plastile-fixture` (a layer surface has no app
  id; KWin derives the class from the client process). Harness oracles that
  select windows by `resourceClass` therefore also see the panel; filter on
  a non-empty caption or `dock`.
- No input handling, no interactive move/resize requests, and no client-side
  decorations are drawn, even with `--csd`.
- Every configure is answered with a newly rendered buffer, including
  configures with an unchanged size, as a simple and observable policy.
- `mapped` is the client's first buffer commit. Only `presented`
  shows that a frame reached the display path, and on the virtual backend
  that is a software timeline, not physical scanout.
- `t_ns` is taken after the request is flushed. A `presented.present_ns`
  in `CLOCK_MONOTONIC` can therefore be compared with `t_ns` directly, but it
  is a compositor-reported time. In nested KWin 6.7.5 it was occasionally
  slightly later than the client's receipt time.
