import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Lexer } from "../lexer/lexer.js";
import { Parser, ParseError } from "../parser/parser.js";
import type {
  Span,
  Program,
  TopLevelDeclaration,
  Statement,
  Expression,
  FunctionExpression,
  BlockStatement,
  EffectBlockExpression,
  BindingDeclaration,
  WhenStatement,
  JSXChild,
} from "../ast/types.js";

export type MigrationDiagnosticKind =
  | "ambiguous-effect-return"
  | "ambiguous-trailing-binding"
  | "ambiguous-empty-block"
  | "ambiguous-missing-return"
  | "parse-error"
  | "lexer-error";

export type MigrationDiagnosticSeverity = "error" | "warning" | "info";

export interface MigrationDiagnostic {
  kind: MigrationDiagnosticKind;
  severity: MigrationDiagnosticSeverity;
  message: string;
  span?: Span;
  filename?: string;
}

export interface MigrationChange {
  kind: "explicit-return";
  span: Span;
  original: string;
  replacement: string;
  description: string;
  offset: number;
}

export interface MigrateOptions {
  filename?: string;
  /** If true, returns proposed changes and diagnostics without modifying code. Default false */
  dryRun?: boolean;
  /** If false, does not apply any edits if any ambiguous constructs are detected. Default true */
  allowPartial?: boolean;
  /** If true, also migrates trailing match expressions to explicit '=> match'. Default false */
  migrateTrailingMatch?: boolean;
}

export interface MigrationResult {
  /** The resulting source code (transformed if changes were applied, or original) */
  code: string;
  /** True if any transformations were applied to the code */
  changed: boolean;
  /** List of changes applied (or proposed if dryRun: true) */
  changes: MigrationChange[];
  /** List of ambiguous constructs or errors reported */
  diagnostics: MigrationDiagnostic[];
  /** True if migration succeeded with zero fatal errors */
  success: boolean;
}

/**
 * Parses source code, identifies legacy syntax patterns (e.g. block functions
 * without explicit => returns), applies safe transformations, and reports
 * ambiguous constructs without modifying them.
 */
export function migrateSource(source: string, options: MigrateOptions = {}): MigrationResult {
  const filename = options.filename ?? "<anonymous>";
  const allowPartial = options.allowPartial ?? true;
  const dryRun = options.dryRun ?? false;

  const diagnostics: MigrationDiagnostic[] = [];
  const changes: MigrationChange[] = [];

  // Step 1: Tokenize
  const lexer = new Lexer(source, filename);
  let tokens;
  try {
    tokens = lexer.tokenize();
  } catch (err: any) {
    return {
      code: source,
      changed: false,
      changes: [],
      diagnostics: [
        {
          kind: "lexer-error",
          severity: "error",
          message: err.message,
          span: err.span,
          filename,
        },
      ],
      success: false,
    };
  }

  // Step 2: Parse allowing legacy return patterns
  const parser = new Parser(tokens, filename, source, { allowLegacyReturns: true, throwOnError: false });
  let ast: Program;
  try {
    ast = parser.parse({ allowLegacyReturns: true, throwOnError: false });
  } catch (err: any) {
    return {
      code: source,
      changed: false,
      changes: [],
      diagnostics: [
        {
          kind: "parse-error",
          severity: "error",
          message: err.message,
          span: err.span,
          filename,
        },
      ],
      success: false,
    };
  }

  // Check for fatal parser diagnostics (other than legacy returns)
  const parseErrors = parser.getDiagnostics();
  if (parseErrors.length > 0) {
    for (const err of parseErrors) {
      diagnostics.push({
        kind: "parse-error",
        severity: "error",
        message: err.message,
        span: err.span,
        filename,
      });
    }
    return {
      code: source,
      changed: false,
      changes: [],
      diagnostics,
      success: false,
    };
  }

  // Step 3: Traverse AST to identify candidates and ambiguous constructs
  traverseAST(ast, source, options, changes, diagnostics, filename);

  // If allowPartial is false and there are ambiguous constructs, do not modify
  const hasAmbiguous = diagnostics.some((d) => d.kind.startsWith("ambiguous"));
  if (!allowPartial && hasAmbiguous) {
    return {
      code: source,
      changed: false,
      changes: dryRun ? changes : [],
      diagnostics,
      success: false,
    };
  }

  // If dry-run mode, return proposed changes without modifying code
  if (dryRun) {
    return {
      code: source,
      changed: changes.length > 0,
      changes,
      diagnostics,
      success: true,
    };
  }

  // Step 4: Apply safe text edits in reverse offset order
  if (changes.length === 0) {
    return {
      code: source,
      changed: false,
      changes: [],
      diagnostics,
      success: true,
    };
  }

  // Deduplicate and sort changes descending by offset
  const seenOffsets = new Set<number>();
  const uniqueChanges = changes.filter((c) => {
    if (seenOffsets.has(c.offset)) return false;
    seenOffsets.add(c.offset);
    return true;
  });
  uniqueChanges.sort((a, b) => b.offset - a.offset);

  let newCode = source;
  for (const change of uniqueChanges) {
    const before = newCode.slice(0, change.offset);
    const after = newCode.slice(change.offset);
    newCode = before + "=> " + after;
  }

  // Step 5: Verify transformed syntax. Ambiguous legacy blocks are deliberately
  // left untouched, so validate those files in legacy mode while strict-parsing
  // fully migrated files.
  try {
    const verifyLexer = new Lexer(newCode, filename);
    const verifyTokens = verifyLexer.tokenize();
    const hasAmbiguous = diagnostics.some((d) => d.kind.startsWith("ambiguous"));
    const verifyParser = new Parser(verifyTokens, filename, newCode, {
      allowLegacyReturns: hasAmbiguous,
      throwOnError: true,
    });
    verifyParser.parse({ allowLegacyReturns: hasAmbiguous, throwOnError: true });
  } catch (err: any) {
    return {
      code: source,
      changed: false,
      changes: [],
      diagnostics: [
        ...diagnostics,
        {
          kind: "parse-error",
          severity: "error",
          message: `Migration verification failed: ${err.message}`,
          span: err.span,
          filename,
        },
      ],
      success: false,
    };
  }

  return {
    code: newCode,
    changed: true,
    changes: uniqueChanges,
    diagnostics,
    success: true,
  };
}

