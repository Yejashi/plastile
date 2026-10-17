# Source index and audit boundaries

Research date: **17 October 2026**, America/New_York. Source acquisition used the GitHub connector with immutable commit references. Codeberg reads were attempted and failed.

## What was and was not verified

The research acquired 535 source, configuration, metadata, and supporting files from fourteen repositories, including separate KWin development, Plasma/6.7, and Plasma/6.8 snapshots. The architectural audit traces selected entry points, event handlers, layout representations, geometry writers, scheduling mechanisms, configuration paths, and teardown paths. It does not claim a line-by-line review of every acquired file, a full security audit, or runtime validation. Third-party source is not vendored in this repository.

Performance consequences are identified as inferences; all Plastile numerical budgets are proposals. A code comment saying a workaround fixes a problem is evidence of the upstream design intent, not independent proof of the fix. Issue reports are similarly not reproduced here.

The current Codeberg homes of anametologin/Krohnkite and Serroda/fluid-tile were inaccessible. Their pinned GitHub snapshots below are useful source evidence, but cannot establish the current Codeberg state. Refresh those homes during M0 if accessible.

## Repository snapshots

| ID | Repository | Commit | Commit date | Acquisition |
|---|---|---|---|---|
| P01 | [esjeon/krohnkite](https://github.com/esjeon/krohnkite) | [bc6fe23afe4e](https://github.com/esjeon/krohnkite/commit/bc6fe23afe4eb545a75755206e982b273426e32e) | 2022-04-26 | 45 files; KWin count includes release profiles |
| P02 | [anametologin/krohnkite](https://github.com/anametologin/krohnkite) | [f5865562955c](https://github.com/anametologin/krohnkite/commit/f5865562955c45fddb9f4c6ae7e657140d670a95) | 2025-12-11 | 69 files; KWin count includes release profiles |
| P03 | [Bismuth-Forge/bismuth](https://github.com/Bismuth-Forge/bismuth) | [ef69afe69f61](https://github.com/Bismuth-Forge/bismuth/commit/ef69afe69f615149ab347e4402862ee900452a65) | 2022-12-22 | 84 files; KWin count includes release profiles |
| P04 | [zeroxoneafour/polonium](https://github.com/zeroxoneafour/polonium) | [227967ed4482](https://github.com/zeroxoneafour/polonium/commit/227967ed448205d42b5e63e4cc4b868d72606467) | 2026-09-08 | 42 files; KWin count includes release profiles |
| P05 | [peterfajdiga/karousel](https://github.com/peterfajdiga/karousel) | [8b9f0b62b292](https://github.com/peterfajdiga/karousel/commit/8b9f0b62b2922703d7c25a79d5d49ae93cd3f93b) | 2026-08-23 | 122 files; KWin count includes release profiles |
| P06 | [Serroda/fluid-tile](https://github.com/Serroda/fluid-tile) | [a980ec9c19e4](https://github.com/Serroda/fluid-tile/commit/a980ec9c19e49ec84ab3665e1cd4a4d30adf1570) | 2026-03-23 | 20 files; KWin count includes release profiles |
| P08 | [gerritdevriese/kzones](https://github.com/gerritdevriese/kzones) | [e261b5ffb7af](https://github.com/gerritdevriese/kzones/commit/e261b5ffb7af5d16a42764349783b464c70719af) | 2026-09-07 | 18 files; KWin count includes release profiles |
| P09 | [darkstego/Mudeer](https://github.com/darkstego/Mudeer) | [0967c4637fe5](https://github.com/darkstego/Mudeer/commit/0967c4637fe5504bfc56d4e0434505194d674c6f) | 2026-09-29 | 6 files; KWin count includes release profiles |
| P10 | [kwin-scripts/kwin-tiling](https://github.com/kwin-scripts/kwin-tiling) | [ab03bc34d76f](https://github.com/kwin-scripts/kwin-tiling/commit/ab03bc34d76faa8c1511050c6b4d835825b4882d) | 2022-11-08 | 20 files; KWin count includes release profiles |
| P11 | [lingtjien/Grid-Tiling-Kwin](https://github.com/lingtjien/Grid-Tiling-Kwin) | [725c25b8242c](https://github.com/lingtjien/Grid-Tiling-Kwin/commit/725c25b8242c603cbe0659f1e148f029241d2e76) | 2026-08-22 | 15 files; KWin count includes release profiles |
| KDEV | [KDE/kwin](https://github.com/KDE/kwin) | [c08459bfa826](https://github.com/KDE/kwin/commit/c08459bfa82671f14904e3eda513335a2b0fd7f9) | 2026-10-17 | 56 files; KWin count includes release profiles |
| P07 | [fuddlesworth/PlasmaZones](https://github.com/fuddlesworth/PlasmaZones) | [b0345bd89c71](https://github.com/fuddlesworth/PlasmaZones/commit/b0345bd89c7187ab5aa5386656bd1fd0a34cc05d) | 2026-10-16 | 30 files; KWin count includes release profiles |
| BSP | [baskerville/bspwm](https://github.com/baskerville/bspwm) | [e11eff4cb333](https://github.com/baskerville/bspwm/commit/e11eff4cb3333216ad03c815609a4ed79e08929c) | 2026-01-08 | 4 files; KWin count includes release profiles |
| I3 | [i3/i3](https://github.com/i3/i3) | [be04c853ee7f](https://github.com/i3/i3/commit/be04c853ee7fa01a82a0c81f8217565395e2627c) | 2026-10-12 | 4 files; KWin count includes release profiles |

## Release profiles

KWin development snapshot declares `6.8.80`. The Plasma/6.7 snapshot declares `6.7.5`; Plasma/6.8 declares `6.8.1`. These are source version strings at the inspected commits, not proof that a distribution has packaged them or that the user is running them.

## Evidence entries

Each entry is a pinned upstream file. The symbols identify the part read or traced. Related implementation/configuration files acquired for navigation are enumerated separately in `sources.lock.json`.

## P01-driver

[src/driver/kwin/kwindriver.ts](https://github.com/esjeon/krohnkite/blob/bc6fe23afe4eb545a75755206e982b273426e32e/src/driver/kwin/kwindriver.ts)

KWinDriver.main, bindEvents, connect, enter; first-show fallback and nested-event suppression.

## P01-engine

[src/engine/engine.ts](https://github.com/esjeon/krohnkite/blob/bc6fe23afe4eb545a75755206e982b273426e32e/src/engine/engine.ts)

TilingEngine.arrange, arrangeScreen; solve each visible screen and commit window state.

## P01-window

[src/driver/kwin/kwinwindow.ts](https://github.com/esjeon/krohnkite/blob/bc6fe23afe4eb545a75755206e982b273426e32e/src/driver/kwin/kwinwindow.ts)

KWinWindow.commit and adjustGeometry; geometry, borders, min/max and increments.

## P01-layout

[src/layouts/tilelayout.ts](https://github.com/esjeon/krohnkite/blob/bc6fe23afe4eb545a75755206e982b273426e32e/src/layouts/tilelayout.ts)

Master/stack application and layout adjustment.

## P01-state

[src/engine/window.ts](https://github.com/esjeon/krohnkite/blob/bc6fe23afe4eb545a75755206e982b273426e32e/src/engine/window.ts)

WindowState, desired and float geometry, commit.

## P02-driver

[src/driver/kwindriver.ts](https://github.com/anametologin/krohnkite/blob/f5865562955c45fddb9f4c6ae7e657140d670a95/src/driver/kwindriver.ts)

KWinDriver.enter, output movement polling, modern window signals.

## P02-engine

[src/engine/engine.ts](https://github.com/anametologin/krohnkite/blob/f5865562955c45fddb9f4c6ae7e657140d670a95/src/engine/engine.ts)

Surface collection, capacity and overflow transfers, arrangeScreen.

## P02-window

[src/driver/kwinwindow.ts](https://github.com/anametologin/krohnkite/blob/f5865562955c45fddb9f4c6ae7e657140d670a95/src/driver/kwinwindow.ts)

Geometry assignment, output confinement, pointer actions.

## P02-timer

[src/driver/kwinsettimeout.ts](https://github.com/anametologin/krohnkite/blob/f5865562955c45fddb9f4c6ae7e657140d670a95/src/driver/kwinsettimeout.ts)

Pooled dynamically created QML Timer instances.

## P02-readme

[README.md](https://github.com/anametologin/krohnkite/blob/f5865562955c45fddb9f4c6ae7e657140d670a95/README.md)

Explicit Codeberg migration and reload warning.

## P03-driver

[src/kwinscript/driver/index.ts](https://github.com/Bismuth-Forge/bismuth/blob/ef69afe69f615149ab347e4402862ee900452a65/src/kwinscript/driver/index.ts)

DriverImpl, connection registry, drop, enter.

## P03-engine

[src/kwinscript/engine/index.ts](https://github.com/Bismuth-Forge/bismuth/blob/ef69afe69f615149ab347e4402862ee900452a65/src/kwinscript/engine/index.ts)

TypeScript engine and arrangement.

## P03-core

[src/core/controller.cpp](https://github.com/Bismuth-Forge/bismuth/blob/ef69afe69f615149ab347e4402862ee900452a65/src/core/controller.cpp)

C++ action registration through KGlobalAccel.

## P03-proxy

[src/core/ts-proxy.cpp](https://github.com/Bismuth-Forge/bismuth/blob/ef69afe69f615149ab347e4402862ee900452a65/src/core/ts-proxy.cpp)

Bridge from TypeScript to supporting C++ functionality.

## P03-kcm

[src/kcm/package/contents/ui/main.qml](https://github.com/Bismuth-Forge/bismuth/blob/ef69afe69f615149ab347e4402862ee900452a65/src/kcm/package/contents/ui/main.qml)

KCM settings shell and page integration.

## P04-controller

[src/controller/index.ts](https://github.com/zeroxoneafour/polonium/blob/227967ed448205d42b5e63e4cc4b868d72606467/src/controller/index.ts)

Event/post-event queues, processingEvents, per-display rebuilds.

## P04-events

[src/controller/event.ts](https://github.com/zeroxoneafour/polonium/blob/227967ed448205d42b5e63e4cc4b868d72606467/src/controller/event.ts)

Display key, simplifyEvents, duplicate/cancellation passes.

## P04-config

[src/controller/config.ts](https://github.com/zeroxoneafour/polonium/blob/227967ed448205d42b5e63e4cc4b868d72606467/src/controller/config.ts)

RebuildDelay default and engine/rule options.

## P04-build

[src/driver/buildlayout.ts](https://github.com/zeroxoneafour/polonium/blob/227967ed448205d42b5e63e4cc4b868d72606467/src/driver/buildlayout.ts)

BFS reconciliation, matchChildren, temporary minimum sizing.

## P04-driver

[src/driver/index.ts](https://github.com/zeroxoneafour/polonium/blob/227967ed448205d42b5e63e4cc4b868d72606467/src/driver/index.ts)

Window/tile maps, buildLayout, Tile.manage, native tile callbacks.

## P04-btree

[src/engine/layouts/btree.ts](https://github.com/zeroxoneafour/polonium/blob/227967ed448205d42b5e63e4cc4b868d72606467/src/engine/layouts/btree.ts)

Persistent binary-tree engine and insertion strategies.

## P04-main

[src/qml/main.qml](https://github.com/zeroxoneafour/polonium/blob/227967ed448205d42b5e63e4cc4b868d72606467/src/qml/main.qml)

Declarative root, timer, handlers and TypeScript entry.

## P05-world

[src/lib/world/World.ts](https://github.com/peterfajdiga/karousel/blob/8b9f0b62b2922703d7c25a79d5d49ae93cd3f93b/src/lib/world/World.ts)

Command/update flow and output settle delayer.

## P05-context

[src/lib/world/DesktopManager.ts](https://github.com/peterfajdiga/karousel/blob/8b9f0b62b2922703d7c25a79d5d49ae93cd3f93b/src/lib/world/DesktopManager.ts)

activity|desktop key and selectedScreen model.

## P05-wrapper

[src/lib/world/ClientWrapper.ts](https://github.com/peterfajdiga/karousel/blob/8b9f0b62b2922703d7c25a79d5d49ae93cd3f93b/src/lib/world/ClientWrapper.ts)

place, geometry manipulation guard and Wayland workaround.

## P05-grid

[src/lib/layout/Grid.ts](https://github.com/peterfajdiga/karousel/blob/8b9f0b62b2922703d7c25a79d5d49ae93cd3f93b/src/lib/layout/Grid.ts)

Column linked list, arrange, width updates, resize-finish delay.

## P05-column

[src/lib/layout/Column.ts](https://github.com/peterfajdiga/karousel/blob/8b9f0b62b2922703d7c25a79d5d49ae93cd3f93b/src/lib/layout/Column.ts)

Column arrangement and stacked windows.

## P05-tiled

[src/lib/world/clientState/Tiled.ts](https://github.com/peterfajdiga/karousel/blob/8b9f0b62b2922703d7c25a79d5d49ae93cd3f93b/src/lib/world/clientState/Tiled.ts)

Resize ownership and external-geometry rate limiter.

## P05-signals

[src/lib/utils/SignalManager.ts](https://github.com/peterfajdiga/karousel/blob/8b9f0b62b2922703d7c25a79d5d49ae93cd3f93b/src/lib/utils/SignalManager.ts)

Connection lifecycle management.

## P06-main

[contents/code/main.mjs](https://github.com/Serroda/fluid-tile/blob/a980ec9c19e49ec84ab3665e1cd4a4d30adf1570/contents/code/main.mjs)

Engine lifecycle, tile changes, deferral and layout overflow.

## P06-windows

[contents/code/windows.mjs](https://github.com/Serroda/fluid-tile/blob/a980ec9c19e49ec84ab3665e1cd4a4d30adf1570/contents/code/windows.mjs)

Native assignment, shadow tile, extension and geometry.

## P06-tiles

[contents/code/tiles.mjs](https://github.com/Serroda/fluid-tile/blob/a980ec9c19e49ec84ab3665e1cd4a4d30adf1570/contents/code/tiles.mjs)

Native layout parsing and tile selection.

## P06-timer

[contents/code/timer.mjs](https://github.com/Serroda/fluid-tile/blob/a980ec9c19e49ec84ab3665e1cd4a4d30adf1570/contents/code/timer.mjs)

Per-ID timer jobs and restart semantics.

## P06-qml

[contents/ui/main.qml](https://github.com/Serroda/fluid-tile/blob/a980ec9c19e49ec84ab3665e1cd4a4d30adf1570/contents/ui/main.qml)

QML timer instantiation and 350/300 ms special-path defaults.

## P07-retile

[phosphor-libs/libs/phosphor-tile-engine/src/autotileengine/retile.cpp](https://github.com/fuddlesworth/PlasmaZones/blob/b0345bd89c7187ab5aa5386656bd1fd0a34cc05d/phosphor-libs/libs/phosphor-tile-engine/src/autotileengine/retile.cpp)

Queued per-screen coalescing, immediate operations, bounded retry.

## P07-apply

[plasmazones/kwin-effect/plasmazoneseffect/window_geometry_apply.cpp](https://github.com/fuddlesworth/PlasmaZones/blob/b0345bd89c7187ab5aa5386656bd1fd0a34cc05d/plasmazones/kwin-effect/plasmazoneseffect/window_geometry_apply.cpp)

Commanded versus committed geometry, stamps, no-op guard, stale-ack handling.

## P07-batch

[plasmazones/kwin-effect/plasmazoneseffect/daemon_apply.cpp](https://github.com/fuddlesworth/PlasmaZones/blob/b0345bd89c7187ab5aa5386656bd1fd0a34cc05d/plasmazones/kwin-effect/plasmazoneseffect/daemon_apply.cpp)

slotApplyGeometriesBatch, per-window commands and context checks.

## P07-daemon

[phosphor-libs/libs/phosphor-compositor/include/PhosphorCompositor/DaemonClient.h](https://github.com/fuddlesworth/PlasmaZones/blob/b0345bd89c7187ab5aa5386656bd1fd0a34cc05d/phosphor-libs/libs/phosphor-compositor/include/PhosphorCompositor/DaemonClient.h)

D-Bus client and geometry handler boundary.

## P07-clock

[plasmazones/kwin-effect/compositor/compositorclock.cpp](https://github.com/fuddlesworth/PlasmaZones/blob/b0345bd89c7187ab5aa5386656bd1fd0a34cc05d/plasmazones/kwin-effect/compositor/compositorclock.cpp)

Compositor clock integration.

## P07-animation

[plasmazones/kwin-effect/compositor/windowanimator.cpp](https://github.com/fuddlesworth/PlasmaZones/blob/b0345bd89c7187ab5aa5386656bd1fd0a34cc05d/plasmazones/kwin-effect/compositor/windowanimator.cpp)

Animation ownership, retargeting, repaint and cleanup.

## P07-deferred

[plasmazones/kwin-effect/compositor/deferredwindowcommits.h](https://github.com/fuddlesworth/PlasmaZones/blob/b0345bd89c7187ab5aa5386656bd1fd0a34cc05d/plasmazones/kwin-effect/compositor/deferredwindowcommits.h)

Cancellable per-window deferred operations and lifetime safety.

## P07-luau

[phosphor-libs/libs/phosphor-tiles/src/luautilealgorithm.cpp](https://github.com/fuddlesworth/PlasmaZones/blob/b0345bd89c7187ab5aa5386656bd1fd0a34cc05d/phosphor-libs/libs/phosphor-tiles/src/luautilealgorithm.cpp)

Separate VM policy, cached metadata, watchdog invocation, bounded zone validation.

## P07-compat

[plasmazones/kwin-effect/kwincompat.h](https://github.com/fuddlesworth/PlasmaZones/blob/b0345bd89c7187ab5aa5386656bd1fd0a34cc05d/plasmazones/kwin-effect/kwincompat.h)

Explicit 6.7 versus 6.8 rendering API differences.

## P07-bridge

[plasmazones/kwin-effect/compositor/compositorbridge.cpp](https://github.com/fuddlesworth/PlasmaZones/blob/b0345bd89c7187ab5aa5386656bd1fd0a34cc05d/plasmazones/kwin-effect/compositor/compositorbridge.cpp)

Native KWin access and window lifetime filtering.

## P08-qml

[src/contents/ui/main.qml](https://github.com/gerritdevriese/kzones/blob/e261b5ffb7af5d16a42764349783b464c70719af/src/contents/ui/main.qml)

Overlay geometry, moveClientToZone, visible-only pointer polling.

## P08-core

[src/contents/code/core.mjs](https://github.com/gerritdevriese/kzones/blob/e261b5ffb7af5d16a42764349783b464c70719af/src/contents/code/core.mjs)

Configuration defaults including polling and zone layout data.

## P08-selector

[src/contents/ui/components/Selector.qml](https://github.com/gerritdevriese/kzones/blob/e261b5ffb7af5d16a42764349783b464c70719af/src/contents/ui/components/Selector.qml)

Visual zone selection interaction.

## P09-main

[package/contents/code/main.js](https://github.com/darkstego/Mudeer/blob/0967c4637fe5504bfc56d4e0434505194d674c6f/package/contents/code/main.js)

Tile.getGeometry, move, sequential shortcuts, portrait rotation.

## P10-manager

[contents/code/tilingmanager.js](https://github.com/kwin-scripts/kwin-tiling/blob/ab03bc34d76faa8c1511050c6b4d835825b4882d/contents/code/tilingmanager.js)

Workspace signals, tile manager, per-context layout management.

## P10-tiling

[contents/code/tiling.js](https://github.com/kwin-scripts/kwin-tiling/blob/ab03bc34d76faa8c1511050c6b4d835825b4882d/contents/code/tiling.js)

_updateAllTiles, screen clipping and gaps.

## P10-i3

[contents/code/i3layout.js](https://github.com/kwin-scripts/kwin-tiling/blob/ab03bc34d76faa8c1511050c6b4d835825b4882d/contents/code/i3layout.js)

i3-style container tree layout.

## P10-qml

[contents/ui/main.qml](https://github.com/kwin-scripts/kwin-tiling/blob/ab03bc34d76faa8c1511050c6b4d835825b4882d/contents/ui/main.qml)

500 ms screen resize and 1 ms geometry timers.

## P11-manager

[contents/component/manager.mjs](https://github.com/lingtjien/Grid-Tiling-Kwin/blob/725c25b8242c603cbe0659f1e148f029241d2e76/contents/component/manager.mjs)

Lifecycle, force geometry, context delay, restore and teardown.

## P11-layout

[contents/component/layout.mjs](https://github.com/lingtjien/Grid-Tiling-Kwin/blob/725c25b8242c603cbe0659f1e148f029241d2e76/contents/component/layout.mjs)

Activity dispatch and render traversal.

## P11-output

[contents/component/output.mjs](https://github.com/lingtjien/Grid-Tiling-Kwin/blob/725c25b8242c603cbe0659f1e148f029241d2e76/contents/component/output.mjs)

Per-output lists, capacity, movement and resizing.

## P11-list

[contents/component/list.mjs](https://github.com/lingtjien/Grid-Tiling-Kwin/blob/725c25b8242c603cbe0659f1e148f029241d2e76/contents/component/list.mjs)

Row geometry, dividers, renderGeometry before KWin writes.

## P11-config

[contents/component/config.mjs](https://github.com/lingtjien/Grid-Tiling-Kwin/blob/725c25b8242c603cbe0659f1e148f029241d2e76/contents/component/config.mjs)

Cached configuration and delay default.

## P11-main

[contents/component/main.mjs](https://github.com/lingtjien/Grid-Tiling-Kwin/blob/725c25b8242c603cbe0659f1e148f029241d2e76/contents/component/main.mjs)

Workspace signal registration and destroy.

## KDEV-window

[src/window.cpp](https://github.com/KDE/kwin/blob/c08459bfa82671f14904e3eda513335a2b0fd7f9/src/window.cpp)

moveResize, requestedTile, requestTile and deprecated tile setter.

## KDEV-xdg

[src/xdgshellwindow.cpp](https://github.com/KDE/kwin/blob/c08459bfa82671f14904e3eda513335a2b0fd7f9/src/xdgshellwindow.cpp)

scheduleConfigure, handleCommit, moveResizeInternal, handleRoleCommit.

## KDEV-scripting

[src/scripting/scripting.cpp](https://github.com/KDE/kwin/blob/c08459bfa82671f14904e3eda513335a2b0fd7f9/src/scripting/scripting.cpp)

QJSEngine, declarative QQmlComponent, script load/unload and config changes.

## KDEV-shortcut

[src/scripting/shortcuthandler.cpp](https://github.com/KDE/kwin/blob/c08459bfa82671f14904e3eda513335a2b0fd7f9/src/scripting/shortcuthandler.cpp)

Shortcut registration and lifetime.

## KDEV-loop

[src/core/renderloop.cpp](https://github.com/KDE/kwin/blob/c08459bfa82671f14904e3eda513335a2b0fd7f9/src/core/renderloop.cpp)

Frame scheduling and presentation bookkeeping.

## KDEV-tests

[autotests/integration/quick_tiling_test.cpp](https://github.com/KDE/kwin/blob/c08459bfa82671f14904e3eda513335a2b0fd7f9/autotests/integration/quick_tiling_test.cpp)

Existing compositor-level tiling tests.

## I3-render

[src/render.c](https://github.com/i3/i3/blob/be04c853ee7fa01a82a0c81f8217565395e2627c/src/render.c)

Recursive container layout, splits, stacked/tabbed and dock areas.

## I3-tree

[src/tree.c](https://github.com/i3/i3/blob/be04c853ee7fa01a82a0c81f8217565395e2627c/src/tree.c)

tree_render: calculate rectangles then x_push_changes.

## I3-ewmh

[src/ewmh.c](https://github.com/i3/i3/blob/be04c853ee7fa01a82a0c81f8217565395e2627c/src/ewmh.c)

Desktop and active-window metadata integration.

## BSP-tree

[src/tree.c](https://github.com/baskerville/bspwm/blob/e11eff4cb3333216ad03c815609a4ed79e08929c/src/tree.c)

arrange and apply_layout on persistent binary tree.

## BSP-window

[src/window.c](https://github.com/baskerville/bspwm/blob/e11eff4cb3333216ad03c815609a4ed79e08929c/src/window.c)

Window manage/resize and XCB configure operations.

## BSP-ewmh

[src/ewmh.c](https://github.com/baskerville/bspwm/blob/e11eff4cb3333216ad03c815609a4ed79e08929c/src/ewmh.c)

EWMH desktop, work area and client properties.

## K67-workspace

[src/scripting/workspace_wrapper.h](https://github.com/KDE/kwin/blob/717f774ec8db995c53a086d334ce89d118d8b80d/src/scripting/workspace_wrapper.h)

rootTile, currentDesktopForScreen, clientArea, deprecated tilingForScreen.

## K67-window

[src/window.h](https://github.com/KDE/kwin/blob/717f774ec8db995c53a086d334ce89d118d8b80d/src/window.h)

Script-visible properties, signals, output mutability and requested tile compatibility.

## K67-tile

[src/tiles/tile.cpp](https://github.com/KDE/kwin/blob/717f774ec8db995c53a086d334ce89d118d8b80d/src/tiles/tile.cpp)

setRelativeGeometry, work-area conversion, padding, manage/unmanage.

## K67-tile-header

[src/tiles/tile.h](https://github.com/KDE/kwin/blob/717f774ec8db995c53a086d334ce89d118d8b80d/src/tiles/tile.h)

Invokable surface and default minimum size.

## K67-custom

[src/tiles/customtile.cpp](https://github.com/KDE/kwin/blob/717f774ec8db995c53a086d334ce89d118d8b80d/src/tiles/customtile.cpp)

Split, remove and sibling geometry propagation.

## K67-manager

[src/tiles/tilemanager.cpp](https://github.com/KDE/kwin/blob/717f774ec8db995c53a086d334ce89d118d8b80d/src/tiles/tilemanager.cpp)

Output/desktop roots and debounced settings persistence.

## K67-xdg

[src/xdgshellwindow.cpp](https://github.com/KDE/kwin/blob/717f774ec8db995c53a086d334ce89d118d8b80d/src/xdgshellwindow.cpp)

Asynchronous configure and client commit semantics.

## K67-version

[CMakeLists.txt](https://github.com/KDE/kwin/blob/717f774ec8db995c53a086d334ce89d118d8b80d/CMakeLists.txt)

Exact development version string and dependencies.

## K68-workspace

[src/scripting/workspace_wrapper.h](https://github.com/KDE/kwin/blob/21e5e225370fbcaf7e49bd97751f9c29c280e2c6/src/scripting/workspace_wrapper.h)

rootTile, currentDesktopForScreen, clientArea, deprecated tilingForScreen.

## K68-window

[src/window.h](https://github.com/KDE/kwin/blob/21e5e225370fbcaf7e49bd97751f9c29c280e2c6/src/window.h)

Script-visible properties, signals, output mutability and requested tile compatibility.

## K68-tile

[src/tiles/tile.cpp](https://github.com/KDE/kwin/blob/21e5e225370fbcaf7e49bd97751f9c29c280e2c6/src/tiles/tile.cpp)

setRelativeGeometry, work-area conversion, padding, manage/unmanage.

## K68-tile-header

[src/tiles/tile.h](https://github.com/KDE/kwin/blob/21e5e225370fbcaf7e49bd97751f9c29c280e2c6/src/tiles/tile.h)

Invokable surface and default minimum size.

## K68-custom

[src/tiles/customtile.cpp](https://github.com/KDE/kwin/blob/21e5e225370fbcaf7e49bd97751f9c29c280e2c6/src/tiles/customtile.cpp)

Split, remove and sibling geometry propagation.

## K68-manager

[src/tiles/tilemanager.cpp](https://github.com/KDE/kwin/blob/21e5e225370fbcaf7e49bd97751f9c29c280e2c6/src/tiles/tilemanager.cpp)

Output/desktop roots and debounced settings persistence.

## K68-xdg

[src/xdgshellwindow.cpp](https://github.com/KDE/kwin/blob/21e5e225370fbcaf7e49bd97751f9c29c280e2c6/src/xdgshellwindow.cpp)

Asynchronous configure and client commit semantics.

## K68-version

[CMakeLists.txt](https://github.com/KDE/kwin/blob/21e5e225370fbcaf7e49bd97751f9c29c280e2c6/CMakeLists.txt)

Exact development version string and dependencies.

## Primary documentation

- [KDE KWin scripting tutorial](https://develop.kde.org/docs/plasma/kwin/).
- [KDE generated Workspace QML API](https://api.kde.org/qml-org-kde-kwin-workspace.html).
- [KDE older scripting API reference](https://develop.kde.org/docs/plasma/kwin/api/); compare to source because some signatures lag.
- [Qt QML Timer](https://doc.qt.io/qt-6/qml-qtqml-timer.html): animation-clock synchronization; timer interval is not a latency guarantee.
- [Qt.callLater](https://doc.qt.io/qt-6/qml-qtqml-qt.html#callLater-method): deferred same-function coalescing.
- [xdg-shell protocol source](https://gitlab.freedesktop.org/wayland/wayland-protocols/-/blob/main/stable/xdg-shell/xdg-shell.xml): authoritative protocol definition. KWin source is the inspected implementation.
- [KDE integration with other window managers](https://userbase.kde.org/Tutorials/Using_Other_Window_Managers_with_Plasma): X11 replacement approach.

## Upstream issue leads

These are unverified reports across different versions. Do not quote them as proof that a current release is broken.

- [Polonium #71](https://github.com/zeroxoneafour/polonium/issues/71): historical Plasma 5.27 stutter report; motivates filtering helper surfaces and measuring event storms.
- [Polonium #221](https://github.com/zeroxoneafour/polonium/issues/221) and [Krohnkite #243](https://github.com/esjeon/krohnkite/issues/243): reported input-region mismatch; motivates independent hit-testing after placement.
- [Krohnkite continuation #234](https://github.com/anametologin/krohnkite/issues/234): floating-size restore expectation.
- [Karousel #194](https://github.com/peterfajdiga/karousel/issues/194): winewayland/scrcpy placement compatibility.
- [Karousel #166](https://github.com/peterfajdiga/karousel/issues/166): reported invisible windows; motivates opacity and off-screen teardown checks.
- [PlasmaZones #86](https://github.com/fuddlesworth/PlasmaZones/issues/86): output selection and restore expectations.
- [PlasmaZones #916](https://github.com/fuddlesworth/PlasmaZones/issues/916): reporter attributes a shell crash to a panel query during output changes; attribution was not reproduced.
- [Grid-Tiling-Kwin #150](https://github.com/lingtjien/Grid-Tiling-Kwin/issues/150): historical X11 media viewer geometry oscillation.
- [Grid-Tiling-Kwin #147](https://github.com/lingtjien/Grid-Tiling-Kwin/issues/147): floating-panel geometry interaction.

## Reproducing this audit

Use the commit and file paths in `sources.lock.json`. Fetch immutable file contents through GitHub or clone each upstream and check out the commit. For stable KWin entries use each file record's `ref`, not the repository's default snapshot commit. Compare file blob hashes when reproducing. The manifest distinguishes acquisition coverage from the curated evidence map. Do not execute upstream installation/build scripts merely to read source.
