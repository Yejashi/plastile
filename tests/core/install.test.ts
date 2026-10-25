// tools/install.sh and the persistence helper's D-Bus activation file (ADR-020). The session bus
// splits Exec= like a shell command line, so the file names the helper in double quotes and the
// installer reads that back as one path. Runs install.sh against a private HOME with a space in it;
// kpackagetool6 and cmake are stand-ins, so nothing is built or installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL = fileURLToPath(new URL("../../tools/install.sh", import.meta.url));
const SERVICE_IN = fileURLToPath(new URL("../../helper/org.kde.plastile.State.service.in", import.meta.url));

function withHome(body: (home: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), "plastile-install-"));
  try {
    const home = join(base, "home dir");
    mkdirSync(home);
    body(home);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function run(home: string, args: string[], extra: Record<string, string> = {}) {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, KPACKAGETOOL6: "true", ...extra };
  return spawnSync("sh", [INSTALL, ...args], { env, encoding: "utf8" });
}

// An installed helper: an executable stub and its activation file with the given Exec= value.
function installHelper(home: string, exec: (exe: string) => string): string {
  const exe = join(home, ".local/libexec/plastile-state");
  mkdirSync(join(home, ".local/libexec"), { recursive: true });
  writeFileSync(exe, "#!/bin/sh\nexit 0\n");
  chmodSync(exe, 0o755);
  mkdirSync(join(home, ".local/share/dbus-1/services"), { recursive: true });
  writeFileSync(join(home, ".local/share/dbus-1/services/org.kde.plastile.State.service"),
    `[D-BUS Service]\nName=org.kde.plastile.State\nExec=${exec(exe)}\n`);
  return exe;
}

test("B19: the activation file names the helper in double quotes, so a prefix with spaces stays one argument", () => {
  assert.match(readFileSync(SERVICE_IN, "utf8"), /^Exec="@PLASTILE_STATE_EXEC@"$/m);
});

test("B19: status reads a quoted Exec= with a space in the path as one installed helper", () => {
  withHome((home) => {
    const exe = installHelper(home, (p) => `"${p}"`);
    const r = run(home, ["status"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`helper    : installed (${exe}, started by the session bus)`), r.stdout);
  });
});

test("B19: status still reads the bare Exec= an older install wrote", () => {
  withHome((home) => {
    const exe = installHelper(home, (p) => p);
    const r = run(home, ["status"]);
    assert.ok(r.stdout.includes(`helper    : installed (${exe}, started by the session bus)`), r.stdout);
  });
});

test("B19: remove-helper removes the binary a quoted Exec= names", () => {
  withHome((home) => {
    const exe = installHelper(home, (p) => `"${p}"`);
    const r = run(home, ["remove-helper"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(exe), "the helper binary was removed");
    assert.ok(r.stdout.includes(`and ${exe}`), r.stdout);
  });
});

test("B19: install-helper refuses a prefix the activation file cannot name, before building", () => {
  withHome((home) => {
    const bin = join(home, "bin");
    mkdirSync(bin);
    const marker = join(home, "cmake-ran");
    writeFileSync(join(bin, "cmake"), `#!/bin/sh\necho "$@" >> '${marker}'\nexit 1\n`);
    chmodSync(join(bin, "cmake"), 0o755);
    for (const bad of ['a"b', "a\\b", "a$b", "a`b"]) {
      const r = run(home, ["install-helper"], { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        PLASTILE_HELPER_PREFIX: join(home, bad), PLASTILE_HELPER_BUILD: join(home, "build") });
      assert.equal(r.status, 1, `${bad}: ${r.stderr}`);
      assert.match(r.stderr, /cannot name: set PLASTILE_HELPER_PREFIX/, bad);
    }
    assert.ok(!existsSync(marker), "cmake was never run");
  });
});
