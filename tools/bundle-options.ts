// esbuild options for the KWin bundle, shared by tools/build.mjs and tests/core/bundle.test.ts
// (the test bundles in memory with exactly these options and checks the output).
// Output: package/contents/code/plastile.mjs, an ECMAScript module imported by the
// declarative root as `import "../code/plastile.mjs" as Bundle` (no export getters).
// Target ES2016 lowers syntax KWin's QV4 (Qt 6.12) rejects: class fields, object
// spread/rest, async, logical assignment, optional catch binding (M0 probe).

import type { BuildOptions } from "esbuild";

export const BUNDLE_OUT = "package/contents/code/plastile.mjs";

export const BUNDLE_OPTIONS: BuildOptions = {
  entryPoints: ["src/runtime/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2016",
  platform: "neutral",
  legalComments: "none",
  charset: "utf8",
  minify: false,
  logLevel: "warning",
};
