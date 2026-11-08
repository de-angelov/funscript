import ts from "typescript";
import {
  Emitter,
  type StageResolution,
  COMPARISON_METHOD_MAP,
  PipelineResolutionError,
  isEffectModule,
  ES_TOOLKIT_METHODS,
  ES_TOOLKIT_STRING_METHODS,
  ES_TOOLKIT_MATH_DATA_LAST,
  ES_TOOLKIT_MATH_COLLECTION,
  ES_TOOLKIT_TIMING_DATA_LAST,
} from "../emitter/emitter.js";
import { type PipelineCompanionModule, PIPELINE_COMPANION_CATALOG, pipelineCompanionCandidates, EFFECT_PIPELINE_COMPATIBILITY_ALIASES } from "../emitter/pipeline-catalog.js";
import { Program, type Expression, type PipelineExpression, type CallExpression } from "../ast/types.js";
import { TypeScriptCompilationContext } from "./typescript-context.js";
import { FunScriptError } from "../errors.js";

export interface PipelineCompanionMap extends ReadonlyMap<number, PipelineCompanionModule> {
  readonly pipelineCompanions: ReadonlyMap<number, PipelineCompanionModule>;
  readonly stageResolutions: ReadonlyMap<number, StageResolution>;
  readonly directCallResolutions: ReadonlyMap<number, StageResolution>;
}

const STRING_COMPANION_METHODS = new Set(["trim", "trimStart", "trimEnd", "split", "lines", "toUpperCase", "toLowerCase"]);
const DURATION_COMPANION_METHODS = new Set(["seconds", "millis", "minutes", "hours", "days"]);
const NUMBER_COMPANION_METHODS = new Set([
  "isGreaterThan", "isGreaterThanOrEqualTo", "isLessThan", "isLessThanOrEqualTo",
  "greaterThan", "greaterThanOrEqualTo", "lessThan", "lessThanOrEqualTo",
  "between", "clamp", "increment", "decrement",
]);
const DATETIME_COMPANION_METHODS = new Set([
  "lessThan", "lessThanOrEqualTo", "greaterThan", "greaterThanOrEqualTo", "between",
  "isLessThan", "isLessThanOrEqualTo", "isGreaterThan", "isGreaterThanOrEqualTo",
]);

function unrollPipeline(expr: PipelineExpression): Expression[] {
  const chain: Expression[] = [];
  let curr: Expression = expr;
  while (curr.kind === "PipelineExpression") {
    chain.unshift(curr.right);
    curr = curr.left;
  }
  chain.unshift(curr);
  return chain;
}

function collectPipelines(node: any, pipelines: PipelineExpression[] = []): PipelineExpression[] {
  if (!node || typeof node !== "object") return pipelines;
  if (node.kind === "PipelineExpression") {
    pipelines.push(node);
    let curr = node;
    while (curr.kind === "PipelineExpression") {
      collectPipelines(curr.right, pipelines);
      curr = curr.left;
    }
    collectPipelines(curr, pipelines);
    return pipelines;
  }
  for (const key of Object.keys(node)) {
    if (key === "left" || key === "right") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) collectPipelines(item, pipelines);
    } else if (child && typeof child === "object") {
      collectPipelines(child, pipelines);
    }
  }
  return pipelines;
}

function collectDirectCalls(node: any, inPipeline = false, calls: CallExpression[] = []): CallExpression[] {
  if (!node || typeof node !== "object") return calls;
  if (node.kind === "PipelineExpression") {
    let curr = node;
    const stages: any[] = [];
    while (curr.kind === "PipelineExpression") {
      stages.unshift(curr.right);
      curr = curr.left;
    }
    stages.unshift(curr);
    collectDirectCalls(stages[0], inPipeline, calls);
    for (let i = 1; i < stages.length; i++) {
      collectDirectCalls(stages[i], true, calls);
    }
    return calls;
  }
  if (node.kind === "CallExpression") {
    if (!inPipeline) calls.push(node);
    collectDirectCalls(node.callee, inPipeline, calls);
    for (const arg of node.args) collectDirectCalls(arg, inPipeline, calls);
    return calls;
  }
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) collectDirectCalls(item, inPipeline, calls);
    } else if (child && typeof child === "object") {
      collectDirectCalls(child, inPipeline, calls);
    }
  }
  return calls;
}

