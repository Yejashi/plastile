// Plastile's rectangle overlay, used by the zones layout (experimental, docs/design/ZONES.md §4).
// Generic on purpose: rectangles with a label and a detail line, a heading and a hint come in, so
// other features (a drop preview, ADR-017) can reuse it. Created by main.qml's Loader
// on the first "Zones: show or hide the zone overlay", then hidden and shown again; destroyed on
// unload. It displays a precomputed view (src/runtime/zoneOverlay.ts): every rectangle is the
// engine's own projection, translated in TypeScript; nothing here computes geometry.
//
// Two internal windows, both captioned as Plastile's own UI (adapter.ts isOwnUi), so tiling
// excludes them:
// - the drawing covers the active output and is input-transparent (Qt.WindowTransparentForInput:
//   KWin's InternalWindow::hitTest rejects it, so pointer input reaches the windows below);
// - a small legend is a Qt.Popup: KWin gives it the popup grab, so it receives Escape. Like any
//   popup, KWin closes it on a click elsewhere (that click is consumed) or when a window is
//   activated; global shortcuts still run first.
// No timers, connections or geometry writes; nothing runs while hidden.
import QtQuick

Window {
    id: overlay
    required property var view
    property bool shown: false
    signal dismissed()

    title: view.windowTitle
    flags: Qt.FramelessWindowHint | Qt.WindowTransparentForInput | Qt.WindowDoesNotAcceptFocus | Qt.BypassWindowManagerHint
    color: "transparent"
    x: view.output.x
    y: view.output.y
    width: view.output.width
    height: view.output.height

    // show() maps an internal window from a script; setting `visible` did not (ADR-016).
    function showOverlay() {
        shown = true;
        overlay.show();
        legend.show();
    }
    function hideOverlay() {
        if (!shown) return;
        shown = false;
        legend.hide();
        overlay.hide();
    }

    SystemPalette { id: sys; colorGroup: SystemPalette.Active }

    Repeater {
        model: overlay.view.rects
        delegate: Rectangle {
            required property var modelData
            x: modelData.local.x
            y: modelData.local.y
            width: modelData.local.width
            height: modelData.local.height
            color: Qt.rgba(sys.highlight.r, sys.highlight.g, sys.highlight.b, 0.18)
            border.color: sys.highlight
            border.width: 2
            radius: 4

            Column {
                anchors.centerIn: parent
                spacing: 4
                Text {
                    anchors.horizontalCenter: parent.horizontalCenter
                    text: modelData.label
                    font.pixelSize: Math.max(18, Math.min(96, Math.min(parent.parent.width, parent.parent.height) / 4))
                    font.bold: true
                    color: sys.highlightedText
                    style: Text.Outline
                    styleColor: sys.highlight
                }
                Text {
                    anchors.horizontalCenter: parent.horizontalCenter
                    visible: modelData.detail !== ""
                    text: modelData.detail
                    font.pixelSize: 14
                    color: sys.highlightedText
                    style: Text.Outline
                    styleColor: sys.highlight
                }
            }
        }
    }

    Window {
        id: legend
        title: overlay.view.windowTitle
        flags: Qt.Popup | Qt.FramelessWindowHint
        color: sys.window
        x: overlay.view.legend.x
        y: overlay.view.legend.y
        width: overlay.view.legend.width
        height: overlay.view.legend.height

        // KWin closed the popup (click elsewhere, activation) or Escape closed it.
        onVisibleChanged: if (!visible && overlay.shown) overlay.dismissed()

        Rectangle {
            anchors.fill: parent
            color: "transparent"
            border.color: sys.mid
            border.width: 1
        }

        Column {
            anchors.fill: parent
            anchors.margins: 8
            spacing: 2
            focus: true
            Keys.onEscapePressed: overlay.dismissed()

            Text {
                width: parent.width
                text: overlay.view.heading
                font.bold: true
                color: sys.windowText
                elide: Text.ElideRight
            }
            Text {
                width: parent.width
                text: overlay.view.hint
                font.pixelSize: 11
                color: sys.windowText
                elide: Text.ElideRight
            }
        }
    }
}
