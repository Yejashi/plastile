// Type-aware check of src/ for iteration that KWin's QV4 runs differently from ECMAScript.
//
// QV4 (measured, Qt 6.12.0: probes/perf/qv4iter, docs/validation/PERFORMANCE.md §7.1) walks a
// Map, Set, or one of their iterators with for...of so that deleting the current entry, or one
// before it, skips the entry after it. Map/Set forEach and every engine Node runs follow
// ECMAScript, so no unit test can see the difference. Whether a loop body deletes from the
// collection it walks depends on every function it calls (engine callbacks, ledger, adapter,
// persistence), so the rule is mechanical: for...of only over arrays (and strings).
//
// Rejected (each one walks an iterator step by step, with user code between the steps; QV4 skips an
// entry in each of them, measured in probes/perf/qv4iter):
//   - `for (x of e)` where e's type is not array-like: Map, Set, ReadonlyMap, ReadonlySet, their
//     keys()/values()/entries() iterators, Iterable<T>, IterableIterator<T>, and unions with any of them;
//   - `Array.from(e, mapFn)` (or a typed array's `from`) where e is not array-like: mapFn runs during
//     the iteration. The call is recognised by its resolved signature, so an alias (`const A = Array`),
//     `Array["from"]` and a destructured `from` are found too. Any other use of a built-in `from` as a
//     value (`Array.from.call(...)`, `const f = Array.from`) is rejected, because its calls cannot be checked;
//   - `it.next()` on an iterator held in a variable or a property: a hand-written iteration loop.
//     Taking one step from a fresh iterator (`m.keys().next().value`) is allowed;
//   - `yield* e` where e is not array-like: the consumer's code runs between the steps.
// Not checked: array destructuring of a Map or Set (`const [a, b] = set`). A default initializer runs
// between its steps, but QV4 gave the ECMAScript result in the two deleting cases tried (probes/perf/qv4iter).
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
  readonly kind: "for-of" | "array-from-callback" | "array-from-indirect" | "iterator-next" | "yield-star";
  /** The iterated expression's source text and its type as the checker prints it. */
  readonly expression: string;
  readonly type: string;
}

export const RULE = "QV4's for...of over a Map, Set or their iterators skips an entry when the loop body deletes "
  + "(docs/validation/PERFORMANCE.md §7.1); so do a hand-written next() loop, yield* and Array.from's callback. "
  + "Use Map/Set forEach, or iterate an array snapshot (Array.from(collection.keys()) or [...set]) with an index "
  + "loop or for...of over the array.";

function isArrayLike(checker: ts.TypeChecker, t: ts.Type): boolean {
  if (t.isUnion()) return t.types.every((u) => isArrayLike(checker, u));
  if (t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Never)) return true;
  if (t.isTypeParameter()) {
    const c = checker.getBaseConstraintOfType(t);
    return c !== undefined && c !== t && isArrayLike(checker, c);
  }
  return checker.isArrayType(t) || checker.isTupleType(t);
}

/** Whether `d` declares the method `name` of an interface in TypeScript's default library (a built-in). */
function isLibMethod(program: ts.Program, d: ts.Node | undefined, name: string): d is ts.MethodSignature {
  return d !== undefined && ts.isMethodSignature(d) && ts.isIdentifier(d.name) && d.name.text === name
    && ts.isInterfaceDeclaration(d.parent) && program.isSourceFileDefaultLibrary(d.getSourceFile());
}

/** `from` of a built-in constructor (Array.from, a typed array's from): its second argument runs during the iteration. */
function isBuiltinFrom(program: ts.Program, d: ts.Node | undefined): boolean {
  return isLibMethod(program, d, "from") && (d.parent as ts.InterfaceDeclaration).name.text.endsWith("Constructor");
}

function unparenthesized(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/**
 * Every iteration over something that is not an array, with user code between its steps, in
 * `program`'s files under `only`: for...of, Array.from with a callback, a next() loop, yield*.
 */
export function iterationHazards(program: ts.Program, root: string, only: (file: string) => boolean): IterationHazard[] {
  const checker = program.getTypeChecker();
  const out: IterationHazard[] = [];
  const arrayLike = (e: ts.Expression): boolean => isArrayLike(checker, checker.getTypeAtLocation(e));
  const fromDeclared = (n: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean => {
    const at = ts.isPropertyAccessExpression(n) ? n.name : n.argumentExpression;
    const decls = checker.getSymbolAtLocation(at)?.declarations ?? [];
    return decls.some((d) => isBuiltinFrom(program, d));
  };
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !only(sf.fileName)) continue;
    const report = (node: ts.Node, kind: IterationHazard["kind"], e: ts.Expression) => {
      const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.push({ file: relative(root, sf.fileName), line: lc.line + 1, column: lc.character + 1, kind,
        expression: e.getText(sf), type: checker.typeToString(checker.getTypeAtLocation(e)) });
    };
    const visit = (n: ts.Node): void => {
      if (ts.isForOfStatement(n) && !arrayLike(n.expression)) {
        report(n, "for-of", n.expression);
      } else if (ts.isYieldExpression(n) && n.asteriskToken && n.expression && !arrayLike(n.expression)) {
        report(n, "yield-star", n.expression);
      } else if (ts.isCallExpression(n)) {
        // By the resolved signature: an alias of Array, Array["from"] and a destructured from resolve the same.
        const d = checker.getResolvedSignature(n)?.declaration;
        if (n.arguments.length >= 2 && isBuiltinFrom(program, d) && !arrayLike(n.arguments[0]!)) {
          report(n, "array-from-callback", n.arguments[0]!);
        } else if (isLibMethod(program, d, "next") && ts.isPropertyAccessExpression(n.expression)
            && !ts.isCallExpression(unparenthesized(n.expression.expression))) {
          report(n, "iterator-next", n.expression.expression);
        }
      } else if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))
          && !(ts.isCallExpression(n.parent) && unparenthesized(n.parent.expression) === n) && fromDeclared(n)) {
        report(n, "array-from-indirect", n);
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

const WHAT: Record<IterationHazard["kind"], string> = {
  "for-of": "for...of over",
  "array-from-callback": "Array.from with a callback over",
  "array-from-indirect": "a built-in from used other than by a direct call:",
  "iterator-next": "a hand-written next() loop over",
  "yield-star": "yield* over",
};

/** One line per hazard, for the build's error output. */
export function formatHazard(h: IterationHazard): string {
  return `${h.file}:${h.line}:${h.column}: ${WHAT[h.kind]} \`${h.expression}\` (${h.type})`;
}