/**
 * Finds the source and stage types of every pipeline and direct comparison call
 * using TypeScript's type checker before final emission.
 */
export function inferPipelineCompanions(
  ast: Program,
  context: TypeScriptCompilationContext,
  importedRecordFunctions?: ReadonlyMap<string, ReadonlySet<number>>,
  importedRecordContracts?: ReadonlyMap<string, import("../ast/types.js").RecordTypeNode>,
): PipelineCompanionMap {
  const schemaNames = new Set<string>();
  const localBindings = new Set<string>();

  for (const decl of ast.body) {
    if (decl.kind === "SchemaDeclaration") {
      schemaNames.add(decl.id.name);
    } else if (decl.kind === "ExportDeclaration" && decl.declaration.kind === "SchemaDeclaration") {
      schemaNames.add(decl.declaration.id.name);
    } else if (decl.kind === "BindingDeclaration") {
      localBindings.add(decl.id.name);
    } else if (decl.kind === "ExportDeclaration" && decl.declaration.kind === "BindingDeclaration") {
      localBindings.add(decl.declaration.id.name);
    } else if (decl.kind === "ImportDeclaration") {
      for (const spec of decl.specifiers) {
        localBindings.add(spec.local.name);
      }
    }
  }

  const marked = new Emitter(ast, undefined, {
    allowAmbiguousPipeline: true,
    markPipelineSources: true,
    importedRecordFunctions,
    importedRecordContracts,
  }).emit();

  const emptyResult = new Map<number, PipelineCompanionModule>() as Map<number, PipelineCompanionModule> & {
    pipelineCompanions: ReadonlyMap<number, PipelineCompanionModule>;
    stageResolutions: ReadonlyMap<number, StageResolution>;
    directCallResolutions: ReadonlyMap<number, StageResolution>;
  };
  emptyResult.pipelineCompanions = emptyResult;
  emptyResult.stageResolutions = new Map();
  emptyResult.directCallResolutions = new Map();

  if (!marked.includes("__funscriptPipelineSource(") && !marked.includes("__funscriptDirectCall(")) {
    return emptyResult;
  }

  const source = `import { Array, Chunk, DateTime, Duration, Effect, Layer, Option, Result, Schedule, Schema, Stream, String } from "effect";\ndeclare const decode: any;\nconst __funscriptPipelineSource = <T,>(_id: number, value: T): T => value;\nconst __funscriptDirectCall = <T,>(_id: number, value: T): T => value;\n${marked}`;
  const checked = context.check(source);
  if (!checked) return emptyResult;
  const { sourceFile, checker } = checked;

  const companions = new Map<number, PipelineCompanionModule>();
  const stageResolutions = new Map<number, StageResolution>();
  const directCallResolutions = new Map<number, StageResolution>();

  const isSchemaType = (type: ts.Type): boolean => {
    if (Boolean(type.getProperty("ast") && type.getProperty("Type"))) return true;
    const printed = checker.typeToString(type);
    return /^Schema(?:<|$)/.test(printed) || /^Struct(?:<|$)/.test(printed);
  };

  const isDateTimeType = (type: ts.Type): boolean => {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
    const name = type.aliasSymbol?.getName() ?? type.symbol?.getName();
    if (name === "DateTime" || name === "Utc" || name === "Zoned" || name === "TimeZone") return true;
    const printed = checker.typeToString(type);
    if (/^DateTime(?:<|$)/.test(printed) || /^Utc(?:<|$)/.test(printed)) return true;
    const decl = type.symbol?.declarations?.[0];
    const fileName = decl?.getSourceFile()?.fileName ?? "";
    return /DateTime(?:\.d)?\.ts$/.test(fileName);
  };

  const companionForType = (type: ts.Type): string | undefined => {
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
    if (Boolean(type.flags & ts.TypeFlags.NumberLike)) return "Number";
    if (Boolean(type.flags & ts.TypeFlags.StringLike)) return "String";
    if (Boolean(type.flags & ts.TypeFlags.BooleanLike)) return "Boolean";
    if (isDateTimeType(type)) return "DateTime";

    const symbol = type.aliasSymbol ?? type.getSymbol();
    const symName = symbol?.getName();
    if (symName) {
      if (symName === "Option" || symName === "Result" || symName === "Chunk" || symName === "Effect" ||
          symName === "Schedule" || symName === "Layer" || symName === "Stream" || symName === "Schema" ||
          symName === "Duration" || symName === "String" || symName === "Number" || symName === "DateTime") {
        return symName;
      }
      return symName;
    }
    return undefined;
  };

  const pipelineSourceNodes = new Map<number, ts.CallExpression>();
  const directCallNodes = new Map<number, ts.CallExpression>();

  const visitNodes = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "__funscriptPipelineSource" && node.arguments.length === 2 && ts.isNumericLiteral(node.arguments[0])) {
        pipelineSourceNodes.set(Number(node.arguments[0].text), node);
      } else if (node.expression.text === "__funscriptDirectCall" && node.arguments.length === 2 && ts.isNumericLiteral(node.arguments[0])) {
        directCallNodes.set(Number(node.arguments[0].text), node);
      }
    }
    ts.forEachChild(node, visitNodes);
  };
  visitNodes(sourceFile);

  // 1. Process pipelines stage-by-stage
  const pipelines = collectPipelines(ast);
  for (const pipeline of pipelines) {
    const stages = unrollPipeline(pipeline);
    const s0 = stages[0];
    const sourceNode = pipelineSourceNodes.get(s0.span.start.offset);
    if (!sourceNode) continue;

    let currentType = checker.getTypeAtLocation(sourceNode.arguments[1]);
    let currentCompanion = companionForType(currentType);

    if (!currentCompanion && ts.isCallExpression(sourceNode.parent)) {
      for (const stage of sourceNode.parent.arguments.slice(1)) {
        if (
          ts.isCallExpression(stage) &&
          ((ts.isIdentifier(stage.expression) && stage.expression.text === "decode") ||
            (ts.isPropertyAccessExpression(stage.expression) &&
              (stage.expression.name.text === "decode" || stage.expression.name.text === "decodeUnknown"))) &&
          stage.arguments.length >= 1
        ) {
          const targetArg = stage.arguments[0];
          if (
            (ts.isIdentifier(targetArg) && schemaNames.has(targetArg.text)) ||
            isSchemaType(checker.getTypeAtLocation(targetArg))
          ) {
            currentCompanion = "Schema";
            break;
          }
        }
      }
    }

    if (currentCompanion && currentCompanion in PIPELINE_COMPANION_CATALOG) {
      companions.set(s0.span.start.offset, currentCompanion as PipelineCompanionModule);
    }

    // Resolve subsequent stages
    for (let i = 1; i < stages.length; i++) {
      const stage = stages[i];
      let fnName: string | undefined;
      let isExplicit = false;
      let explicitModule: string | undefined;

      if (stage.kind === "Identifier" || stage.kind === "UpperIdentifier") {
        fnName = stage.name;
      } else if (stage.kind === "CallExpression" && (stage.callee.kind === "Identifier" || stage.callee.kind === "UpperIdentifier")) {
        fnName = stage.callee.name;
      } else if (stage.kind === "CallExpression" && stage.callee.kind === "MemberExpression" && (stage.callee.object.kind === "UpperIdentifier" || stage.callee.object.kind === "Identifier")) {
        explicitModule = stage.callee.object.name;
        fnName = stage.callee.property.name;
        isExplicit = true;
      } else if (stage.kind === "MemberExpression" && (stage.object.kind === "UpperIdentifier" || stage.object.kind === "Identifier")) {
        explicitModule = stage.object.name;
        fnName = stage.property.name;
        isExplicit = true;
      }

      if (isExplicit && explicitModule) {
        stageResolutions.set(stage.span.start.offset, { module: explicitModule, method: fnName });
        const sym = checker.resolveName(explicitModule, sourceFile, ts.SymbolFlags.Value | ts.SymbolFlags.Namespace, false);
        if (sym && fnName) {
          const symType = checker.getTypeOfSymbolAtLocation(sym, sourceFile);
          const prop = checker.getPropertyOfType(symType, fnName) ?? sym.exports?.get(ts.escapeLeadingUnderscores(fnName));
          if (prop) {
            const propType = checker.getTypeOfSymbolAtLocation(prop, sourceFile);
            let ret = propType.getCallSignatures()[0]?.getReturnType();
            if (ret && ret.getCallSignatures().length > 0) {
              ret = ret.getCallSignatures()[0].getReturnType();
            }
            if (ret) {
              currentType = ret;
              currentCompanion = companionForType(ret);
            }
          }
        }
        continue;
      }

      if (!fnName) continue;

      // 1. Comparison operations (lessThan, greaterThan, between, etc.)
      if (fnName in COMPARISON_METHOD_MAP) {
        const method = COMPARISON_METHOD_MAP[fnName];
        if (currentCompanion === "Number" || Boolean(currentType.flags & ts.TypeFlags.NumberLike)) {
          stageResolutions.set(stage.span.start.offset, { module: "Number", method, isComparison: true });
          currentCompanion = "Boolean";
          currentType = checker.getBooleanType();
          continue;
        }
        if (currentCompanion === "DateTime" || isDateTimeType(currentType)) {
          stageResolutions.set(stage.span.start.offset, { module: "DateTime", method, isComparison: true });
          currentCompanion = "Boolean";
          currentType = checker.getBooleanType();
          continue;
        }
        if (currentType && !(currentType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
          const typeStr = checker.typeToString(currentType);
          throw new PipelineResolutionError(
            `< or comparison '${fnName}' is only available for supported ordered types (Number, DateTime); this operand has type ${typeStr}. Use Order.isLessThan(...) or an explicit domain Order. See docs/syntax.md#42-equality-and-comparisons.`,
            stage.span,
          );
        }
      }

      // 2. String companion operations
      if (currentCompanion === "String" && STRING_COMPANION_METHODS.has(fnName)) {
        const method = fnName === "lines" ? "linesIterator" : fnName;
        stageResolutions.set(stage.span.start.offset, { module: "String", method });
        if (fnName === "lines" || fnName === "split") {
          currentCompanion = "Array";
        } else {
          currentCompanion = "String";
        }
        continue;
      }

      // 3. Duration operations
      if (currentCompanion === "Number" && DURATION_COMPANION_METHODS.has(fnName)) {
        stageResolutions.set(stage.span.start.offset, { module: "Duration", method: fnName });
        currentCompanion = "Duration";
        continue;
      }

      // 4. Catalog module operations (Array, Option, Effect, etc.)
      if (currentCompanion && currentCompanion in PIPELINE_COMPANION_CATALOG) {
        const catalog = PIPELINE_COMPANION_CATALOG[currentCompanion as PipelineCompanionModule];
        if (catalog.includes(fnName) || (currentCompanion === "Effect" && fnName in EFFECT_PIPELINE_COMPATIBILITY_ALIASES)) {
          const method = currentCompanion === "Effect" && fnName in EFFECT_PIPELINE_COMPATIBILITY_ALIASES
            ? EFFECT_PIPELINE_COMPATIBILITY_ALIASES[fnName]
            : fnName;
          stageResolutions.set(stage.span.start.offset, { module: currentCompanion, method });
          if (currentCompanion === "Array") {
            if (fnName === "head" || fnName === "last" || fnName === "findFirst" || fnName === "findLast") {
              currentCompanion = "Option";
            } else if (fnName === "length" || fnName === "countBy") {
              currentCompanion = "Number";
            }
          } else if (currentCompanion === "Option") {
            if (fnName === "toArray") currentCompanion = "Array";
            else if (fnName === "getOrElse" || fnName === "getOrNull" || fnName === "getOrUndefined") currentCompanion = undefined;
          } else if (currentCompanion === "Chunk") {
            if (fnName === "head" || fnName === "last") currentCompanion = "Option";
            else if (fnName === "toArray" || fnName === "toReadonlyArray") currentCompanion = "Array";
          }
          continue;
        }
      }

      // 4b. es-toolkit operations (pure string, math data-last, timing)
      if (ES_TOOLKIT_METHODS.has(fnName) && !localBindings.has(fnName)) {
        if (ES_TOOLKIT_STRING_METHODS.has(fnName)) {
          currentCompanion = "String";
          currentType = checker.getStringType();
        } else if (ES_TOOLKIT_MATH_DATA_LAST.has(fnName)) {
          if (fnName === "inRange") {
            currentCompanion = "Boolean";
            currentType = checker.getBooleanType();
          } else {
            currentCompanion = "Number";
            currentType = checker.getNumberType();
          }
        } else if (ES_TOOLKIT_MATH_COLLECTION.has(fnName)) {
          currentCompanion = "Number";
          currentType = checker.getNumberType();
        } else if (ES_TOOLKIT_TIMING_DATA_LAST.has(fnName)) {
          currentCompanion = undefined;
        }
        continue;
      }

      // 5. Custom Abstractions (e.g. HttpClient, HttpResponse)
      if (currentCompanion) {
        const sym = checker.resolveName(currentCompanion, sourceFile, ts.SymbolFlags.Value | ts.SymbolFlags.Namespace, false) ??
          checker.resolveName(currentCompanion, sourceFile, ts.SymbolFlags.Type, false);
        if (sym) {
          const symType = checker.getTypeOfSymbolAtLocation(sym, sourceFile);
          const prop = checker.getPropertyOfType(symType, fnName) ?? sym.exports?.get(ts.escapeLeadingUnderscores(fnName));
          if (prop) {
            stageResolutions.set(stage.span.start.offset, { module: currentCompanion, method: fnName });
            const propType = checker.getTypeOfSymbolAtLocation(prop, sourceFile);
            let ret = propType.getCallSignatures()[0]?.getReturnType();
            if (ret && ret.getCallSignatures().length > 0) {
              ret = ret.getCallSignatures()[0].getReturnType();
            }
            if (ret) {
              currentType = ret;
              currentCompanion = companionForType(ret);
            }
            continue;
          }
        }
        if (!localBindings.has(fnName)) {
          throw new PipelineResolutionError(
            `${fnName} cannot be resolved for ${currentCompanion}. Explicit Module.${fnName} qualification is available.`,
            stage.span,
          );
        }
      }

      // 6. Undefined companion: check candidate ambiguity
      if (!currentCompanion) {
        const candidates = pipelineCompanionCandidates(fnName);
        if (candidates.length > 1) {
          throw new PipelineResolutionError(
            `${fnName} is ambiguous for this pipeline; write ${candidates.map((m) => `${m}.${fnName}(...)`).join(" or ")}`,
            stage.span,
          );
        } else if (candidates.length === 1) {
          stageResolutions.set(stage.span.start.offset, { module: candidates[0], method: fnName });
          currentCompanion = candidates[0];
          continue;
        }
      }
    }
  }

  // 2. Process direct calls
  const directCalls = collectDirectCalls(ast);
  for (const call of directCalls) {
    if (call.callee.kind !== "Identifier") continue;
    const name = call.callee.name;
    const directNode = directCallNodes.get(call.span.start.offset);
    if (!directNode) continue;
    const argType = checker.getTypeAtLocation(directNode.arguments[1]);

    if (name in COMPARISON_METHOD_MAP) {
      const method = COMPARISON_METHOD_MAP[name];
      if (Boolean(argType.flags & ts.TypeFlags.NumberLike)) {
        directCallResolutions.set(call.span.start.offset, { module: "Number", method, isComparison: true });
        continue;
      }
      if (isDateTimeType(argType)) {
        directCallResolutions.set(call.span.start.offset, { module: "DateTime", method, isComparison: true });
        continue;
      }
      const typeStr = checker.typeToString(argType);
      throw new FunScriptError(
        `comparison '${name}' is only available for supported ordered types (Number, DateTime); this operand has type ${typeStr}. Use Order.isLessThan(...) or an explicit domain Order. See docs/syntax.md#42-equality-and-comparisons.`,
        call.span,
      );
    }

    if (!localBindings.has(name)) {
      const comp = companionForType(argType);
      if (comp) {
        const sym = checker.resolveName(comp, sourceFile, ts.SymbolFlags.Value | ts.SymbolFlags.Namespace, false);
        if (sym) {
          const symType = checker.getTypeOfSymbolAtLocation(sym, sourceFile);
          const prop = checker.getPropertyOfType(symType, name) ?? sym.exports?.get(ts.escapeLeadingUnderscores(name));
          if (prop) {
            directCallResolutions.set(call.span.start.offset, { module: comp, method: name });
          }
        }
      }
    }
  }

  const result = companions as Map<number, PipelineCompanionModule> & {
    pipelineCompanions: ReadonlyMap<number, PipelineCompanionModule>;
    stageResolutions: ReadonlyMap<number, StageResolution>;
    directCallResolutions: ReadonlyMap<number, StageResolution>;
  };
  result.pipelineCompanions = companions;
  result.stageResolutions = stageResolutions;
  result.directCallResolutions = directCallResolutions;
  return result;
}
