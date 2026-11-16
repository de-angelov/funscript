import ts from "typescript";
import { Program, type Span, type RecordTypeNode } from "../ast/types.js";
import { Emitter } from "../emitter/emitter.js";
import { TypeScriptCompilationContext } from "./typescript-context.js";

class NumericComparisonError extends Error {
  constructor(message: string, readonly span: Span) {
    super(message);
    this.name = "NumericComparisonError";
  }
}

function spanAtOffset(source: string, offset: number): Span {
  const prefix = source.slice(0, offset);
  const lines = prefix.split(/\r?\n/);
  const position = {
    offset,
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
  return { start: position, end: position };
}

function comparisonError(source: string, offset: number, operator: string, received: string): NumericComparisonError {
  const helper = operator === ">=" ? "isGreaterThanOrEqualTo"
    : operator === "<=" ? "isLessThanOrEqualTo"
    : operator === ">" ? "isGreaterThan" : "isLessThan";
  return new NumericComparisonError(
    `${operator} is only available for numbers; this operand has type ${received}. Use Order.${helper}(String.Order)(...) or an explicit domain Order. See docs/syntax.md#42-equality-and-comparisons.`,
    spanAtOffset(source, offset),
  );
}

/** Handle only direct comparisons of explicitly typed primitive parameters. */
function checkDirectParameters(generated: string, source: string): boolean {
  const file = ts.createSourceFile("numeric-fast-path.ts", generated, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) return false;
  let count = 0;
  let unresolved = false;
  let firstError: NumericComparisonError | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "__funscriptNumericOperand" && node.arguments.length === 3) {
      count++;
      const [offset, operator, value] = node.arguments;
      const binary = node.parent;
      if (!ts.isNumericLiteral(offset) || !ts.isStringLiteral(operator) || !ts.isIdentifier(value) || !ts.isBinaryExpression(binary) || (binary.left !== node && binary.right !== node)) {
        unresolved = true;
      } else {
        let body: ts.Node = binary;
        while (body.parent && ts.isParenthesizedExpression(body.parent)) body = body.parent;
        const arrow = body.parent;
        if (!arrow || !ts.isArrowFunction(arrow) || arrow.body !== body) {
          unresolved = true;
        } else {
          const matches = arrow.parameters.filter(parameter => ts.isIdentifier(parameter.name) && parameter.name.text === value.text);
          const parameter = matches[0];
          if (matches.length !== 1 || !parameter.type || parameter.questionToken || parameter.initializer || parameter.dotDotDotToken ||
            (parameter.type.kind !== ts.SyntaxKind.NumberKeyword && parameter.type.kind !== ts.SyntaxKind.StringKeyword)) {
            unresolved = true;
          } else if (parameter.type.kind === ts.SyntaxKind.StringKeyword && !firstError) {
            firstError = comparisonError(source, Number(offset.text), operator.text, "string");
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!count || unresolved) return false;
  if (firstError) throw firstError;
  return true;
}

/**
 * Native relational operators deliberately have a much narrower domain than
 * JavaScript: both operands must be proven numbers. This keeps string,
 * locale, and domain ordering explicit through Effect's Order API.
 */
export function validateNumericComparisons(ast: Program, source: string, context: TypeScriptCompilationContext, importedRecordFunctions?: ReadonlyMap<string, ReadonlySet<number>>, importedRecordContracts?: ReadonlyMap<string, RecordTypeNode>, importedGenericDataSchemas?: ReadonlyMap<string, number>, importedIdentitySchemas?: ReadonlySet<string>): void {
  const marked = new Emitter(ast, undefined, {
    allowAmbiguousPipeline: true,
    markNumericComparisonOperands: true,
    importedRecordFunctions,
    importedRecordContracts,
    importedGenericDataSchemas,
    importedIdentitySchemas,
  }).emit();
  if (!marked.includes("__funscriptNumericOperand(")) return;

  const generated = `const __funscriptNumericOperand = <T,>(_offset: number, _operator: string, value: T): T => value;\n${marked}`;
  if (checkDirectParameters(generated, source)) return;
  const checked = context.check(generated);
  if (!checked) return;
  const { sourceFile, checker } = checked;

  const isDefinitelyNumber = (type: ts.Type): boolean => {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
    if (type.isUnion()) return type.types.every(isDefinitelyNumber);
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(type);
      return constraint !== undefined && constraint !== type && isDefinitelyNumber(constraint);
    }
    return Boolean(type.flags & ts.TypeFlags.NumberLike);
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "__funscriptNumericOperand" &&
      node.arguments.length === 3 &&
      ts.isNumericLiteral(node.arguments[0]) &&
      ts.isStringLiteral(node.arguments[1])
    ) {
      const type = checker.getTypeAtLocation(node.arguments[2]);
      if (!isDefinitelyNumber(type)) {
        const operator = node.arguments[1].text;
        const received = checker.typeToString(type);
        throw comparisonError(source, Number(node.arguments[0].text), operator, received);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}