/**
 * Migrates a file on disk.
 */
export async function migrateFile(
  filePath: string,
  options: MigrateOptions & { write?: boolean } = {},
): Promise<MigrationResult> {
  const fullPath = path.resolve(filePath);
  const source = await fs.readFile(fullPath, "utf-8");
  const result = migrateSource(source, { ...options, filename: fullPath });
  if (options.write && result.changed && result.success) {
    await fs.writeFile(fullPath, result.code, "utf-8");
  }
  return result;
}

/**
 * Migrates multiple files on disk.
 */
export async function migrateFiles(
  filePaths: string[],
  options: MigrateOptions & { write?: boolean } = {},
): Promise<Map<string, MigrationResult>> {
  const results = new Map<string, MigrationResult>();
  for (const filePath of filePaths) {
    const result = await migrateFile(filePath, options);
    results.set(filePath, result);
  }
  return results;
}

/**
 * Formats a human-readable migration summary report.
 */
export function formatMigrationReport(result: MigrationResult): string {
  const lines: string[] = [];
  if (result.changed) {
    lines.push(`Applied ${result.changes.length} safe transformation(s):`);
    for (const change of result.changes) {
      lines.push(`  - ${change.description}`);
    }
  } else {
    lines.push("No code transformations applied.");
  }

  if (result.diagnostics.length > 0) {
    lines.push(`\nReported ${result.diagnostics.length} diagnostic(s) / ambiguous construct(s):`);
    for (const diag of result.diagnostics) {
      const loc = diag.span
        ? `[line ${diag.span.start.line}, col ${diag.span.start.column}]`
        : "";
      lines.push(`  - [${diag.severity.toUpperCase()}] ${diag.kind} ${loc}: ${diag.message}`);
    }
  }

  return lines.join("\n");
}

// --- AST Traversal & Analysis ---

function traverseAST(
  ast: Program,
  source: string,
  options: MigrateOptions,
  changes: MigrationChange[],
  diagnostics: MigrationDiagnostic[],
  filename: string,
): void {
  for (const decl of ast.body) {
    visitTopLevelDeclaration(decl, source, options, changes, diagnostics, filename);
  }
}

