// Control for the lifecycle probe: only a ShortcutHandler, no connections.
import QtQuick
import org.kde.kwin
Item {
    ShortcutHandler {
        name: "plastile-probe-lifecycle-ping"
        text: "Plastile lifecycle probe ping"
        sequence: ""
    }
}
