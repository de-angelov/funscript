import ts from "typescript";
import { Program, type Span } from "../ast/types.js";
import { Emitter } from "../emitter/emitter.js";
import { TypeScriptCompilationContext } from "./typescript-compilation-context.js";

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

/**
 * Native relational operators deliberately have a much narrower domain than
 * JavaScript: both operands must be proven numbers. This keeps string,
 * locale, and domain ordering explicit through Effect's Order API.
 */
export function validateNumericComparisons(ast: Program, source: string, context: TypeScriptCompilationContext): void {
  const marked = new Emitter(ast, undefined, {
    allowAmbiguousPipeline: true,
    markNumericComparisonOperands: true,
  }).emit();
  if (!marked.includes("__funscriptNumericOperand(")) return;

  const generated = `const __funscriptNumericOperand = <T,>(_offset: number, _operator: string, value: T): T => value;\n${marked}`;
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
        const helper = operator === ">=" ? "isGreaterThanOrEqualTo"
          : operator === "<=" ? "isLessThanOrEqualTo"
          : operator === ">" ? "isGreaterThan" : "isLessThan";
        const received = checker.typeToString(type);
        throw new NumericComparisonError(
          `${operator} is only available for numbers; this operand has type ${received}. Use Order.${helper}(String.Order)(...) or an explicit domain Order.`,
          spanAtOffset(source, Number(node.arguments[0].text)),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}