function visitTopLevelDeclaration(
  decl: TopLevelDeclaration,
  source: string,
  options: MigrateOptions,
  changes: MigrationChange[],
  diagnostics: MigrationDiagnostic[],
  filename: string,
): void {
  switch (decl.kind) {
    case "ExportDeclaration":
      if (decl.declaration) {
        visitTopLevelDeclaration(decl.declaration, source, options, changes, diagnostics, filename);
      }
      break;
    case "BindingDeclaration":
      if (decl.init) {
        visitExpression(decl.init, source, options, changes, diagnostics, filename);
      }
      break;
    case "WhenStatement":
      visitWhenStatement(decl, source, options, changes, diagnostics, filename);
      break;
    case "ServiceDeclaration":
    case "ExternServiceDeclaration":
      // Service members declare signatures only
      break;
    case "SchemaDeclaration":
      if (decl.body?.kind === "RecordSchema") {
        for (const field of decl.body.fields) {
          if (field.defaultValue) {
            visitExpression(field.defaultValue, source, options, changes, diagnostics, filename);
          }
        }
      } else if (decl.body?.kind === "RefinementSchema") {
        if (decl.body.refinement) {
          visitExpression(decl.body.refinement, source, options, changes, diagnostics, filename);
        }
      }
      break;
    default:
      break;
  }
}

function visitExpression(
  expr: Expression,
  source: string,
  options: MigrateOptions,
  changes: MigrationChange[],
  diagnostics: MigrationDiagnostic[],
  filename: string,
): void {
  if (!expr) return;

  switch (expr.kind) {
    case "FunctionExpression":
      // Empty braces in a function body are parsed as an empty record by the
      // language parser, while legacy function-block syntax used the same text.
      // Keep this ambiguous form unchanged instead of treating it as a value.
      if (
        expr.body.kind === "RecordExpression" &&
        expr.body.entries.length === 0 &&
        source.slice(expr.body.span.start.offset, expr.body.span.end.offset).trim() === "{}"
      ) {
        diagnostics.push({
          kind: "ambiguous-empty-block",
          severity: "warning",
          message: "Empty braces in a function body are ambiguous; cannot infer whether this is an empty block or an empty record.",
          span: expr.body.span,
          filename,
        });
        break;
      }
      handleFunctionExpression(expr, source, options, changes, diagnostics, filename);
      break;

    case "EffectBlockExpression":
      handleEffectBlockExpression(expr, source, options, changes, diagnostics, filename);
      break;

    case "MutBlockExpression":
      // mut (draft) => { ... } modifies draft and does not return explicit values
      if (expr.body?.kind === "BlockStatement") {
        for (const stmt of expr.body.statements) {
          visitStatement(stmt, source, options, changes, diagnostics, filename);
        }
      } else if (expr.body) {
        visitExpression(expr.body, source, options, changes, diagnostics, filename);
      }
      break;

    case "MatchExpression":
      if (expr.scrutinee) {
        visitExpression(expr.scrutinee, source, options, changes, diagnostics, filename);
      }
      for (const arm of expr.arms) {
        if (arm.guard) {
          visitExpression(arm.guard, source, options, changes, diagnostics, filename);
        }
        if (arm.body?.kind === "BlockStatement") {
          for (const stmt of arm.body.statements) {
            visitStatement(stmt, source, options, changes, diagnostics, filename);
          }
          if (arm.body.finalExpression) {
            visitExpression(arm.body.finalExpression, source, options, changes, diagnostics, filename);
          }
        } else if (arm.body) {
          visitExpression(arm.body, source, options, changes, diagnostics, filename);
        }
      }
      break;

    case "PipelineExpression":
      visitExpression(expr.left, source, options, changes, diagnostics, filename);
      visitExpression(expr.right, source, options, changes, diagnostics, filename);
      break;

    case "BinaryExpression":
      visitExpression(expr.left, source, options, changes, diagnostics, filename);
      visitExpression(expr.right, source, options, changes, diagnostics, filename);
      break;

    case "UnaryExpression":
      visitExpression(expr.argument, source, options, changes, diagnostics, filename);
      break;

    case "CallExpression":
      visitExpression(expr.callee, source, options, changes, diagnostics, filename);
      for (const arg of expr.args) {
        visitExpression(arg, source, options, changes, diagnostics, filename);
      }
      break;

    case "MemberExpression":
      visitExpression(expr.object, source, options, changes, diagnostics, filename);
      break;

    case "IndexExpression":
      visitExpression(expr.object, source, options, changes, diagnostics, filename);
      visitExpression(expr.index, source, options, changes, diagnostics, filename);
      break;

    case "ArrayExpression":
      for (const elem of expr.elements) {
        visitExpression(elem, source, options, changes, diagnostics, filename);
      }
      break;

    case "RecordExpression":
      for (const entry of expr.entries) {
        if ("value" in entry && entry.value) {
          visitExpression(entry.value, source, options, changes, diagnostics, filename);
        } else if (entry.kind === "SpreadEntry" && entry.argument) {
          visitExpression(entry.argument, source, options, changes, diagnostics, filename);
        }
      }
      break;

    case "JSXElement":
      for (const child of expr.children) {
        visitJSXChild(child, source, options, changes, diagnostics, filename);
      }
      for (const attr of expr.openingElement.attributes) {
        if (attr.value && "expression" in attr.value && attr.value.expression) {
          visitExpression(attr.value.expression, source, options, changes, diagnostics, filename);
        }
      }
      break;

    case "JSXSelfClosingElement":
      for (const attr of expr.attributes) {
        if (attr.value && "expression" in attr.value && attr.value.expression) {
          visitExpression(attr.value.expression, source, options, changes, diagnostics, filename);
        }
      }
      break;

    case "StringLiteral":
      for (const part of expr.parts) {
        if (part.kind === "StringInterpolationPart" && part.expression) {
          visitExpression(part.expression, source, options, changes, diagnostics, filename);
        }
      }
      break;

    case "JsExpression":
      if (expr.expression) {
        visitExpression(expr.expression, source, options, changes, diagnostics, filename);
      }
      break;

    default:
      break;
  }
}

