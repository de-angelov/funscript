import ts from "typescript";
import type { Program, RecordTypeNode, TypeNode } from "../ast/types.js";
import { walkAst } from "../ast/walk.js";
import { Emitter } from "../emitter/emitter.js";
import { FunScriptError } from "../errors.js";
import type { TypeScriptCompilationContext } from "./typescript-context.js";

function spanAtOffset(source: string, offset: number) {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  const pos = { offset, line, column };
  return { start: pos, end: pos };
}

/**
 * Enforce boolean-only operands for FunScript `and` and `or` operators so
 * JavaScript truthiness fallbacks (e.g. `x or ""`) are rejected at compile time.
 */
export function validateBooleanOperators(
  ast: Program,
  source: string,
  context: TypeScriptCompilationContext,
  importedRecordFunctions?: ReadonlyMap<string, ReadonlySet<number>>,
  importedRecordContracts?: ReadonlyMap<string, RecordTypeNode>,
  importedGenericDataSchemas?: ReadonlyMap<string, number>,
  importedIdentitySchemas?: ReadonlySet<string>,
  importedDataSchemas?: ReadonlySet<string>,
  importedNullishSchemas?: ReadonlyMap<string, ReadonlyMap<string, TypeNode>>,
  importedTaggedUnionVariants?: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  let hasBoolOp = false;
  walkAst(ast, (node) => {
    if (
      node.kind === "BinaryExpression" &&
      (node.operator === "and" || node.operator === "or")
    ) {
      hasBoolOp = true;
    }
  });
  if (!hasBoolOp) return;

  const marked = new Emitter(ast, undefined, {
    allowAmbiguousPipeline: true,
    markBooleanOperands: true,
    importedRecordFunctions,
    importedRecordContracts,
    importedGenericDataSchemas,
    importedIdentitySchemas,
    importedDataSchemas,
    importedNullishSchemas,
    importedTaggedUnionVariants,
  }).emit();
  if (!marked.includes("__funscriptBooleanOperand(")) return;

  const generated = `const __funscriptBooleanOperand = <T,>(_offset: number, _operator: string, value: T): T => value;\n${marked}`;
  const checked = context.check(generated);
  if (!checked) return;
  const { sourceFile, checker } = checked;

  const isDefinitelyBoolean = (type: ts.Type): boolean => {
    if (
      type.flags &
      (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)
    )
      return false;
    if (type.isUnion()) return type.types.every(isDefinitelyBoolean);
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(type);
      return (
        constraint !== undefined &&
        constraint !== type &&
        isDefinitelyBoolean(constraint)
      );
    }
    return Boolean(type.flags & ts.TypeFlags.BooleanLike);
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "__funscriptBooleanOperand" &&
      node.arguments.length === 3 &&
      ts.isNumericLiteral(node.arguments[0]) &&
      ts.isStringLiteral(node.arguments[1])
    ) {
      const type = checker.getTypeAtLocation(node.arguments[2]);
      if (!isDefinitelyBoolean(type)) {
        const operator = node.arguments[1].text;
        const received = checker.typeToString(type);
        throw new FunScriptError(
          `Logical '${operator}' requires boolean operands; got '${received}'. Use 'match' for branching or 'Option' / 'Schema' for defaults.`,
          spanAtOffset(source, Number(node.arguments[0].text)),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}
