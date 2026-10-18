// MEASUREMENT-ONLY root variant (probes/perf/rss_bisect.py): only the production root's
// ShortcutHandlers, for the reload memory bisection. Never installed.
import QtQuick
import org.kde.kwin
import "../../../package/contents/code/plastile.mjs" as Bundle

Item {
    Instantiator {
        model: Bundle.COMMANDS
        delegate: ShortcutHandler { name: modelData.id; text: modelData.text; sequence: modelData.sequence; onActivated: {} }
    }
    Component.onCompleted: console.info("plastile info started variant-shortcuts")
    Component.onDestruction: console.info("plastile info stopped variant-shortcuts")
}
