# Proposed configuration and commands

## 1. Goals and storage boundary

Configuration must be expressive, inspectable, and cheap to use. The runtime consumes an immutable validated snapshot with a revision. File reading, JSON parsing, regex compilation, and layout construction occur before activation, never for every geometry event or keypress.

The initial KWin package can expose standard settings backed by KConfig/KWin's supported read path. Rich nested configuration may be represented as a schema-validated JSON document loaded by a small settings/helper path. The script must not pretend it has arbitrary filesystem APIs. M0/M5 selects the exact bridge supported on the target runtime. The helper, if required, remains outside the command-response critical path and failure leaves the last valid snapshot working.

All names below are proposed Plastile schema fields, not existing KWin configuration keys.

## 2. Example intended configuration

```json
{
  "schemaVersion": 1,
  "defaults": {
    "enabled": true,
    "layout": "master-stack",
    "gaps": { "inner": 8, "outer": { "top": 8, "right": 8, "bottom": 8, "left": 8 } },
    "masterStack": { "ratio": 0.55, "masterCount": 1, "insert": "after-focus" },
    "bsp": { "insert": "focused", "axis": "alternate", "initialRatio": 0.5 },
    "overflow": "float-new",
    "followOnSend": false,
    "multiContextWindows": "float",
    "animation": { "enabled": false, "durationMs": 0 }
  },
  "overrides": [
    {
      "id": "wide-display",
      "match": { "outputName": "DP-1" },
      "set": { "masterStack": { "ratio": 0.6 } }
    },
    {
      "id": "writing-desktop",
      "match": { "desktopName": "Writing" },
      "set": { "layout": "monocle" }
    }
  ],
  "rules": [
    {
      "id": "float-dialogs",
      "priority": 100,
      "match": { "windowType": "dialog" },
      "actions": { "mode": "floating" }
    },
    {
      "id": "terminal-borders",
      "priority": 20,
      "match": { "appId": "org.kde.konsole" },
      "actions": { "border": "normal" }
    }
  ],
  "diagnostics": { "level": "warn", "traceCapacity": 2048 }
}
```

`appId` is a normalized metadata field filled by the adapter; it may derive from different properties for Wayland and XWayland. Do not assume that every `resourceClass` equals an application desktop-file ID. `outputName` and `desktopName` matching are user conveniences; persisted context identity uses stable IDs. The example's output name is illustrative, not the user's hardware.

## 3. Resolution and precedence

Resolve in this order:

1. Built-in safe defaults.
2. User global defaults.
3. Matching context overrides, sorted by explicit `priority` (default zero), then declaration order; later matching patches win per field.
4. Matching window rules, sorted by explicit priority ascending then declaration order; later actions win per property.
5. Explicit session user commands, for properties that commands own, until the next explicit reset or relevant rule activation.

Do not combine an implicit specificity rule with this ordering. If a user wants an output+desktop override to win, they give it a later position or higher priority. Explain the full resolution chain. Implement deep merge only for recognized schema objects; arrays replace rather than concatenate, and unknown keys are errors. Omitted means inherit; explicit null is allowed only for fields whose schema defines a clear removal meaning.

Built-in exclusions for shell/lock/compositor surfaces take precedence over ordinary user tiling rules. A separate developer/test override can exist only in disposable tests; it must not be a casual GUI switch that tiles a lock screen.

## 4. Rule model

Supported initial match fields:

| Field | Comparison | Cache invalidation |
|---|---|---|
| Normalized app ID/class/name | Exact by default; explicit glob or regex matcher type | Class/name change or config revision |
| Window type | Enum/set | Classification snapshot change |
| Transient/dialog relationship | Boolean/parent app matcher | Parent/type change |
| Title | Exact/glob/explicit regex | Title change; evaluate only rules that use title |
| Output | Stable ID or explicit name matcher | Output membership/topology change |
| Desktop/activity | ID or name matcher | Membership/name/config change |

Actions initially cover mode, preferred layout/context placement where supported, minimum usable slot preference, border policy, insertion preference, and overflow override. Do not make every KWin property a generic rule action.

*Implementation note (T25).* Implemented: `mode`, `border`, `insert`, and `minSize` (the minimum usable slot: an extra layout minimum, clamped to the client's maximum, whose infeasibility goes through the overflow policy). Context matchers (`outputName`, `desktopName`, `desktopId`, `activityId`) are memoized per context, separately from the metadata matchers, so a membership change re-runs only them. Not implemented, and rejected with an error naming the alternative: a per-window `layout` (layouts belong to contexts; use an override), context placement (`output`/`desktop`/`activity`: a script-side send at adoption would race the client's own placement and re-enter the engine from KWin's synchronous membership signals; KWin's own window rules already place windows before Plastile classifies them), and `overflow` (only `float-new` exists, so an override has nothing to select). Geometry, maximize/fullscreen, stacking, focus, and native window rules can conflict; each supported action needs a precedence and yield policy.

A rule result includes its rule IDs and field-level reasons. `explain-window` returns the normalized metadata, context, matched rules, final actions, constraint exceptions, and ownership state. Titles are redacted from exported diagnostics by default.

