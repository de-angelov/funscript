import ts from "typescript";
import { TypeScriptCompilationContext } from "./typescript-context.js";

/**
 * Resolves the awaited TypeScript type of each generated js interop call. The
 * emitter deliberately keeps its interface small: it always emits the same
 * adapter and this pass supplies the one runtime fact that TypeScript erases —
 * whether the resolved native value can be null or undefined.
 */
export function applyJsInteropNullability(typescript: string, context: TypeScriptCompilationContext): string {
  if (!typescript.includes("__funscriptJs(")) return typescript;

  const checked = context.check(typescript);
  if (!checked) return typescript;
  const { sourceFile, checker } = checked;
  const replacements: Array<{ start: number; end: number; value: "true" | "false" | '"unknown"' }> = [];

  const includesNullish = (type: ts.Type): boolean => {
    if (type.isUnion()) return type.types.some(includesNullish);
    return Boolean(type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined));
  };
  const isUntrusted = (type: ts.Type): boolean => {
    if (type.isUnion()) return type.types.some(isUntrusted);
    return Boolean(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "__funscriptJs" &&
      node.arguments.length === 2 &&
      ts.isArrowFunction(node.arguments[0])
    ) {
      const returnType = checker.getTypeAtLocation(node.arguments[0].body);
      const awaited = checker.getAwaitedType(returnType);
      const flag = !awaited || isUntrusted(awaited)
        ? '"unknown"'
        : includesNullish(awaited)
        ? "true"
        : "false";
      replacements.push({ start: node.arguments[1].getStart(sourceFile), end: node.arguments[1].getEnd(), value: flag });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    typescript = typescript.slice(0, replacement.start) + replacement.value + typescript.slice(replacement.end);
  }
  return typescript;
}
