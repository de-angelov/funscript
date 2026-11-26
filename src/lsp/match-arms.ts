import {
  type CodeAction,
  CodeActionKind,
  type Range,
} from "vscode-languageserver/node";
import type {
  BindingDeclaration,
  FunctionExpression,
  MatchExpression,
  Pattern,
  Program,
  TypeNode,
} from "../ast/types.js";
import { isExpectedSyntaxError } from "../errors.js";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";

interface VariantInfo {
  name: string;
  fields: string[];
}

const BUILTIN_SCHEMAS = new Map<string, VariantInfo[]>([
  [
    "Option",
    [
      { name: "Some", fields: ["value"] },
      { name: "None", fields: [] },
    ],
  ],
  [
    "Result",
    [
      { name: "Ok", fields: ["value"] },
      { name: "Error", fields: ["error"] },
    ],
  ],
  [
    "Either",
    [
      { name: "Right", fields: ["right"] },
      { name: "Left", fields: ["left"] },
    ],
  ],
]);

function getTypeName(typeNode: TypeNode | undefined): string | undefined {
  if (!typeNode || !("name" in typeNode)) return undefined;
  const nameNode = typeNode.name;
  if (
    nameNode &&
    typeof nameNode === "object" &&
    "name" in nameNode &&
    typeof nameNode.name === "string"
  ) {
    return nameNode.name;
  }
  return undefined;
}

function extractPatternNames(pattern: Pattern): string[] {
  if (pattern.kind === "ConstructorPattern") {
    return [pattern.constructorName.name];
  }
  if (pattern.kind === "VariablePattern") {
    return [pattern.name.name];
  }
  if (pattern.kind === "OrPattern") {
    return pattern.patterns.flatMap(extractPatternNames);
  }
  return [];
}

