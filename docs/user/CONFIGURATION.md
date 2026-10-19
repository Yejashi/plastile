# Configuring Plastile

**Configuration is data.** Every value is validated and compiled into an immutable snapshot before it is activated. An invalid configuration is rejected as a whole: the previous one stays active, and each problem is logged with its exact path (for example `rules[2].actions.colour: unknown key`). Matchers are compiled once at activation, so nothing is parsed or compiled while you open windows or press shortcuts. Plastile does not execute user JavaScript.

**Where it lives.** Everything is in `~/.config/kwinrc` under `[Script-plastile]`, written by the settings dialog or by hand ([INSTALL](INSTALL.md#4-settings-dialog)).

**Not configuration: saved layout preferences.** Layouts, ratios and float positions you change with commands are state, kept in `~/.local/state/plastile/` by the separate persistence helper ([saved preferences](README.md#saved-layout-preferences), [installing the helper](INSTALL.md#persistence-helper)). Nothing in this file turns persistence on or off: with the helper installed it is used, without it preferences stay in memory. Configuration never depends on the helper.

**When changes take effect.** After *Plastile: Reload configuration*, which asks KWin to re-read `kwinrc`; after any other KWin reconfigure (`qdbus6 org.kde.KWin /KWin reconfigure`); or when the script is (re)enabled. The dialog's Apply alone does **not** reach the running script ([measured, see INSTALL](INSTALL.md#applying-settings-changes)). An activation re-evaluates only what changed: a settings change (gaps, ratios, layout, overrides) re-arranges only the screens and desktops whose resolved settings differ and re-classifies no window, except where `enabled` flipped; a rule change re-classifies every window and re-arranges only where a window joined or left the layout; a diagnostics-only change touches no window.

## Flat keys

These are the keys in `kwinrc` and the fields of the settings dialog. Defaults come from `src/core/defaults.ts` and from the schema in `package/contents/config/main.xml`; a unit test keeps the two in agreement.

- **Unknown keys** in `[Script-plastile]` are ignored **silently**. KWin lets a script read configuration keys only by name, so Plastile reads exactly the keys in this table and never sees a mistyped one (`gapinner=2` or `masterratio=0.6` do nothing, and nothing is logged). Compare key names with the table when a value seems to have no effect.
- **Empty values** mean "not set".
- **Numbers** must be plain decimal text (`8`, `0.55`; not `8px`).

| Key | Default | Accepted values | Meaning |
|---|---|---|---|
| `layout` | `master-stack` | `master-stack`, `bsp`, `monocle`, `floating`, `scrolling`, `zones` | Layout for every context, unless an override or a session command changes it. `scrolling` and `zones` are experimental and not offered by the settings dialog; set them in `kwinrc` or the JSON document ([scrolling](#scrolling-layout-settings-experimental), [zones](#zones-layout-settings-experimental)). |
| `gapInner` | `8` | integer 0–200 (px) | Gap between neighbouring tiles. |
| `gapOuter` | `8` | integer 0–200 (px) | Gap between tiles and the edge of the usable area, the same on all four sides. The JSON document can set each edge. |
| `singleWindowGaps` | `true` | `true`, `false` | Keeps the outer gap when a context has a single tiled window. `false` lets a lone window fill the area. |
| `masterRatio` | `0.55` | strictly between 0 and 1. The dialog offers 0.05–0.95, and the layout clamps to 0.05–0.95. | Width share of the master column in master/stack. A new value also applies to open contexts, except where you changed the ratio with *Grow*/*Shrink* or a resize. |
| `masterCount` | `1` | integer 0–8 | Windows in the master column. `0` stacks everything. A new value also applies to open contexts, except where you changed the count with a shortcut. |
| `masterInsert` | `after-focus` | `after-focus`, `end`, `master` | Where a new window enters the master/stack order. |
| `bspInsert` | `focused` | `focused`, `last` | Which tile a new window splits in BSP. |
| `bspAxis` | `alternate` | `alternate`, `longest`, `horizontal`, `vertical` | Split direction for new BSP splits. `horizontal` means side by side; `vertical` means stacked. |
| `ratioStep` | `0.05` | greater than 0, at most 0.5. The dialog offers 0.01–0.5. | Step for *Grow*/*Shrink*. This one key drives both master/stack and BSP; the JSON document can set them separately. |
| `maximizedOnOpen` | `tile` | `tile`, `keep` | A window the application or KWin opens maximized (an application that maps maximized, a KWin rule *Maximized: Apply initially*): `tile` un-maximizes it once, before it joins the layout, so it is placed once, as a tile; `keep` leaves it maximized. A maximize you make later (the maximize button, a double click on the title bar, a shortcut) is always kept, as is one the application makes again after Plastile un-maximized it: Plastile un-maximizes a window at most once, when it opens. Windows already open when Plastile starts, is re-enabled or resumes are left as they are, and so are full-screen windows, dialogs, floating windows and windows a KWin rule forces maximized. A change applies to windows opened after it. *Explain active window* says what happened (`onOpen`). The JSON document can set it per screen or desktop. |
| `diagnostics` | `warn` | `off`, `error`, `warn`, `info`, `debug` | Log level for `plastile` lines. `notice` lines (start, stop, a layout a command chose, pause and resume, saved layouts restored at load, explain) show at `warn`, `info` and `debug`; `error` shows errors only; `off` shows nothing and also disables the event trace ([TROUBLESHOOTING](TROUBLESHOOTING.md#reading-the-log)). |
| `osd` | `true` | `true`, `false` | Plasma's on-screen display (`org.kde.osdService` in plasmashell) when a command changes a layout ("Monocle layout — Desktop 2") or pauses or resumes tiling. Never for window events. Without plasmashell nothing is shown. After a failed request (plasmashell not started yet at login, or restarting) the messages of the next 30 s are dropped; the first command after that tries again. Nothing retries by itself. |
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
  "zoneLayouts": [ ],
  "diagnostics": { "level": "warn", "traceCapacity": 2048 }
}
```

| Field | Required | Meaning |
|---|---|---|
| `schemaVersion` | yes | Must be `1`. Any other value is rejected, including newer ones. |
| `defaults` | no | A settings patch applied on top of the flat keys, for every context. |
| `overrides` | no | Up to 64 per-context settings patches, selected by output, desktop or activity. |
| `rules` | no | Up to 256 window rules, selected by application id, resource name, title, window type, transience, output, desktop or activity. |
| `diagnostics` | no | `level` and `traceCapacity`, with the same values as the flat keys. The JSON wins when both are set. |
| `zoneLayouts` | no | Up to 16 zone layouts for the experimental zones layout ([below](#zones-layout-settings-experimental)). |

### Settings patch

A settings patch is used by `defaults` and by each override's `set`. Every field is optional, and an omitted field inherits from the level below. Objects merge field by field.

| Field | Values | Notes |
|---|---|---|
| `enabled` | boolean | `false` stops tiling in the matching contexts: windows there are treated as floating. |
| `layout` | `master-stack`, `bsp`, `monocle`, `floating`, `scrolling`, `zones` | `scrolling` and `zones` are experimental. |
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
| `scrolling.policy` | `lazy`, `centered` | Experimental scrolling layout ([below](#scrolling-layout-settings-experimental)). Default `lazy`. |
| `scrolling.defaultWidth` | greater than 0, at most 1 | Width of a new column as a fraction of the usable width. Default 0.5. |
| `scrolling.widthPresets` | 1–8 fractions, each greater than 0 and at most 1, strictly ascending | Widths *Scrolling: cycle column width* steps through. Default `[0.3333, 0.5, 0.6667, 1]` (exactly ⅓, ½, ⅔, 1). An override's list replaces the inherited one. |
| `zones.layout` | the id of a built-in or configured zone layout | Experimental zones layout ([below](#zones-layout-settings-experimental)): which zone layout a zones context uses. Default `halves`. |
| `overflow` | `float-new` | The only implemented policy. Other values are rejected. |
| `singleWindowGaps` | boolean | |
| `followOnSend` | boolean | Default `false`. When `true`, *Send window to next/previous desktop* also shows that desktop on the window's screen (only that screen when KWin's per-screen desktops are on) and activates the window. *Send window to next/previous output* needs no switch: KWin itself moves the window onto the destination screen's current desktop and keeps it active, so `true` only adds the activation. The value of the context the window is sent **from** decides. JSON only (no flat key). |
| `focusWrap` | boolean | Default `false`. When `true`, *Focus left/right/up/down* at the edge of the context continues from the opposite end of the same row or column on the same screen (right from the rightmost tile activates the leftmost tile it shares rows with). A tile with no row or column in common is never a wrap target, so a full-height master has nothing to wrap to upwards. Wrap never changes screen; *Focus next/previous output* does that. The value of the active window's context decides. JSON only. |
| `liveResize` | boolean | Default `false`: during a mouse resize of a tile, the neighbours stay put and follow once on release. When `true` (master/stack and BSP only), the neighbours follow the dragged edge while the mouse moves: at most one layout solve per update of the resized window (measured in nested KWin: 60 solves and 120 neighbour frame requests per second for two neighbours at 60 Hz), only neighbours whose frame changes are written, the resized window is never written, and the release commits the final ratio as before. A cancelled resize returns the neighbours to their slots. JSON only. |
| `maximizedOnOpen` | `tile`, `keep` | As the flat key. The value of the context the window opens in decides. |
| `multiContextWindows` | `"float"` only | As above: windows on several desktops or activities always float. |
| `animation` | `{ "enabled": false, "durationMs": 0 }` only | As above: no animation exists. |

### Scrolling layout settings (experimental)

The scrolling layout ([README](README.md#scrolling-experimental)) is off unless `layout` is `scrolling` in a context. It is experimental: covered by mock and nested-KWin tests only, with its physical-monitor checks still open. Its settings exist only in the JSON document:

```json
{
  "schemaVersion": 1,
  "overrides": [
    { "id": "scroll-on-desktop-2", "match": { "desktopName": "Desktop 2" },
      "set": { "layout": "scrolling", "scrolling": { "policy": "centered", "defaultWidth": 0.6667 } } }
  ]
}
```

- **`policy`:** `lazy` scrolls only as far as needed to show the focused column and never past the strip's first or last column. `centered` centres the focused column whenever it fits on the screen.
- **`defaultWidth`:** the width of each new column, as a fraction of the usable width (the screen's work area minus the outer gaps). Fractions that add up to 1 fill the width exactly, gaps included.
- **`widthPresets`:** the widths *Scrolling: cycle column width* steps through, narrowest first.
- *Grow* and *Shrink* change the focused column's width by `masterStack.ratioStep` (the flat `ratioStep`).

A configuration change that leaves a context's layout as scrolling keeps its columns. One that changes it to another layout, or disables tiling there, brings every off-screen window back first.

### Zones layout settings (experimental)

The zones layout ([README](README.md#zones-experimental)) is off unless `layout` is `zones` in a context. It is experimental: covered by mock and nested-KWin tests only, with its physical-monitor checks still open. Its settings exist only in the JSON document:

```json
{
  "schemaVersion": 1,
  "zoneLayouts": [
    { "id": "wide-centre", "zones": [
      { "x": 0, "y": 0, "width": 0.25, "height": 1 },
      { "x": 0.25, "y": 0, "width": 0.5, "height": 1 },
      { "x": 0.75, "y": 0, "width": 0.25, "height": 1 } ] }
  ],
  "defaults": { "zones": { "layout": "main-side" } },
  "overrides": [
    { "id": "zones-on-the-wide-screen", "match": { "outputName": "DP-1" },
      "set": { "layout": "zones", "zones": { "layout": "wide-centre" } } }
  ],
  "rules": [
    { "id": "terminal-right", "match": { "appId": "org.kde.konsole" }, "actions": { "zone": 3 } }
  ]
}
```

- **Built-in zone layouts:** `halves` (left, right), `thirds` (three columns), `grid-2x2` (top left, top right, bottom left, bottom right) and `main-side` (60 % left, 40 % right). Zones are numbered in list order.
- **`zoneLayouts`:** each entry has an `id` (1–64 characters, unique) and 1–32 `zones`. A zone is `x`, `y`, `width` and `height` as fractions of the usable area (the screen's work area minus the outer gaps): `x` and `y` from 0 to 1, `width` and `height` from 0.02 to 1, and `x + width` and `y + height` at most 1. Fractions are compared to six decimals, so `0.3333` + `0.6667` ends exactly at the edge. Zones may overlap. An entry with a built-in's id replaces that built-in; the others are added after the built-ins.
- **`zones.layout`:** which zone layout a zones context starts with. An unknown id is an error that names the known ones. *Zones: next zone layout* changes it for one context for the session.
- **Gaps:** zones use the same gaps as the other layouts: the outer gap at the area edges and exactly one inner gap where two zones meet. `singleWindowGaps: false` does not apply to zones.

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
  - **`activityId`:** the activity UUID, also when only one activity exists. Without the activity service (kactivitymanagerd not running), the context uses the literal value `default`; contexts move to the real activity when the service starts.
- **`set`** (required) is a settings patch. An empty `set` is a warning.

The **override engine** (matching, priority order, field merging) is unit-tested in Node. Settings from flat keys were measured live in nested KWin, and so was a `desktopName` override following a desktop rename (scenario `config-desktop-rename-Q02`). A per-output override has **not** been exercised end to end in nested KWin. Activity matchers are unit-tested only.

### Rules

A rule changes how a window is treated:

```json
{ "id": "float-calc", "priority": 0, "match": { "appId": "org.kde.kcalc" }, "actions": { "mode": "floating" } }
```

**`id` and `priority`** work as for overrides. Rules apply in ascending priority, then declaration order. A later rule's action wins per field, and every matching rule's id is recorded (`rules.ids` in the explanation, which also names the rule behind each action; `decision.ruleIds` when a rule decided the mode).

**`match`** (required; at least one field; all given fields must match):

- **`appId`:** a string matcher against KWin's `resourceClass`, falling back to the desktop file name when the class is empty. For Wayland clients the class is usually the `app_id`; for X11 clients it is the WM_CLASS class. Check the real value with *Explain active window*.
- **`resourceName`:** a string matcher against KWin's `resourceName`.
- **`title`:** a string matcher against the window caption. Plastile watches captions only while at least one rule uses `title`, including title rules activated later by a reconfigure (the current captions are read at that moment). With no title rules it never re-evaluates on caption changes. A caption change re-tests only the rules that use `title`; the other matchers' results for that window are reused.
- **`windowType`:** one value, or a list, from `normal`, `dialog`, `utility`, `toolbar`, `menu`, `splash`, `dock`, `desktop`, `notification`, `tooltip`, `popup`, `osd`, `applet-popup`, `dnd-icon`, `other`.
- **`transient`:** a boolean. `true` matches windows that have a parent window.
- **`outputName`, `desktopName`, `desktopId`, `activityId`:** string matchers against the window's context, with the same meaning as in [overrides](#overrides). `outputName` is the connector name, which is also the output's identity in this version. These fields match only a window that belongs to exactly one context; a window on all desktops, on several desktops or activities, or without an output is never matched by them. When the window moves to another desktop, output or activity, only these matchers are re-tested (once per context; the other matchers' results for that window are reused), and renaming a desktop re-tests `desktopName`.

**`actions`** (required; empty is a warning):

- **`mode`:** `tiled`, `floating` or `excluded`.
  - `tiled` opts a dialog, utility, transient or helper window into the layout. A fixed-size or non-resizable window still floats, with reason `fixed size (rule asked to tile)`, and so does a window on several desktops.
  - `excluded` removes the window from Plastile's attention entirely: it is never placed, and *Toggle floating* ignores it.
- **`border`:** `normal`, `none` or `keep` (the default).
  - `none` removes the decoration while the window is tiled, and restores it when the window leaves the layout or Plastile unloads. If you changed the border yourself in between, your change wins.
  - `normal` forces the decoration on while tiled.
  - Measured in nested KWin (scenario `classify-rule-border-Q10-T16`), including a user's own border change winning.
- **`insert`:** `after-focus`, `end` or `master`. It sets where this window enters the context's order, replacing `masterInsert` for that window. The order is what master/stack lays out and what monocle cycles through; in BSP the new window splits the tile chosen by `bsp.insert`. This action is **untested** beyond validation.
- **`zone`:** an integer 1–32 (experimental zones layout). When the window joins a context whose layout is `zones`, it is placed in that zone of the context's zone layout. If that zone layout has fewer zones, the window stays an ordinary floating window and its explanation says why. A window already in the context is not moved by a rule change. Unit-tested with the mock compositor only.
- **`minSize`:** `{ "width": W, "height": H }` in logical pixels (each 1–8192; either may be omitted). The smallest tile this window is useful in. Layouts treat it as the window's minimum size, so a tile is never made smaller; when the layout cannot give it that much room, the window floats as an overflow (`exception: overflow: ...`) and gets a new attempt when room may have appeared (another window closes, the work area or the configuration changes). It never exceeds the application's own maximum size. Measured in nested KWin 6.7.5 and 6.8.0 (scenario `rules-context-T25`) and unit-tested with the mock compositor.

Actions that are **not supported** in this version are rejected with a message that names the alternative:

| Action | Why not, and what to use instead |
|---|---|
| `layout` | A layout belongs to an output or desktop, not a window. Use an override: `overrides[].set.layout` with a `match`. |
| `output`, `outputName`, `screen`, `desktop`, `desktopName`, `desktopId`, `activity`, `activityId` | Plastile does not move windows between outputs, desktops or activities on its own. Use a KWin window rule (System Settings, *Window Rules*: *Screen*, *Virtual Desktop*, *Activities*); KWin applies it before Plastile classifies the window, and a Plastile rule can then match that place with `outputName`, `desktopName` or `activityId`. |
| `overflow` | `float-new` is the only overflow policy, so there is nothing to override per window. Use `minSize` to make a window float instead of taking a tile smaller than it can use. |

Overrides cannot change rules.

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
5. Session commands: a layout chosen with the layout shortcuts, and structure changed by grow/shrink, master count, rotate, mirror or equalize in that context. The layout choice, master ratio and master count are saved and restored at the next load ([saved layout preferences](README.md#saved-layout-preferences)); the rest lasts until *Reset this layout*, a script reload or the end of the KWin session.

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

**When.** The decision is made when a window appears. It is made again when the window's application id or resource name, transience or modality, or its desktop or output membership change, when a configuration with changed rules is activated (or one that enables or disables tiling where the window is), and when a desktop is renamed while some override or rule uses `desktopName`. A title change re-evaluates only if some rule uses `title`. The window type is read with the other metadata at those moments; KWin does not report a later type change.

**Size constraints** (minimum and maximum size, fixed size) have no change notification in KWin 6.7.5. Plastile re-reads them, and re-classifies if they changed, at these points only:

- when KWin emits its *maximizable* change signal: for Wayland clients on every minimum or maximum size change (observed source and measured, e.g. Kate sets its minimum twice right after mapping); for X11 clients only when the window becomes or stops being fixed-size;
- after a decoration change (the title bar height is part of the frame minimum), once the client's geometry has followed;
- when a client answers a resize request with a size other than the requested one (once per request).

An X11 client that raises its minimum to a size its current tile already satisfies is therefore not noticed until one of these happens; that is harmless for the layout.

**Sources.** The decision records a **source**:

- `builtin`: shell surfaces, helper apps and tiny surfaces (2 px or less in either dimension; such a surface is classified once more when its client gives it a real size)
- `type`: window type, special or unmanaged windows
- `constraint`: fixed size
- `membership`: several desktops or activities, or no output
- `rule`
- `default`

It also records the reason text and, when a rule decided the mode, the ids of the matching rules. Every matched rule, including rules that only set a border or an insertion preference, is listed separately in the explanation's `rules` field together with the rule behind each final action. Native tiles and your *Toggle floating* choices show in `mode`, `userMode`, `nativeTile` and `nativeYield` rather than in the source.

### Seeing why a window was classified

**Plastile: Explain active window (log)** (unbound; [bind it](SHORTCUTS.md#rebinding) or invoke it from a terminal) does two things with the window focused:

- **It opens the inspector,** a small window in the middle of the screen that states in plain words how Plastile treats the window and why: tiled, floating or not managed; what decided it (window type, a built-in exception, your rule, its size limits, being on several desktops); which rules matched and what they changed; where it is; whether KWin owns it right now (minimized, full screen, maximized, being dragged); its size limits, including sizes learned from the application; whether it reached its tile; and why Plastile gave up on it, if it did. Shortcut conflicts found at startup are listed too. *Show details* adds the internal values (window id, desktop and activity ids, planned and requested rectangles).
  - Escape, a click anywhere else, activating another window, or running the command again closes it. While it is open it takes the keyboard, like a menu; global shortcuts still work (measured with a Plastile focus key, which also closed it by activating another window).
  - It exists only between the command and its closing, and is removed when Plastile unloads. It is Plastile's own window, so it is never tiled, and opening it moves no window (measured in nested KWin 6.7.5 with QPainter rendering and 6.8.0 with OpenGL, scenario `inspector-T28`).
- **It logs the explanation** as one `notice` line, with the fields below. The default log level shows it; only `error` and `off` hide it.

To read the log line:

```sh
journalctl --user -f | grep plastile
# in another terminal, with the window focused:
qdbus6 org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component.invokeShortcut plastile.inspect.explain-window
```

The line is `plastile notice explain {...}` with these fields:

| Field | Content |
|---|---|
| `id`, `appId`, `kind` | Window identity and type. |
| `mode` | `tiled`, `floating`, `excluded`, `native` or `pending`. |
| `userMode` | Your *Toggle floating* choice, if any. |
| `decision` | `mode`, `source`, `reason` and `ruleIds` (the rules that decided the mode). |
| `rules` | `null` when no rule matches; otherwise `ids` (every matched rule, in evaluation order), the final `actions` (`mode`, `border`, `insert`, `minSize` as `WxH`) and `reasons` (which rule set each action). |
| `context` | Output name, desktop id and activity. |
| `layout` | The context's current layout. |
| `suspensions` | Any of `minimized`, `fullscreen`, `maximized`, `interactive`, `hidden`. |
| `suspended` | For a tiled window that KWin owns for the moment (maximized, full screen, minimized or hidden), a plain statement such as `tiling of this window is suspended while it is maximized; it resumes, in the same place, when the window is restored`; otherwise `null`. The policy itself does not change: the window stays a member of its context. |
| `onOpen` | Present only when the window arrived maximized ([`maximizedOnOpen`](#flat-keys)): `unmaximized on open: ...`, `it opened maximized and stays maximized (maximizedOnOpen: keep)`, `... KWin does not allow un-maximizing it ...` (fixed size, or a KWin rule forcing maximize), or, after a later maximize, `maximized again after Plastile un-maximized it when it opened; honoured ...`. |
| `paused` | `true` while *Suspend/resume tiling* has suspended all tiling. |
| `constraints` | Frame minimum and maximum, and whether the window is fixed-size. |
| `learnedMin`, `learnedMax` | Sizes the client actually accepted. |
| `ledger` | Status, outstanding request, desired rectangle and corrections used. |
| `slot` | The planned rectangle. |
| `exception` | Why Plastile gave up on the window, for example `did not reach its target after bounded corrections` or `overflow: ...`. |
| `nativeTile` | Whether KWin's native tile holds the window. |
| `nativeYield` | Whether a native tile action made Plastile yield the window. It stays yielded after KWin releases the tile, until *Adopt natively tiled window* or *Toggle floating*. |
| `shortcutConflicts` | Present only when the startup shortcut check found conflicts: each `key`, the Plastile `command` and the `others` holding that key ([SHORTCUTS](SHORTCUTS.md#conflict-report)). |

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
- `multiContextWindows` or `animation` at any non-inert value
- a rule action this version does not support (`layout`, placement on an output, desktop or activity, `overflow`), each with the alternative in the message
- a `minSize` with neither `width` nor `height`, or a value outside 1–8192
- a scrolling `policy` other than `lazy` or `centered`, a width outside (0, 1], or `widthPresets` that is empty, longer than 8 or not strictly ascending
- more than 16 `zoneLayouts`, a zone layout with no zones or more than 32, a duplicate or empty zone layout id, a zone coordinate that is not a finite number in its range, a zone narrower or shorter than 0.02, or one that extends past the right or bottom edge; a `zones.layout` naming no known zone layout; a rule `zone` outside 1–32

**Warnings** (the configuration still activates): an empty `set`, empty `actions`. (Unknown flat keys would be a warning too, but in KWin they never reach the validator; see [Flat keys](#flat-keys).)

**Error limits.** At most 100 errors are collected per attempt, and the first 20 are logged.