function visitJSXChild(
  child: JSXChild,
  source: string,
  options: MigrateOptions,
  changes: MigrationChange[],
  diagnostics: MigrationDiagnostic[],
  filename: string,
): void {
  if (child.kind === "JSXExpressionContainer" && child.expression) {
    visitExpression(child.expression, source, options, changes, diagnostics, filename);
  } else if (child.kind === "JSXElement") {
    visitExpression(child, source, options, changes, diagnostics, filename);
  } else if (child.kind === "JSXSelfClosingElement") {
    visitExpression(child, source, options, changes, diagnostics, filename);
  }
}

function handleFunctionExpression(
  fn: FunctionExpression,
  source: string,
  options: MigrateOptions,
  changes: MigrationChange[],
  diagnostics: MigrationDiagnostic[],
  filename: string,
): void {
  if (fn.body.kind !== "BlockStatement") {
    // Concise expression body (e.g. (a, b) => a + b) - already compliant
    visitExpression(fn.body, source, options, changes, diagnostics, filename);
    return;
  }

  const block = fn.body;

  // The legacy parser represents an empty indented block with a synthetic
  // `_error` final expression; it is not source text and cannot be migrated.
  if (block.statements.length === 0 && block.finalExpression?.kind === "Identifier" && block.finalExpression.name === "_error") {
    diagnostics.push({
      kind: "ambiguous-empty-block",
      severity: "warning",
      message: "Function block is empty; cannot infer explicit return value.",
      span: block.span,
      filename,
    });
    return;
  }

  // Visit inner statements and nested expressions
  for (const stmt of block.statements) {
    visitStatement(stmt, source, options, changes, diagnostics, filename);
  }
  if (block.finalExpression) {
    visitExpression(block.finalExpression, source, options, changes, diagnostics, filename);
  }

  // Check function block termination
  const lastStmt = block.statements.at(-1);

  // 1. Compliant: Ends in an explicit ReturnStatement (=> returnValue)
  if (lastStmt?.kind === "ReturnStatement") {
    return;
  }

  // 2. Ambiguous: Trailing binding declaration
  const isTrailingBinding =
    (lastStmt as any)?.isTrailingBinding ||
    (!block.finalExpression && lastStmt?.kind === "BindingDeclaration") ||
    (block.finalExpression &&
      lastStmt?.kind === "BindingDeclaration" &&
      lastStmt.id === block.finalExpression);

  if (isTrailingBinding) {
    const bind = lastStmt as BindingDeclaration;
    diagnostics.push({
      kind: "ambiguous-trailing-binding",
      severity: "warning",
      message: `Function block ends with variable declaration '${bind.id?.name ?? ""}'. Safe automated migration cannot assume this was intended as the return value.`,
      span: bind.span,
      filename,
    });
    return;
  }

  // 3. Ambiguous: Empty block or statement-only block without return
  if (!block.finalExpression) {
    if (block.statements.length === 0) {
      diagnostics.push({
        kind: "ambiguous-empty-block",
        severity: "warning",
        message: "Function block is empty; cannot infer explicit return value.",
        span: block.span,
        filename,
      });
    } else {
      diagnostics.push({
        kind: "ambiguous-missing-return",
        severity: "warning",
        message: "Function block does not end with an expression; cannot infer explicit return value.",
        span: block.span,
        filename,
      });
    }
    return;
  }

  // 4. Trailing MatchExpression
  if (block.finalExpression.kind === "MatchExpression") {
    if (options.migrateTrailingMatch) {
      addExplicitReturnChange(block.finalExpression, source, changes);
    }
    // Otherwise compliant under current parser exemption
    return;
  }

  // 5. Trailing EffectBlockExpression
  if (block.finalExpression.kind === "EffectBlockExpression") {
    // Compliant at function block level; the effect block itself is validated separately
    return;
  }

  // 6. Safe candidate: legacy bare expression at the end of function block!
  addExplicitReturnChange(block.finalExpression, source, changes);
}