export function findFillMatchArmsCodeActions(
  source: string,
  uri: string,
  range: Range,
): CodeAction[] {
  if (!source || !source.includes("match")) return [];

  let program: Program;
  try {
    const lexer = new Lexer(source, uri);
    const tokens = lexer.tokenize();
    program = new Parser(tokens, uri, source).parse();
  } catch (error) {
    if (!isExpectedSyntaxError(error)) throw error;
    return [];
  }

  // 1. Collect all declared tagged union schemas in the module
  const schemas = new Map<string, VariantInfo[]>(BUILTIN_SCHEMAS);
  const variantToSchema = new Map<string, string>();

  // Register built-in variants
  for (const [schemaName, variants] of BUILTIN_SCHEMAS.entries()) {
    for (const v of variants) {
      variantToSchema.set(v.name, schemaName);
    }
  }

  // Register local schemas
  for (const entry of program.body) {
    const decl = entry.kind === "ExportDeclaration" ? entry.declaration : entry;
    if (
      decl.kind === "SchemaDeclaration" &&
      decl.body.kind === "TaggedUnionSchema"
    ) {
      const variants: VariantInfo[] = decl.body.variants.map((v) => ({
        name: v.name.name,
        fields: v.fields.map((f) => f.name.name),
      }));
      schemas.set(decl.id.name, variants);
      for (const v of variants) {
        variantToSchema.set(v.name, decl.id.name);
      }
    }
  }

  // 2. Find MatchExpressions in the AST
  const matchExprs: MatchExpression[] = [];
  const functionParams = new Map<string, string>(); // paramName -> typeName

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const n = node as Record<string, unknown>;

    if (n.kind === "FunctionExpression") {
      const fn = node as FunctionExpression;
      for (const p of fn.params) {
        if (p.name.kind === "Identifier" && p.typeAnnotation) {
          const pType = getTypeName(p.typeAnnotation);
          if (pType) {
            functionParams.set(p.name.name, pType);
          }
        }
      }
    }

    if (n.kind === "BindingDeclaration") {
      const b = node as BindingDeclaration;
      if (b.id.kind === "Identifier" && b.typeAnnotation) {
        const tName = getTypeName(b.typeAnnotation);
        if (tName) {
          functionParams.set(b.id.name, tName);
        }
      }
    }

    if (n.kind === "MatchExpression" && !n.isCatch) {
      matchExprs.push(node as MatchExpression);
    }

    for (const key of Object.keys(n)) {
      if (key === "span") continue;
      visit(n[key]);
    }
  };

  visit(program);

  const lines = source.split("\n");
  const actions: CodeAction[] = [];

  for (const matchExpr of matchExprs) {
    const mStartLine = matchExpr.span.start.line - 1;
    const mEndLine = matchExpr.span.end.line - 1;

    // Check if requested range overlaps with this match expression
    if (range.start.line > mEndLine || range.end.line < mStartLine) {
      continue;
    }

    // Check if wildcard arm is already present
    const hasWildcard = matchExpr.arms.some(
      (arm) => arm.pattern.kind === "WildcardPattern",
    );
    if (hasWildcard) continue;

    // Collect variants already handled
    const handledVariants = new Set<string>();
    for (const arm of matchExpr.arms) {
      for (const name of extractPatternNames(arm.pattern)) {
        handledVariants.add(name);
      }
    }

    // Determine target schema
    let targetSchema: string | undefined;

    // A. Check from existing variant patterns
    for (const vName of handledVariants) {
      if (variantToSchema.has(vName)) {
        targetSchema = variantToSchema.get(vName);
        break;
      }
    }

    // B. Check from scrutinee type
    if (!targetSchema && matchExpr.scrutinee) {
      if (matchExpr.scrutinee.kind === "Identifier") {
        const varName = matchExpr.scrutinee.name;
        if (functionParams.has(varName)) {
          targetSchema = functionParams.get(varName);
        }
      }
    }

    if (!targetSchema || !schemas.has(targetSchema)) continue;

    const allVariants = schemas.get(targetSchema)!;
    const missing = allVariants.filter((v) => !handledVariants.has(v.name));

    if (missing.length === 0) continue;

    // Calculate arm indentation
    const matchLine = lines[mStartLine] || "";
    const matchIndent = matchLine.match(/^\s*/)?.[0] || "";
    let armIndent = matchIndent + "  ";

    if (matchExpr.arms.length > 0) {
      const firstArmLine = lines[matchExpr.arms[0].span.start.line - 1] || "";
      const existingArmIndent = firstArmLine.match(/^\s*/)?.[0];
      if (existingArmIndent) armIndent = existingArmIndent;
    }

    const newArmsText = missing
      .map((v) => {
        const fieldsStr = v.fields.length > 0 ? `(${v.fields.join(", ")})` : "";
        return `${armIndent}| ${v.name}${fieldsStr} => ???`;
      })
      .join("\n");

    if (matchExpr.arms.length > 0) {
      const lastArm = matchExpr.arms[matchExpr.arms.length - 1];
      const endLine = lastArm.span.end.line - 1;
      const endCol = lines[endLine].length;
      actions.push({
        title: `Fill missing match arms (${missing.map((v) => v.name).join(", ")})`,
        kind: CodeActionKind.QuickFix,
        isPreferred: true,
        edit: {
          changes: {
            [uri]: [
              {
                range: {
                  start: { line: endLine, character: endCol },
                  end: { line: endLine, character: endCol },
                },
                newText: "\n" + newArmsText,
              },
            ],
          },
        },
      });
    } else {
      const endLine = matchExpr.span.start.line - 1;
      const endCol = lines[endLine].length;
      actions.push({
        title: `Fill missing match arms (${missing.map((v) => v.name).join(", ")})`,
        kind: CodeActionKind.QuickFix,
        isPreferred: true,
        edit: {
          changes: {
            [uri]: [
              {
                range: {
                  start: { line: endLine, character: endCol },
                  end: { line: endLine, character: endCol },
                },
                newText: "\n" + newArmsText,
              },
            ],
          },
        },
      });
    }
  }

  return actions;
}
