// Plastile's explain view (T28). Created by main.qml's Loader only when "Explain active
// window" runs, destroyed when it closes. It displays a precomputed view (src/runtime/
// inspect.ts) and does nothing else: no signal connections, no timers, no geometry writes
// to other windows. A popup window (Qt.Popup) receives the keyboard while it is open, so
// Escape closes it; KWin closes it on a click elsewhere or when another window is activated.
// Its caption marks it as Plastile's own UI, which tiling excludes (adapter.ts isOwnUi).
import QtQuick

Window {
    id: win
    required property var view
    property bool details: false
    signal dismissed()

    title: view.windowTitle
    flags: Qt.Popup | Qt.FramelessWindowHint
    color: sys.window
    width: 560
    height: Math.min(body.implicitHeight + 2 * pad, view.area ? view.area.height - 80 : 600)
    x: view.area ? Math.round(view.area.x + (view.area.width - width) / 2) : 100
    y: view.area ? Math.round(view.area.y + Math.max(40, (view.area.height - height) / 3)) : 100

    readonly property int pad: 16

    onVisibleChanged: if (!visible) win.dismissed()

    SystemPalette { id: sys; colorGroup: SystemPalette.Active }

    Rectangle {
        anchors.fill: parent
        color: "transparent"
        border.color: sys.mid
        border.width: 1
    }

    Flickable {
        anchors.fill: parent
        anchors.margins: win.pad
        contentHeight: body.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        Column {
            id: body
            width: parent.width
            spacing: 8
            focus: true
            Keys.onEscapePressed: win.close()

            Text {
                width: parent.width
                text: win.view.heading
                font.bold: true
                font.pixelSize: 16
                color: sys.windowText
                elide: Text.ElideRight
            }

            Repeater {
                model: win.view.rows
                delegate: Column {
                    required property var modelData
                    width: body.width
                    spacing: 2
                    Text {
                        visible: text !== ""
                        text: modelData.label
                        font.bold: true
                        color: sys.windowText
                    }
                    Text {
                        width: parent.width
                        text: modelData.text
                        wrapMode: Text.Wrap
                        color: sys.windowText
                    }
                }
            }

            Text {
                visible: win.view.details.length > 0
                text: win.details ? "Hide details" : "Show details"
                color: sys.highlight
                font.underline: true
                MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: win.details = !win.details
                }
            }

            Repeater {
                model: win.details ? win.view.details : []
                delegate: Text {
                    required property var modelData
                    width: body.width
                    text: modelData.label + ": " + modelData.text
                    wrapMode: Text.WrapAnywhere
                    font.family: "monospace"
                    font.pixelSize: 11
                    color: sys.windowText
                }
            }

            Text {
                width: parent.width
                text: "Escape, a click elsewhere, or “Explain active window” again closes this."
                wrapMode: Text.Wrap
                font.pixelSize: 11
                color: sys.mid
            }
        }
    }
}
