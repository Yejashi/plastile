# Configuring Plastile

**Configuration is data.** Every value is validated and compiled into an immutable snapshot before it is activated. An invalid configuration is rejected as a whole: the previous one stays active, and each problem is logged with its exact path (for example `rules[2].actions.colour: unknown key`). Matchers are compiled once at activation, so nothing is parsed or compiled while you open windows or press shortcuts. Plastile does not execute user JavaScript.

**Where it lives.** Everything is in `~/.config/kwinrc` under `[Script-plastile]`, written by the settings dialog or by hand ([INSTALL](INSTALL.md#4-settings-dialog)).

**When changes take effect.** After a KWin reconfigure (`qdbus6 org.kde.KWin /KWin reconfigure`) or when the script is (re)enabled. The dialog's Apply alone does **not** reach the running script, and neither does the *Reload configuration* shortcut on its own ([measured, see INSTALL](INSTALL.md#applying-settings-changes)).

## Flat keys

These are the keys in `kwinrc` and the fields of the settings dialog. Defaults come from `src/core/defaults.ts` and from the schema in `package/contents/config/main.xml`; a unit test keeps the two in agreement.

- **Unknown keys** in `[Script-plastile]` are ignored **silently**. KWin lets a script read configuration keys only by name, so Plastile reads exactly the keys in this table and never sees a mistyped one (`gapinner=2` or `masterratio=0.6` do nothing, and nothing is logged). Compare key names with the table when a value seems to have no effect.
- **Empty values** mean "not set".
- **Numbers** must be plain decimal text (`8`, `0.55`; not `8px`).

| Key | Default | Accepted values | Meaning |
|---|---|---|---|
| `layout` | `master-stack` | `master-stack`, `bsp`, `monocle`, `floating` | Layout for every context, unless an override or a session command changes it. |
| `gapInner` | `8` | integer 0–200 (px) | Gap between neighbouring tiles. |
| `gapOuter` | `8` | integer 0–200 (px) | Gap between tiles and the edge of the usable area, the same on all four sides. The JSON document can set each edge. |
| `singleWindowGaps` | `true` | `true`, `false` | Keeps the outer gap when a context has a single tiled window. `false` lets a lone window fill the area. |
| `masterRatio` | `0.55` | strictly between 0 and 1. The dialog offers 0.05–0.95, and the layout clamps to 0.05–0.95. | Width share of the master column in master/stack. |
| `masterCount` | `1` | integer 0–8 | Windows in the master column. `0` stacks everything. |
| `masterInsert` | `after-focus` | `after-focus`, `end`, `master` | Where a new window enters the master/stack order. |
| `bspInsert` | `focused` | `focused`, `last` | Which tile a new window splits in BSP. |
| `bspAxis` | `alternate` | `alternate`, `longest`, `horizontal`, `vertical` | Split direction for new BSP splits. `horizontal` means side by side; `vertical` means stacked. |
| `ratioStep` | `0.05` | greater than 0, at most 0.5. The dialog offers 0.01–0.5. | Step for *Grow*/*Shrink*. This one key drives both master/stack and BSP; the JSON document can set them separately. |
| `diagnostics` | `warn` | `off`, `warn`, `info`, `debug` | Log level for `plastile` lines. `off` also disables the event trace. |
| `traceCapacity` | `2048` | integer 64–65536 | Number of events kept for *Log trace*. |
| `configJson` | empty | a JSON string of at most 524,288 characters | The JSON document described below. |

## The JSON document

`configJson` holds one JSON object. Only the fields listed here are implemented. **Unknown keys at any level are errors, not warnings**, so a typo cannot silently do nothing.

```json
{
  "schemaVersion": 1,
  "defaults": { },
  "overrides": [ ],
  "rules": [ ],
  "diagnostics": { "level": "warn", "traceCapacity": 2048 }
}
```

| Field | Required | Meaning |
|---|---|---|
| `schemaVersion` | yes | Must be `1`. Any other value is rejected, including newer ones. |
| `defaults` | no | A settings patch applied on top of the flat keys, for every context. |
| `overrides` | no | Up to 64 per-context settings patches, selected by output, desktop or activity. |
| `rules` | no | Up to 256 window rules, selected by application id, resource name, title, window type or transience. |
| `diagnostics` | no | `level` and `traceCapacity`, with the same values as the flat keys. The JSON wins when both are set. |

### Settings patch

A settings patch is used by `defaults` and by each override's `set`. Every field is optional, and an omitted field inherits from the level below. Objects merge field by field.

| Field | Values | Notes |
|---|---|---|
| `enabled` | boolean | `false` stops tiling in the matching contexts: windows there are treated as floating. |
| `layout` | `master-stack`, `bsp`, `monocle`, `floating` | |
| `gaps.inner` | integer 0–200 | |
| `gaps.outer` | integer 0–200, or `{ "top", "right", "bottom", "left" }` (each 0–200, any subset) | A number sets all four edges. |
| `masterStack.ratio` | strictly between 0 and 1 (clamped to 0.05–0.95 when solving) | |
| `masterStack.masterCount` | integer 0–8 | |
| `masterStack.insert` | `after-focus`, `end`, `master` | |
| `masterStack.ratioStep` | greater than 0, at most 0.5 | |
| `bsp.insert` | `focused`, `last` | |
| `bsp.axis` | `alternate`, `longest`, `horizontal`, `vertical` | |
| `bsp.initialRatio` | strictly between 0 and 1 (clamped to 0.05–0.95) | Ratio given to a new split. There is no flat key for it. Default 0.5. |
| `bsp.ratioStep` | greater than 0, at most 0.5 | |
| `overflow` | `float-new` | The only implemented policy. Other values are rejected. |
| `singleWindowGaps` | boolean | |
| `followOnSend` | `false` only | Accepted at its inert value for compatibility with the design document's example; `true` is rejected as not supported. |
| `multiContextWindows` | `"float"` only | As above: windows on several desktops or activities always float. |
| `animation` | `{ "enabled": false, "durationMs": 0 }` only | As above: no animation exists. |

### Overrides

An override changes settings for the contexts it matches:

```json
{ "id": "wide", "priority": 0, "match": { "outputName": "DP-1" }, "set": { "masterStack": { "ratio": 0.6 } } }
```

- **`id`** (required, unique, non-empty) names the override.
- **`priority`** (number, default 0). Overrides apply in ascending priority, then in declaration order; a later patch wins per field.
- **`match`** (required, at least one field). The fields are `outputName`, `desktopName`, `desktopId` and `activityId`, each a [string matcher](#string-matchers), and all given fields must match. An empty `match` is an error; use `defaults` for that. What each field matches:
  - **`outputName`:** the connector name as KWin reports it (`DP-1`, `HDMI-A-1`). The nested test outputs are called `Virtual-0`, `Virtual-1`.
  - **`desktopName`:** the name shown in the pager. Renaming a desktop re-resolves the overrides and the classification of its windows, as an activation does.
  - **`desktopId`:** KWin's desktop UUID.
  - **`activityId`:** the activity UUID. With only one activity, the context uses the literal value `default`.
- **`set`** (required) is a settings patch. An empty `set` is a warning.

The **override engine** (matching, priority order, field merging) is unit-tested in Node. Settings from flat keys were measured live in nested KWin. A per-desktop or per-output override has **not** been exercised end to end in nested KWin. Activities are **untested**.

### Rules

A rule changes how a window is treated:

```json
{ "id": "float-calc", "priority": 0, "match": { "appId": "org.kde.kcalc" }, "actions": { "mode": "floating" } }
```

**`id` and `priority`** work as for overrides. Rules apply in ascending priority, then declaration order. A later rule's action wins per field, and every matching rule's id is recorded (`decision.ruleIds` in the explanation).

**`match`** (required; at least one field; all given fields must match):

- **`appId`:** a string matcher against KWin's `resourceClass`, falling back to the desktop file name when the class is empty. For Wayland clients the class is usually the `app_id`; for X11 clients it is the WM_CLASS class. Check the real value with *Explain active window*.
- **`resourceName`:** a string matcher against KWin's `resourceName`.
- **`title`:** a string matcher against the window caption. Plastile watches captions only while at least one rule uses `title`, including title rules activated later by a reconfigure (the current captions are read at that moment). With no title rules it never re-evaluates on caption changes. A caption change re-tests only the rules that use `title`; the other matchers' results for that window are reused.
- **`windowType`:** one value, or a list, from `normal`, `dialog`, `utility`, `toolbar`, `menu`, `splash`, `dock`, `desktop`, `notification`, `tooltip`, `popup`, `osd`, `applet-popup`, `dnd-icon`, `other`.
- **`transient`:** a boolean. `true` matches windows that have a parent window.

**`actions`** (required; empty is a warning):

- **`mode`:** `tiled`, `floating` or `excluded`.
  - `tiled` opts a dialog, utility, transient or helper window into the layout. A fixed-size or non-resizable window still floats, with reason `fixed size (rule asked to tile)`, and so does a window on several desktops.
  - `excluded` removes the window from Plastile's attention entirely: it is never placed, and *Toggle floating* ignores it.
- **`border`:** `normal`, `none` or `keep` (the default).
  - `none` removes the decoration while the window is tiled, and restores it when the window leaves the layout or Plastile unloads. If you changed the border yourself in between, your change wins.
  - `normal` forces the decoration on while tiled.
  - This action is covered by a unit test only, not by a nested KWin scenario.
- **`insert`:** `after-focus`, `end` or `master`. It sets where this window enters a master/stack order, replacing `masterInsert` for that window. This action is **untested** beyond validation.

Rules cannot yet depend on the screen or desktop a window is on, and overrides cannot change rules.

### String matchers

Wherever a string matcher is accepted:

| Form | Example | Semantics |
|---|---|---|
| plain string | `"org.kde.konsole"` | Exact, case-sensitive. |
| `{ "exact": "..." }` | `{ "exact": "firefox" }` | The same. |
| `{ "glob": "..." }` | `{ "glob": "org.kde.*" }` | Anchored (must match the whole value) and case-sensitive. `*` matches any run of characters (including none) and `?` matches one character; there are no escapes. A glob without wildcards is an exact match. |
| `{ "regex": "...", "flags": "i" }` | `{ "regex": "^(firefox\|chromium)$", "flags": "i" }` | A JavaScript `RegExp`, anchored only if you anchor it. `flags` may be omitted, `""` or `"i"`. |

Limits, enforced at activation:

- **String length:** strings and globs up to 512 characters; regex patterns up to 256 characters.
- **Flags:** only the `i` flag is allowed.
- **Regex validity:** a regex that does not compile is an error.
- **Subject length:** values longer than 1024 characters (long titles, for example) are matched by their first 1024 characters.

Prefer exact or glob matchers. A regex match runs synchronously inside KWin and cannot be interrupted; the limits above bound pathological patterns but do not eliminate them.

## Precedence

### Settings for a context

Later levels win per field:

1. Built-in defaults (`src/core/defaults.ts`).
2. Flat keys from `kwinrc`.
3. `defaults` in the JSON document.
4. Matching `overrides`, in ascending priority, then declaration order.
5. Session commands: a layout chosen with the layout shortcuts, and structure changed by grow/shrink, master count, rotate, mirror or equalize in that context. These last until *Reset this layout*, a script reload or the end of the KWin session.

### Window treatment

The first matching step decides (`src/core/classify.ts`):

1. **Built-in exclusions, which no rule can override:**
   - Plastile's own surfaces.
   - Window types `dock`, `desktop`, `notification`, `tooltip`, `popup`, `osd`, `applet-popup`, `dnd-icon`, `menu`, `splash` and `toolbar`.
   - KWin "special" windows, and windows KWin does not manage.
   - The application ids `org.kde.plasmashell`, `plasmashell`, `org.kde.krunner`, `krunner`, `ksmserver-logout-greeter`, `org.kde.ksmserver-logout-greeter`, `kwin`, `org.kde.kwin`, `kwin_wayland`, `org.kde.kscreenlocker_greet`, `kscreenlocker_greet`, `xwaylandvideobridge` and `org.kde.xwaylandvideobridge`.
   - Surfaces of 2 px or less in either dimension.

   A rule matching such a window has no effect.
2. **A rule with `mode: excluded`.**
3. **Membership.** A window on all desktops, on several desktops, on several activities, or with no output floats regardless of rules, because one frame cannot satisfy two layouts.
4. **A rule with `mode: tiled`** (the window still floats if it is fixed-size or not resizable), or a rule with `mode: floating`.
5. **Built-in floating helpers:** `org.freedesktop.impl.portal.desktop.kde`, `xdg-desktop-portal-kde`, `org.kde.polkit-kde-authentication-agent-1`, `polkit-kde-authentication-agent-1`, `org.kde.kdeconnect.daemon` and `org.kde.plasma.emojier`.
6. **Type defaults:** `dialog`, `utility`, transient or modal windows, and any type other than `normal`, float.
7. **Constraints:** fixed-size or non-resizable windows float.
8. **Everything else** (a normal, resizable window on one desktop) is tiled.

After that decision, these adjustments apply in order:

1. **Native quick tile.** A native quick tile puts the window in `native` mode until it is adopted.
2. **Toggle floating.** *Toggle floating* (and *Adopt natively tiled window*) set a per-window user mode, which lasts until the window closes or Plastile unloads. A user choice to tile works only for windows on one desktop that are resizable and not fixed-size. Built-in and rule exclusions always stay excluded.
3. **`enabled: false`.** An `enabled: false` setting for the window's context makes it floating.
4. **Overflow.** A window that overflowed the layout floats, with its reason recorded.

## Examples

### 1. Small gaps and BSP everywhere; one wide screen uses master/stack

```json
{
  "schemaVersion": 1,
  "defaults": {
    "layout": "bsp",
    "gaps": { "inner": 4, "outer": { "top": 4, "right": 4, "bottom": 4, "left": 4 } },
    "bsp": { "axis": "longest", "initialRatio": 0.5 }
  },
  "overrides": [
    {
      "id": "ultrawide",
      "match": { "outputName": "DP-1" },
      "set": { "layout": "master-stack", "masterStack": { "ratio": 0.5, "masterCount": 1 } }
    }
  ]
}
```

### 2. A writing desktop in monocle; no tiling on a chat desktop

```json
{
  "schemaVersion": 1,
  "overrides": [
    { "id": "writing", "match": { "desktopName": "Writing" }, "set": { "layout": "monocle" } },
    { "id": "chat", "priority": 10, "match": { "desktopName": { "glob": "Chat*" } }, "set": { "enabled": false } }
  ],
  "diagnostics": { "level": "info" }
}
```

### 3. Window rules: float some applications, tile a utility window, borderless terminals

```json
{
  "schemaVersion": 1,
  "rules": [
    { "id": "float-calc", "match": { "appId": "org.kde.kcalc" }, "actions": { "mode": "floating" } },
    { "id": "float-pip", "match": { "title": { "glob": "Picture-in-Picture*" } }, "actions": { "mode": "floating" } },
    { "id": "tile-kde-dialogs", "priority": 5, "match": { "appId": { "glob": "org.kde.*" }, "windowType": "dialog" }, "actions": { "mode": "tiled" } },
    { "id": "tile-palette", "match": { "appId": "org.kde.krita", "windowType": "utility" }, "actions": { "mode": "tiled" } },
    { "id": "ignore-steam-popups", "match": { "appId": { "regex": "^steam", "flags": "i" }, "transient": true }, "actions": { "mode": "excluded" } },
    { "id": "terminal-borders", "match": { "appId": { "glob": "org.kde.konsole*" } }, "actions": { "border": "none" } }
  ]
}
```

In example 3, a Krita utility window matches `tile-palette`. If it is fixed-size, it still floats, and its explanation says `fixed size (rule asked to tile)` with the rule id attached. The `title` rule makes Plastile watch captions for all windows. The application ids are illustrative; check the real ones with *Explain active window*.

All three examples were compiled with the runtime's own `compileConfig` in Node, with no errors and no warnings (measured). Example 1 resolves `DP-1` to master/stack with ratio 0.5. Example 2 resolves a desktop named `Chat 2` through `override chat`. Example 3 resolves a Krita utility window to `mode: tiled` via `tile-palette`. They have not been run as-is in nested KWin.

## How windows are classified

**When.** The decision is made when a window appears. It is made again when the window's application id or resource name, transience or modality, or its desktop or output membership change, when a new configuration is activated, and when a desktop is renamed. A title change re-evaluates only if some rule uses `title`. The window type is read with the other metadata at those moments; KWin does not report a later type change.

**Size constraints** (minimum and maximum size, fixed size) have no change notification in KWin 6.7.5. Plastile re-reads them, and re-classifies if they changed, at these points only:

- when KWin emits its *maximizable* change signal: for Wayland clients on every minimum or maximum size change (observed source and measured, e.g. Kate sets its minimum twice right after mapping); for X11 clients only when the window becomes or stops being fixed-size;
- after a decoration change (the title bar height is part of the frame minimum), once the client's geometry has followed;
- when a client answers a resize request with a size other than the requested one (once per request).

An X11 client that raises its minimum to a size its current tile already satisfies is therefore not noticed until one of these happens; that is harmless for the layout.

**Sources.** The decision records a **source**:

- `builtin`: shell surfaces, helper apps and tiny surfaces
- `type`: window type, special or unmanaged windows
- `constraint`: fixed size
- `membership`: several desktops or activities, or no output
- `rule`
- `default`

It also records the reason text and the ids of matching rules. Native tiles and your *Toggle floating* choices show in `mode`, `userMode` and `nativeTile` rather than in the source.

### Seeing why a window was classified

1. Set `diagnostics` to `info` or `debug`; the explanation is logged at `info` level.
2. Bind **Plastile: Explain active window (log)** to a key ([SHORTCUTS](SHORTCUTS.md#rebinding)), or invoke it from a terminal.
3. Watch the log and trigger the command with the window focused:

```sh
journalctl --user -f | grep plastile
# in another terminal, with the window focused:
qdbus6 org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component.invokeShortcut plastile.inspect.explain-window
```

The line is `plastile info explain {...}` with these fields:

| Field | Content |
|---|---|
| `id`, `appId`, `kind` | Window identity and type. |
| `mode` | `tiled`, `floating`, `excluded`, `native` or `pending`. |
| `userMode` | Your *Toggle floating* choice, if any. |
| `decision` | `mode`, `source`, `reason` and `ruleIds`. |
| `context` | Output name, desktop id and activity. |
| `layout` | The context's current layout. |
| `suspensions` | Any of `minimized`, `fullscreen`, `maximized`, `interactive`, `hidden`. |
| `constraints` | Frame minimum and maximum, and whether the window is fixed-size. |
| `learnedMin`, `learnedMax` | Sizes the client actually accepted. |
| `ledger` | Status, outstanding request, desired rectangle and corrections used. |
| `slot` | The planned rectangle. |
| `exception` | Why Plastile gave up on the window, for example `did not reach its target after bounded corrections` or `overflow: ...`. |
| `nativeTile` | Whether KWin's native tile holds the window. |

**Where the log goes.** In the nested tests, the line was read from the compositor's captured stderr. Without `QT_FORCE_STDERR_LOGGING`, Qt sends script log output to the user journal (observed during environment discovery, [ENVIRONMENT](../status/ENVIRONMENT.md)). Reading it with `journalctl` in a physical Plasma session is untested ([TROUBLESHOOTING](TROUBLESHOOTING.md#reading-the-log)).

## Validation reference

**Rejected at activation** (the whole revision is dropped):

- wrong types, numbers out of range, and non-integers where an integer is required
- unknown keys inside the JSON document
- invalid JSON
- a missing or unsupported `schemaVersion`
- a duplicate or empty `id`
- an empty `match`, or a missing `match`, `set` or `actions`
- more than 64 overrides or 256 rules
- `configJson` longer than 524,288 characters
- matchers with none or several of `exact`, `glob` and `regex`
- unsupported regex flags, or patterns that do not compile
- `followOnSend`, `multiContextWindows` or `animation` at any non-inert value

**Warnings** (the configuration still activates): an empty `set`, empty `actions`. (Unknown flat keys would be a warning too, but in KWin they never reach the validator; see [Flat keys](#flat-keys).)

**Error limits.** At most 100 errors are collected per attempt, and the first 20 are logged.
