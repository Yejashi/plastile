// Static check of the bundle for what KWin's QV4 reports as qt.qml.usedbeforedeclared.
//
// QV4's code generator warns, once per reference, when a name resolves to a variable (var,
// let, const, or a class bound to one) whose declaration starts *after* the reference in the
// source text, wherever the reference is, including inside a function that only runs later
// (Qt 6 qv4codegen.cpp Codegen::referenceForName → reportVarUsedBeforeDeclaration). Function
// declarations are exempt (hoisted; QV4 logs nothing for them). The first physical session
// (KWin 6.7.5, Qt 6.12.0) logged five such warnings at load, for module-level constants that
// a function above them used; this check found exactly those five in that bundle.
//
// The names are resolved with TypeScript's binder (lexical scopes, shadowing, hoisting), not
// by text matching. Property names, declaration names and labels are not references.

import ts from "typescript";

export interface UsedBeforeDeclaration {
  readonly name: string;
  /** 1-based line and column of the reference and of the declaration. */
  readonly ref: { line: number; column: number };
  readonly decl: { line: number; column: number };
}

function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessorDeclaration(p)
       || ts.isSetAccessorDeclaration(p)) && p.name === id) return false;
  if ((ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p)
       || ts.isClassExpression(p) || ts.isParameter(p)) && p.name === id) return false;
  if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return false;
  if ((ts.isLabeledStatement(p) || ts.isBreakStatement(p) || ts.isContinueStatement(p)) && p.label === id) return false;
  if (ts.isExportSpecifier(p) || ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return false;
  return true;
}

/** Variable declarations (and class declarations) referenced above where they are declared. */
export function usedBeforeDeclaration(code: string, fileName = "bundle.mjs"): UsedBeforeDeclaration[] {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
  const host: ts.CompilerHost = {
    getSourceFile: (n) => (n === fileName ? sf : undefined),
    writeFile: () => {},
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => "",
    getNewLine: () => "\n",
    fileExists: (n) => n === fileName,
    readFile: () => undefined,
  };
  const program = ts.createProgram([fileName], { allowJs: true, noLib: true, noResolve: true, types: [] }, host);
  const checker = program.getTypeChecker();
  const out: UsedBeforeDeclaration[] = [];
  const pos = (n: number) => {
    const lc = sf.getLineAndCharacterOfPosition(n);
    return { line: lc.line + 1, column: lc.character + 1 };
  };
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && isReference(n)) {
      const sym = ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n
        ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n);
      const d = sym?.declarations?.[0];
      if (d && (ts.isVariableDeclaration(d) || ts.isClassDeclaration(d)) && d.getSourceFile() === sf && d.name
          && d.name.getStart(sf) >= n.getEnd()) {
        out.push({ name: n.text, ref: pos(n.getStart(sf)), decl: pos(d.name.getStart(sf)) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