Regex safety matters because matching can occur inside KWin. Bound input lengths and pattern sizes, reject invalid patterns, avoid repeating matches on unchanged metadata, and document the trust/performance limits of unrestricted regex engines. Initial safe presets should use exact/glob matching. A runtime watchdog cannot interrupt an arbitrary synchronous regex match in ordinary JavaScript; do not claim otherwise.

## 5. Validation and activation

Validation checks:

- Supported schema version; unknown fields; type/range; finite geometry and ratios.
- Nonnegative gaps, bounded master count, ratio in `(0,1)`, sensible trace capacity.
- Unique rule/override/layout IDs and valid command/layout references.
- Explicit matcher type and successfully compiled patterns.
- Declarative tree depth/node count and zone count bounds.
- No impossible static normalized rectangles, NaNs, or out-of-range zones.
- Unsupported capability requests return actionable errors or explicit disabled options.

Activation is a transaction: parse → validate → normalize → compile matchers → construct immutable snapshot → publish revision → invalidate affected model state. On failure, retain the old revision. Keep recent validation errors and expose them in settings/diagnostics without flooding logs.

A live settings preview must be reversible and generation-tagged. Cancel restores the previous config revision, then recomputes from current window state. It must not restore an obsolete list of window objects.

## 6. Command vocabulary

Use stable IDs and resolve targets once at dispatch:

| ID family | Initial commands | Semantics |
|---|---|---|
| `plastile.focus.*` | left/right/up/down, next/previous | Activate eligible target; no solve for ordinary layouts |
| `plastile.swap.*` | direction, master | Swap positions/leaf contents |
| `plastile.move.*` | reinsert direction, send output, send desktop | Structural/membership operation; follow is separate |
| `plastile.resize.*` | grow/shrink boundary, equalize | Feasible ratio/weight operation |
| `plastile.layout.*` | set, next, previous, rotate, mirror | Explicit layout/structural transformation |
| `plastile.window.*` | toggle-float, tile, float, adopt-native | Ownership/mode command |
| `plastile.runtime.*` | suspend, resume, reconcile, reload-config | Lifecycle command with scoped consequences |
| `plastile.context.*` | reset, set-layout | Target context, not every output |
| `plastile.inspect.*` | explain-window, counters, dump-trace | Read-only diagnostics |

Bindings belong to KDE's shortcut system; register one stable command ID per action. Defaults must be checked for existing Plasma conflicts. Do not repurpose Meta+T silently if it opens KDE's native tile editor. A configuration preset may deliberately adopt familiar bindings, but conflicts must be displayed and user overrides preserved.

Commands return a structured result: accepted/rejected/no-op, reason, resolved target IDs, model revision, and whether a placement request was issued. “Accepted” does not mean all clients committed or a frame was presented. An optional external API should expose that distinction.

## 7. UI strategy

M5 adds a small settings surface with global layout/gaps, context overrides, window exceptions, and rule explanations. Construct it lazily. Reuse schema metadata to avoid defaults and validation diverging between GUI and runtime. Avoid UI labels such as internal generation IDs unless in diagnostics; users need behavior choices, not implementation vocabulary.

A layout selector and drag preview send commands to the same dispatcher. They do not modify live KWin frames directly. Previewing a rule shows affected windows and reason changes before activation.

## 8. Persistence and compatibility

Persist configuration and layout preferences independently from live window pointers. Save floating geometry only when the user has actually used floating mode; tiled rectangles are not floating preferences. Save output association as a preference with fallback, not a mandatory inaccessible monitor.

Session restore maps applications conservatively using app identity and bounded hints. A title or class alone is not a unique durable window identity. Multiple instances must not receive another application's old slot merely because a matcher is broad. If matching is ambiguous, apply ordinary insertion.

Schema migrations are pure transforms with fixtures. Keep the previous valid file/snapshot until activation succeeds. An unknown future schema is rejected rather than silently downgraded. Public command and rule IDs remain stable across minor changes; deprecations need compatibility aliases and a removal plan.

**As implemented (T27, [ADR-013](DECISIONS.md#adr-013-persist-session-preferences-through-qtcore-settings)).** Configuration stays in `kwinrc` and is not part of the persisted state. The state file holds two things:

- **Context preferences:** an explicit layout, and a master ratio and count set by command or divider drag. They are keyed by the full context key (output identity key, desktop id, activity). A context whose output is absent keeps its entry until that output returns. There is no fallback to another output for context preferences: another output keeps its own.
- **Float rectangles:** the rectangle of a window the user floated, keyed by `appId`, `resourceName` and `role`, with the output identity key and that output's work area. The output association is a preference with fallback. On another output, or after the output is gone, the rectangle is placed proportionally inside the current output's work area and clamped (D6).

Matching is conservative: a saved float applies only when exactly one live window has that identity. Anything invalid rejects the whole snapshot. With two slots, the previous valid snapshot stays on disk while a new one is written. A newer schema on disk is left untouched, and nothing is saved that session.

## 9. Extension path

Initial custom layouts are declarative normalized zone lists or bounded split trees, validated before use. Arbitrary executable plugins are deferred. If later required, model the extension as `bounded input -> validated layout output`, with no live window handles, no arbitrary compositor mutations, resource limits, and a deterministic fallback. PlasmaZones' Luau separation is useful source material, but selecting a scripting language is not itself a complete isolation design.
