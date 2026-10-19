// Type-aware check of src/ for iteration that KWin's QV4 runs differently from ECMAScript.
//
// QV4 (measured, Qt 6.12.0: probes/perf/qv4iter, docs/validation/PERFORMANCE.md §7.1) walks a
// Map, Set, or one of their iterators with for...of so that deleting the current entry, or one
// before it, skips the entry after it. Map/Set forEach and every engine Node runs follow
// ECMAScript, so no unit test can see the difference. Whether a loop body deletes from the
// collection it walks depends on every function it calls (engine callbacks, ledger, adapter,
// persistence), so the rule is mechanical: for...of only over arrays (and strings).
//
// Rejected:
//   - `for (x of e)` where e's type is not array-like: Map, Set, ReadonlyMap, ReadonlySet, their
//     keys()/values()/entries() iterators, Iterable<T>, IterableIterator<T>, and unions with any of them;
//   - `Array.from(e, mapFn)` where e is not array-like: mapFn runs during the iteration.
// Allowed: arrays, tuples, readonly arrays, strings; snapshots without a callback (`[...set]`,
// `Array.from(map.keys())`, `new Map(map)`), which finish iterating before any user code runs;
// Map/Set forEach.
//
// The types come from the TypeScript checker on the src/ program (tsconfig.runtime.json), so an
// alias, a getter, a parameter or a property typed as a Map is found the same as a local `new Map()`.

import ts from "typescript";
import { dirname, relative, resolve } from "node:path";

export interface IterationHazard {
  /** Path relative to the project root, 1-based line and column. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly kind: "for-of" | "array-from-callback";
  /** The iterated expression's source text and its type as the checker prints it. */
  readonly expression: string;
  readonly type: string;
}

export const RULE = "QV4's for...of over a Map, Set or their iterators skips an entry when the loop body deletes "
  + "(docs/validation/PERFORMANCE.md §7.1). Use Map/Set forEach, or iterate an array snapshot "
  + "(Array.from(collection.keys()) or [...set]) with an index loop or for...of over the array.";

function isArrayLike(checker: ts.TypeChecker, t: ts.Type): boolean {
  if (t.isUnion()) return t.types.every((u) => isArrayLike(checker, u));
  if (t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Never)) return true;
  if (t.isTypeParameter()) {
    const c = checker.getBaseConstraintOfType(t);
    return c !== undefined && c !== t && isArrayLike(checker, c);
  }
  return checker.isArrayType(t) || checker.isTupleType(t);
}

/** Every for...of (and Array.from with a callback) over something that is not an array in `program`'s files under `only`. */
export function iterationHazards(program: ts.Program, root: string, only: (file: string) => boolean): IterationHazard[] {
  const checker = program.getTypeChecker();
  const out: IterationHazard[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !only(sf.fileName)) continue;
    const report = (node: ts.Node, kind: IterationHazard["kind"], e: ts.Expression) => {
      const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.push({ file: relative(root, sf.fileName), line: lc.line + 1, column: lc.character + 1, kind,
        expression: e.getText(sf), type: checker.typeToString(checker.getTypeAtLocation(e)) });
    };
    const visit = (n: ts.Node): void => {
      if (ts.isForOfStatement(n) && !isArrayLike(checker, checker.getTypeAtLocation(n.expression))) {
        report(n, "for-of", n.expression);
      } else if (ts.isCallExpression(n) && n.arguments.length >= 2 && ts.isPropertyAccessExpression(n.expression)
          && n.expression.name.text === "from" && ts.isIdentifier(n.expression.expression)
          && n.expression.expression.text === "Array"
          && !isArrayLike(checker, checker.getTypeAtLocation(n.arguments[0]!))) {
        report(n, "array-from-callback", n.arguments[0]!);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** The check the build runs: the src/ program of tsconfig.runtime.json under `root`. */
export function checkProject(root: string, tsconfig = "tsconfig.runtime.json"): IterationHazard[] {
  const path = resolve(root, tsconfig);
  const cfg = ts.getParsedCommandLineOfConfigFile(path, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); },
  });
  if (!cfg) throw new Error(`cannot read ${path}`);
  const program = ts.createProgram(cfg.fileNames, cfg.options);
  const src = resolve(dirname(path), "src") + "/";
  return iterationHazards(program, root, (f) => resolve(f).startsWith(src));
}

/** Check one TypeScript source text (tests): ES2017 libraries, no Node types, strict, as src/ is checked. */
export function checkSource(code: string): IterationHazard[] {
  const fileName = resolve("/virtual/src/case.ts");
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2017, lib: ["lib.es2017.d.ts"], strict: true, types: [], noEmit: true };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (n, lang, ...rest) =>
    n === fileName ? ts.createSourceFile(n, code, lang, true, ts.ScriptKind.TS) : getSourceFile(n, lang, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (n) => n === fileName || fileExists(n);
  const program = ts.createProgram([fileName], options, host);
  return iterationHazards(program, "/virtual", (f) => f === fileName);
}

/** One line per hazard, for the build's error output. */
export function formatHazard(h: IterationHazard): string {
  const what = h.kind === "for-of" ? "for...of over" : "Array.from with a callback over";
  return `${h.file}:${h.line}:${h.column}: ${what} \`${h.expression}\` (${h.type})`;
}
