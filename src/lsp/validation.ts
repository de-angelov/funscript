import { pathToFileURL } from "node:url";
import {
  DiagnosticSeverity,
  type Diagnostic,
} from "vscode-languageserver/node";
import type { Span } from "../ast/types.js";
import {
  ImportedSchemaError,
  resolveImportedSchemas,
} from "../compiler/imported-schemas.js";
import { validateBooleanOperators } from "../compiler/boolean-operators.js";
import { validateNumericComparisons } from "../compiler/numeric-comparisons.js";
import { TypeScriptCompilationContext } from "../compiler/typescript-context.js";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";

export function toDiagnostic(error: unknown): Diagnostic {
  const err = error as { span?: Span; message?: string };
  const span: Span | undefined = err.span;
  let startLine = 0;
  let startChar = 0;
  let endLine = 0;
  let endChar = 0;

  if (span && span.start) {
    startLine = Math.max(0, span.start.line - 1);
    startChar = Math.max(0, span.start.column - 1);

    if (span.end) {
      endLine = Math.max(0, span.end.line - 1);
      endChar = Math.max(0, span.end.column - 1);
    } else {
      endLine = startLine;
      endChar = startChar + 1;
    }

    if (
      endLine < startLine ||
      (endLine === startLine && endChar <= startChar)
    ) {
      endLine = startLine;
      endChar = startChar + 1;
    }
  } else {
    startLine = 0;
    startChar = 0;
    endLine = 0;
    endChar = 1;
  }

  let rawMessage =
    typeof err.message === "string" ? err.message : String(error);
  rawMessage = rawMessage.replace(/\s+at line \d+, col \d+$/, "");

  const errorCode =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;

  return {
    range: {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar },
    },
    severity: DiagnosticSeverity.Error,
    source: "funscript",
    code:
      (errorCode as number | string | undefined) ??
      ((error as { constructor?: { name?: string } })?.constructor?.name ===
      "LexerError"
        ? "FS_LEXER"
        : "FS_SYNTAX"),
    message: rawMessage,
    ...(error instanceof ImportedSchemaError && error.related
      ? {
          relatedInformation: [
            {
              location: {
                uri: pathToFileURL(error.related.file).href,
                range: {
                  start: {
                    line: error.related.line,
                    character: error.related.column,
                  },
                  end: {
                    line: error.related.endLine,
                    character: error.related.endColumn,
                  },
                },
              },
              message: "Unsupported TypeScript field declared here.",
            },
          ],
        }
      : {}),
    data: {
      primaryMessage: rawMessage,
      explanation:
        error instanceof ImportedSchemaError
          ? error.explanation
          : "The FunScript source could not be parsed.",
      suggestedAction:
        error instanceof ImportedSchemaError
          ? error.suggestedAction
          : "Fix the highlighted syntax and validate the file again.",
    },
  };
}

export function validateSyntax(
  source: string,
  uri: string,
): { diagnostics: Diagnostic[]; ast?: import("../ast/types.js").Program } {
  const diagnostics: Diagnostic[] = [];
  try {
    const lexer = new Lexer(source, uri);
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens, uri, source);
    const ast = parser.parse({ throwOnError: false });
    // Recovery can produce cascading errors inside a single malformed block.
    const firstDiagnostic = parser.getDiagnostics()[0];
    if (firstDiagnostic) diagnostics.push(toDiagnostic(firstDiagnostic));
    return { diagnostics, ast };
  } catch (error: unknown) {
    diagnostics.push(toDiagnostic(error));
    return { diagnostics };
  }
}

export function validateFunScript(
  source: string,
  uri: string = "<anonymous>",
): Diagnostic[] {
  const { diagnostics, ast } = validateSyntax(source, uri);
  if (!diagnostics.length && ast) {
    try {
      const context = new TypeScriptCompilationContext(uri);
      if (!ast.body.some((decl) => decl.kind === "AsDeclaration"))
        validateNumericComparisons(ast, source, context);
      validateBooleanOperators(ast, source, context);
      resolveImportedSchemas(ast, context);
    } catch (error: unknown) {
      diagnostics.push(toDiagnostic(error));
    }
  }
  return diagnostics;
}
