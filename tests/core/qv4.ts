// Run a TypeScript module in KWin's JavaScript engine (QV4) without KWin: the module is bundled
// with the bundle's own target (ES2016, tools/bundle-options.ts) and imported by a QML file that
// the `qml` tool runs on the offscreen platform. The qml tool loads the same libQt6Qml that KWin
// loads, so iteration, sorting and the collector are QV4's. Nothing is nested and no compositor
// runs; this is not KWin. Used by tests/core/qv4iteration.test.ts and probes/perf/qv4iter/engine.ts.
//
// The qml tool is $PLASTILE_QML when set. Otherwise the first Qt 6 one of: qml6 on PATH (Debian
// and Ubuntu: package qml-qt6, which also installs /usr/lib/qt6/bin/qml), /usr/lib/qt6/bin/qml,
// /usr/lib64/qt6/bin/qml, the qml in `qtpaths6 --query QT_INSTALL_BINS`, then qml on PATH (on some
// systems that is Qt 5's, which is rejected: its version must be 6 or later). Without one, qmlTool()
// returns null and callers skip, unless PLASTILE_REQUIRE_QV4=1 (requireQv4()), which CI's native-tools
// job sets so that the QV4 tests cannot be skipped silently there. The CI core job has no Qt.

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface QmlTool { readonly path: string; readonly version: string }

let found: QmlTool | null | undefined;

/** True when the QV4 tests must run here: a missing qml tool is then a failure, not a skip. */
export function requireQv4(): boolean { return process.env.PLASTILE_REQUIRE_QV4 === "1"; }

/** Where qmlTool() looks, in order (for messages). */
export function qmlCandidates(): string[] {
  if (process.env.PLASTILE_QML) return [process.env.PLASTILE_QML];
  const out = ["qml6", "/usr/lib/qt6/bin/qml", "/usr/lib64/qt6/bin/qml"];
  const q = spawnSync("qtpaths6", ["--query", "QT_INSTALL_BINS"], { encoding: "utf8", timeout: 10000 });
  const bins = q.status === 0 ? (q.stdout ?? "").trim() : "";
  if (bins) out.push(join(bins, "qml"));
  out.push("qml");
  return out;
}

/** The qml tool (Qt 6 or later) and its version line, or null when none runs here. */
export function qmlTool(): QmlTool | null {
  if (found !== undefined) return found;
  found = null;
  for (const c of qmlCandidates()) {
    const p = spawnSync(c, ["--version"], { encoding: "utf8", timeout: 10000 });
    const text = ((p.stdout ?? "") + (p.stderr ?? "")).trim();
    const m = text.match(/(\d+)\.\d+/);
    if (p.status === 0 && m && Number(m[1]) >= 6) {
      found = { path: c, version: text.split("\n")[0] };
      break;
    }
  }
  return found;
}

/** Bundle `entry` (an ES module) as the KWin bundle is built: ES2016, ESM, platform neutral. */
export async function bundle(entry: string): Promise<string> {
  const r = await build({ entryPoints: [entry], bundle: true, format: "esm", target: "es2016", platform: "neutral",
    write: false, outfile: "qv4entry.mjs", legalComments: "none", charset: "utf8", logLevel: "warning" });
  return r.outputFiles![0].text;
}

const QML = `import QtQml
import "entry.mjs" as Entry
QtObject {
    Component.onCompleted: {
        try { console.warn("qv4result " + JSON.stringify(Entry.__FN__())); }
        catch (e) { console.warn("qv4error " + e + "\\n" + (e && e.stack ? e.stack : "")); }
        Qt.exit(0);
    }
}
`;

/**
 * Run a QML file with the qml tool on the offscreen platform and return the JSON its root logged
 * after `tag ` (one line). Throws on a `qv4error` line, or when no result appears.
 */
export function runQml(qml: string, tag: string, tool: QmlTool): unknown {
  const env = { ...process.env, QT_QPA_PLATFORM: "offscreen", QT_FORCE_STDERR_LOGGING: "1" };
  const p = spawnSync(tool.path, [qml], { encoding: "utf8", env, timeout: 120000, maxBuffer: 64 << 20 });
  const out = (p.stdout ?? "") + (p.stderr ?? "");
  const err = out.match(/qv4error ([\s\S]*)/);
  if (err) throw new Error(`QV4: ${err[1].trim().slice(0, 2000)}`);
  const m = out.match(new RegExp(tag + " (.*)"));
  if (!m) throw new Error(`no result from ${tool.path} (exit ${p.status}): ${out.slice(-2000)}`);
  return JSON.parse(m[1]);
}

/**
 * Call the exported zero-argument function `fn` of the bundled `entry` in QV4 and return its
 * JSON-serialised result. Throws with the engine's message when the function throws or the tool fails.
 */
export async function runInQv4(entry: string, fn: string, tool: QmlTool): Promise<unknown> {
  const code = await bundle(entry);
  const dir = mkdtempSync(join(tmpdir(), "plastile-qv4-"));
  try {
    writeFileSync(join(dir, "entry.mjs"), code);
    writeFileSync(join(dir, "main.qml"), QML.replace("__FN__", fn));
    return runQml(join(dir, "main.qml"), "qv4result", tool);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