function handleEffectBlockExpression(
  expr: EffectBlockExpression,
  source: string,
  options: MigrateOptions,
  changes: MigrationChange[],
  diagnostics: MigrationDiagnostic[],
  filename: string,
): void {
  // Check if this effect block ended with an ambiguous bare return
  if (
    (expr.finalExpression as any)?.isLegacyBareEffectReturn ||
    (expr.finalExpression as any)?.isMissingEffectReturn ||
    (expr.body as any)?.isMissingFinalExpression
  ) {
    diagnostics.push({
      kind: "ambiguous-effect-return",
      severity: "warning",
      message:
        "Effect block ends with a bare expression without explicit '=>' return or '<-' bind. Safe migration cannot determine whether the effect should be yielded or returned as a value.",
      span: expr.finalExpression?.span ?? expr.span,
      filename,
    });
  }

  // Visit effect statements
  for (const stmt of expr.body) {
    if ("effect" in stmt && stmt.effect) {
      visitExpression(stmt.effect, source, options, changes, diagnostics, filename);
    }
    if ("init" in stmt && stmt.init) {
      visitExpression(stmt.init, source, options, changes, diagnostics, filename);
    }
    if ("value" in stmt && stmt.value) {
      visitExpression(stmt.value, source, options, changes, diagnostics, filename);
    }
    if ("condition" in stmt && stmt.condition) {
      visitExpression(stmt.condition, source, options, changes, diagnostics, filename);
    }
  }

  if (expr.finalExpression && !(expr.finalExpression as any)?.isMissingEffectReturn) {
    visitExpression(expr.finalExpression, source, options, changes, diagnostics, filename);
  }
}

function visitStatement(
  stmt: Statement,
  source: string,
  options: MigrateOptions,
  changes: MigrationChange[],
  diagnostics: MigrationDiagnostic[],
  filename: string,
): void {
  switch (stmt.kind) {
    case "BindingDeclaration":
      if (stmt.init) {
        visitExpression(stmt.init, source, options, changes, diagnostics, filename);
      }
      break;
    case "AssignmentStatement":
      if (stmt.value) {
        visitExpression(stmt.value, source, options, changes, diagnostics, filename);
      }
      break;
    case "ExpressionStatement":
      if (stmt.expression) {
        visitExpression(stmt.expression, source, options, changes, diagnostics, filename);
      }
      break;
    case "ReturnStatement":
      if (stmt.argument) {
        visitExpression(stmt.argument, source, options, changes, diagnostics, filename);
      }
      break;
    case "WhenStatement":
      visitWhenStatement(stmt, source, options, changes, diagnostics, filename);
      break;
    default:
      break;
  }
}

function visitWhenStatement(
  when: WhenStatement,
  source: string,
  options: MigrateOptions,
  changes: MigrationChange[],
  diagnostics: MigrationDiagnostic[],
  filename: string,
): void {
  if (when.condition) {
    visitExpression(when.condition, source, options, changes, diagnostics, filename);
  }
  if (when.consequent) {
    if (when.consequent.kind === "BlockStatement") {
      // when blocks do not use explicit returns
      for (const stmt of when.consequent.statements) {
        visitStatement(stmt, source, options, changes, diagnostics, filename);
      }
      if (when.consequent.finalExpression) {
        visitExpression(when.consequent.finalExpression, source, options, changes, diagnostics, filename);
      }
    } else {
      visitExpression(when.consequent, source, options, changes, diagnostics, filename);
    }
  }
}

function addExplicitReturnChange(
  expr: Expression,
  source: string,
  changes: MigrationChange[],
): void {
  const startOffset = expr.span.start.offset;
  const endOffset = expr.span.end.offset;
  const original = source.slice(startOffset, endOffset);

  // Safety check: ensure not already preceded by '=>'
  const prefixSlice = source.slice(Math.max(0, startOffset - 4), startOffset);
  if (prefixSlice.includes("=>")) {
    return;
  }

  changes.push({
    kind: "explicit-return",
    span: expr.span,
    original,
    replacement: `=> ${original}`,
    description: `Add explicit '=>' return before expression at line ${expr.span.start.line}, col ${expr.span.start.column}`,
    offset: startOffset,
  });
}
