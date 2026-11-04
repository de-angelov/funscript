import ts from "typescript";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import type { Program, TopLevelDeclaration, Expression } from "../ast/types.js";

export type IdiomaticViolationKind =
  | "non-ambient-function-declaration"
  | "non-ambient-function-definition"
  | "non-ambient-variable-declaration"
  | "import-inside-ts-block"
  | "non-ambient-statement"
  | "non-ambient-expression";

export interface IdiomaticDiagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  kind: IdiomaticViolationKind;
  snippet?: string;
}

export interface IdiomaticAuditResult {
  file: string;
  success: boolean;
  diagnostics: IdiomaticDiagnostic[];
}

/** Known ambient third-party runtime polyfill identifiers allowed in ts { ... } blocks. */
const ALLOWED_POLYFILL_IDENTIFIERS = new Set(["React"]);

function isAmbientStatement(stmt: ts.Statement): boolean {
  if (ts.isTypeAliasDeclaration(stmt)) return true;
  if (ts.isInterfaceDeclaration(stmt)) return true;
  if (ts.isModuleDeclaration(stmt)) return true;
  const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
  if (modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return true;
  return false;
}

function checkTsBlockCode(
  code: string,
  baseLine: number,
  baseCol: number,
  filePath: string,
): IdiomaticDiagnostic[] {
  const diagnostics: IdiomaticDiagnostic[] = [];
  const sourceFile = ts.createSourceFile("inline.ts", code, ts.ScriptTarget.Latest, true);

  for (const stmt of sourceFile.statements) {
    if (isAmbientStatement(stmt)) {
      continue;
    }

    const { line: relLine, character: relCol } = sourceFile.getLineAndCharacterOfPosition(
      stmt.getStart(sourceFile),
    );
    const line = baseLine + relLine;
    const column = relLine === 0 ? baseCol + relCol : relCol + 1;
    const snippet = stmt.getText(sourceFile).split("\n")[0]?.trim();

    if (ts.isImportDeclaration(stmt)) {
      diagnostics.push({
        file: filePath,
        line,
        column,
        kind: "import-inside-ts-block",
        message:
          "Import declaration inside 'ts { }' block is forbidden. Use native FunScript imports at module scope.",
        snippet,
      });
      continue;
    }

    if (ts.isFunctionDeclaration(stmt)) {
      const name = stmt.name?.text ?? "anonymous";
      diagnostics.push({
        file: filePath,
        line,
        column,
        kind: "non-ambient-function-declaration",
        message: `Top-level function declaration '${name}' inside 'ts { }' block is forbidden. Replace with native FunScript functions.`,
        snippet,
      });
      continue;
    }

    if (ts.isVariableStatement(stmt)) {
      let isAllowedPolyfill = true;
      for (const decl of stmt.declarationList.declarations) {
        const name = decl.name.getText(sourceFile);
        if (ALLOWED_POLYFILL_IDENTIFIERS.has(name)) {
          continue;
        }
        isAllowedPolyfill = false;
        const isFn =
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));

        if (isFn) {
          diagnostics.push({
            file: filePath,
            line,
            column,
            kind: "non-ambient-function-definition",
            message: `Function definition '${name}' inside 'ts { }' block is forbidden. Replace with native FunScript functions.`,
            snippet,
          });
        } else {
          diagnostics.push({
            file: filePath,
            line,
            column,
            kind: "non-ambient-variable-declaration",
            message: `Variable declaration '${name}' inside 'ts { }' block is forbidden. Use 'declare' for ambient values or define natively in FunScript.`,
            snippet,
          });
        }
      }
      if (isAllowedPolyfill) {
        continue;
      }
      continue;
    }

    diagnostics.push({
      file: filePath,
      line,
      column,
      kind: "non-ambient-statement",
      message: `Non-ambient statement (${ts.SyntaxKind[stmt.kind]}) inside 'ts { }' block is forbidden. Restrict 'ts { }' to ambient type declarations.`,
      snippet,
    });
  }

  return diagnostics;
}

function traverseAst(node: any, visit: (n: any) => void) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "span") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) traverseAst(c, visit);
    } else if (child && typeof child === "object") {
      traverseAst(child, visit);
    }
  }
}

/**
 * Audits a single FunScript source string for unjustified / non-ambient 'ts { ... }' blocks.
 */
export function auditIdiomaticFunScript(source: string, filePath = "<source>"): IdiomaticAuditResult {
  const diagnostics: IdiomaticDiagnostic[] = [];

  let program: Program;
  try {
    const lexer = new Lexer(source);
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens);
    program = parser.parse();
  } catch {
    // If syntax parsing fails, let the compiler/checker report syntax errors
    return { file: filePath, success: true, diagnostics: [] };
  }

  traverseAst(program, (node) => {
    if (node.kind === "TsEscapeDeclaration") {
      const baseLine = node.span.start.line;
      const baseCol = node.span.start.column;
      const diags = checkTsBlockCode(node.code, baseLine, baseCol, filePath);
      diagnostics.push(...diags);
    } else if (node.kind === "TsEscapeExpression") {
      // Check if expression defines a function inside ts { ... }
      const code = node.code.trim();
      if (code.includes("=>") || code.startsWith("function")) {
        diagnostics.push({
          file: filePath,
          line: node.span.start.line,
          column: node.span.start.column,
          kind: "non-ambient-expression",
          message:
            "Function expression inside 'ts { }' escape is forbidden. Use native FunScript functions.",
          snippet: code.split("\n")[0]?.trim(),
        });
      }
    }
  });

  return {
    file: filePath,
    success: diagnostics.length === 0,
    diagnostics,
  };
}
