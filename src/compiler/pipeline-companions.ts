import ts from "typescript";
import { Emitter } from "../emitter/emitter.js";
import { type PipelineCompanionModule } from "../emitter/pipeline-catalog.js";
import { Program } from "../ast/types.js";
import { TypeScriptCompilationContext } from "./typescript-context.js";

/**
 * Finds the source type of every pipeline before final emission. The marker is
 * an identity function, so TypeScript sees precisely the expression that will
 * become the first argument to `pipe`, including imports and function calls.
 */
export function inferPipelineCompanions(ast: Program, context: TypeScriptCompilationContext): ReadonlyMap<number, PipelineCompanionModule> {
  const marked = new Emitter(ast, undefined, {
    allowAmbiguousPipeline: true,
    markPipelineSources: true,
  }).emit();
  if (!marked.includes("__funscriptPipelineSource(")) return new Map();

  // The provisional emitter deliberately leaves unresolved stages bare. Add
  // companion imports here so source expressions such as `Option.some(...)`
  // still receive their real TypeScript type during this analysis pass.
  const source = `import { Array, Chunk, Effect, Layer, Option, Result, Schedule, Schema, Stream } from "effect";\nconst __funscriptPipelineSource = <T,>(_id: number, value: T): T => value;\n${marked}`;
  const checked = context.check(source);
  if (!checked) return new Map();
  const { sourceFile, checker } = checked;
  const companions = new Map<number, PipelineCompanionModule>();

  const companionForType = (type: ts.Type): PipelineCompanionModule | undefined => {
    // Effect's own Option and Result aliases are unions of their variants.
    // The alias identifies the whole union, unlike a mixed outer union.
    if (type.aliasSymbol?.getName() === "Option") return "Option";
    if (type.aliasSymbol?.getName() === "Result") return "Result";
    if (type.isUnion()) {
      const members = type.types.map(companionForType);
      const first = members[0];
      return first && members.every((member) => member === first) ? first : undefined;
    }
    const printed = checker.typeToString(type);
    if (/^Option(?:<|$)/.test(printed)) return "Option";
    if (/^Result(?:<|$)/.test(printed)) return "Result";
    if (/^Chunk(?:<|$)/.test(printed)) return "Chunk";
    if (/^Effect(?:<|$)/.test(printed)) return "Effect";
    if (/^Schedule(?:<|$)/.test(printed)) return "Schedule";
    if (/^Layer(?:<|$)/.test(printed)) return "Layer";
    if (/^Stream(?:<|$)/.test(printed)) return "Stream";
    if (/^Schema(?:<|$)/.test(printed)) return "Schema";
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return undefined;
    if (checker.isArrayType(type) || checker.isTupleType(type)) return "Array";
    const symbol = type.aliasSymbol ?? type.getSymbol();
    switch (symbol?.getName()) {
      case "Option": return "Option";
      case "Result": return "Result";
      case "Chunk": return "Chunk";
      case "Effect": return "Effect";
      default: {
        // Some Effect interfaces retain a concrete implementation symbol
        // (for example `Some`) while printing as their public companion type.
        if (/^Option(?:<|$)/.test(printed)) return "Option";
        if (/^Result(?:<|$)/.test(printed)) return "Result";
        if (/^Chunk(?:<|$)/.test(printed)) return "Chunk";
        if (/^Effect(?:<|$)/.test(printed)) return "Effect";
        if (/^Schedule(?:<|$)/.test(printed)) return "Schedule";
        if (/^Layer(?:<|$)/.test(printed)) return "Layer";
        if (/^Stream(?:<|$)/.test(printed)) return "Stream";
        if (/^Schema(?:<|$)/.test(printed)) return "Schema";
        return undefined;
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "__funscriptPipelineSource" &&
      node.arguments.length === 2 &&
      ts.isNumericLiteral(node.arguments[0])
    ) {
      const companion = companionForType(checker.getTypeAtLocation(node.arguments[1]));
      if (companion) companions.set(Number(node.arguments[0].text), companion);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return companions;
}

