// plastile-settings-check XML UI CONFIGFILE
// Loads the settings schema and form like KWin's ScriptingConfig (group "Script-plastile"),
// then: (1) every schema entry has a kcfg_ widget and vice versa, (2) defaults reach the
// widgets, (3) widget edits are saved with the runtime's vocabulary (Enum by choice name),
// (4) file values written by hand reach the widgets. Prints one JSON report.
#include <KConfigDialogManager>
#include <KConfigGroup>
#include <KConfigLoader>
#include <KSharedConfig>
#include <QApplication>
#include <QCheckBox>
#include <QComboBox>
#include <QDoubleSpinBox>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QPlainTextEdit>
#include <QSpinBox>
#include <QUiLoader>

static QJsonValue widgetValue(QWidget *w)
{
    if (auto c = qobject_cast<QComboBox *>(w)) return c->currentIndex();
    if (auto s = qobject_cast<QSpinBox *>(w)) return s->value();
    if (auto d = qobject_cast<QDoubleSpinBox *>(w)) return d->value();
    if (auto b = qobject_cast<QCheckBox *>(w)) return b->isChecked();
    if (auto t = qobject_cast<QPlainTextEdit *>(w)) return t->toPlainText();
    return QJsonValue();
}

int main(int argc, char **argv)
{
    qputenv("QT_QPA_PLATFORM", "offscreen");
    QApplication app(argc, argv);
    if (argc != 4) return 2;
    QJsonObject report;
    QJsonArray problems;

    auto config = KSharedConfig::openConfig(QString::fromLocal8Bit(argv[3]), KConfig::SimpleConfig);
    KConfigGroup group = config->group(QStringLiteral("Script-plastile"));
    QFile xml(QString::fromLocal8Bit(argv[1]));
    KConfigLoader loader(group, &xml);
    QUiLoader uiLoader;
    QFile ui(QString::fromLocal8Bit(argv[2]));
    if (!ui.open(QFile::ReadOnly)) return 2;
    QWidget *form = uiLoader.load(&ui);
    if (!form) {
        problems.append(QStringLiteral("ui did not load: ") + uiLoader.errorString());
        report[QStringLiteral("problems")] = problems;
        printf("%s\n", QJsonDocument(report).toJson(QJsonDocument::Compact).constData());
        return 1;
    }
    KConfigDialogManager manager(form, &loader);

    QJsonArray keys;
    const auto items = loader.items();
    for (KConfigSkeletonItem *item : items) {
        keys.append(item->key());
        if (!form->findChild<QWidget *>(QStringLiteral("kcfg_") + item->key()))
            problems.append(QStringLiteral("no widget for entry ") + item->key());
    }
    const auto widgets = form->findChildren<QWidget *>();
    for (QWidget *w : widgets) {
        if (w->objectName().startsWith(QLatin1String("kcfg_")) && !loader.findItemByName(w->objectName().mid(5)))
            problems.append(QStringLiteral("widget without entry ") + w->objectName());
    }
    report[QStringLiteral("keys")] = keys;

    manager.updateWidgets();
    QJsonObject defaults;
    for (KConfigSkeletonItem *item : items)
        defaults[item->key()] = widgetValue(form->findChild<QWidget *>(QStringLiteral("kcfg_") + item->key()));
    report[QStringLiteral("widgetDefaults")] = defaults;

    // Edit like a user, then save like KCModule::save().
    form->findChild<QComboBox *>(QStringLiteral("kcfg_layout"))->setCurrentIndex(1);
    form->findChild<QComboBox *>(QStringLiteral("kcfg_bspAxis"))->setCurrentIndex(1);
    form->findChild<QSpinBox *>(QStringLiteral("kcfg_gapInner"))->setValue(12);
    form->findChild<QDoubleSpinBox *>(QStringLiteral("kcfg_masterRatio"))->setValue(0.6);
    form->findChild<QCheckBox *>(QStringLiteral("kcfg_singleWindowGaps"))->setChecked(false);
    form->findChild<QPlainTextEdit *>(QStringLiteral("kcfg_configJson"))->setPlainText(QStringLiteral("{\"schemaVersion\": 1}"));
    report[QStringLiteral("hasChangedAfterEdit")] = manager.hasChanged();
    manager.updateSettings();
    loader.save();
    config->sync();
    QFile written(QString::fromLocal8Bit(argv[3]));
    if (!written.open(QFile::ReadOnly)) return 2;
    report[QStringLiteral("savedFile")] = QString::fromUtf8(written.readAll());

    // Hand-written values (kwriteconfig6 / docs) must reach the widgets.
    group.writeEntry("layout", QStringLiteral("monocle"));
    group.writeEntry("diagnostics", QStringLiteral("debug"));
    group.writeEntry("gapOuter", 3);
    config->sync();
    config->reparseConfiguration();
    loader.load();
    manager.updateWidgets();
    QJsonObject reloaded;
    for (const char *k : {"layout", "diagnostics", "gapOuter"})
        reloaded[QString::fromLatin1(k)] = widgetValue(form->findChild<QWidget *>(QStringLiteral("kcfg_") + QString::fromLatin1(k)));
    report[QStringLiteral("widgetsAfterHandEdit")] = reloaded;
    report[QStringLiteral("problems")] = problems;
    printf("%s\n", QJsonDocument(report).toJson(QJsonDocument::Indented).constData());
    return problems.isEmpty() ? 0 : 1;
}
