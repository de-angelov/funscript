import type { BindingDeclaration, Expression } from "../ast/types.js";
import { EFFECT_PIPELINE_COMPATIBILITY_ALIASES, PIPELINE_COMPANION_CATALOG, pipelineCompanionCandidates, type PipelineCompanionModule } from "./pipeline-catalog.js";

const ARRAY_COMPANION_METHODS = new Set(PIPELINE_COMPANION_CATALOG.Array);
const EFFECT_COMPANION_METHODS = new Set(PIPELINE_COMPANION_CATALOG.Effect);
const OPTION_COMPANION_METHODS = new Set(PIPELINE_COMPANION_CATALOG.Option);
const RESULT_COMPANION_METHODS = new Set(PIPELINE_COMPANION_CATALOG.Result);
const CHUNK_COMPANION_METHODS = new Set(PIPELINE_COMPANION_CATALOG.Chunk);
const STRING_COMPANION_METHODS = new Set(PIPELINE_COMPANION_CATALOG.String);
const RECORD_COMPANION_METHODS = new Set(PIPELINE_COMPANION_CATALOG.Record);
const HASHMAP_COMPANION_METHODS = new Set(PIPELINE_COMPANION_CATALOG.HashMap);
const HASHSET_COMPANION_METHODS = new Set(PIPELINE_COMPANION_CATALOG.HashSet);
const DATETIME_COMPANION_METHODS = new Set(PIPELINE_COMPANION_CATALOG.DateTime);

type CompanionModule = PipelineCompanionModule | "Number" | "Duration" | "Struct" | "DateTime";

const NUMBER_COMPANION_METHODS = new Set([
  "isGreaterThan",
  "isGreaterThanOrEqualTo",
  "isLessThan",
  "isLessThanOrEqualTo",
  "greaterThan",
  "greaterThanOrEqualTo",
  "lessThan",
  "lessThanOrEqualTo",
  "between",
  "increment",
  "decrement",
]);

export const COMPARISON_METHOD_MAP: Readonly<Record<string, string>> = {
  lessThan: "isLessThan",
  lessThanOrEqualTo: "isLessThanOrEqualTo",
  greaterThan: "isGreaterThan",
  greaterThanOrEqualTo: "isGreaterThanOrEqualTo",
  between: "between",
  isLessThan: "isLessThan",
  isLessThanOrEqualTo: "isLessThanOrEqualTo",
  isGreaterThan: "isGreaterThan",
  isGreaterThanOrEqualTo: "isGreaterThanOrEqualTo",
};

const DURATION_COMPANION_METHODS = new Set(["seconds", "millis", "minutes", "hours", "days"]);

export const ES_TOOLKIT_STRING_METHODS = new Set([
  "slug",
  "camelCase",
  "snakeCase",
  "kebabCase",
  "pascalCase",
  "constantCase",
  "capitalize",
  "lowerCase",
  "upperCase",
  "deburr",
  "words",
]);

export const ES_TOOLKIT_MATH_DATA_LAST = new Set([
  "clamp",
  "round",
  "inRange",
]);

export const ES_TOOLKIT_MATH_COLLECTION = new Set([
  "sum",
  "mean",
  "median",
]);

export const ES_TOOLKIT_TIMING_DATA_LAST = new Set([
  "debounce",
  "throttle",
]);

export const ES_TOOLKIT_DATA_LAST_CALLS = new Set([
  ...ES_TOOLKIT_MATH_DATA_LAST,
  ...ES_TOOLKIT_TIMING_DATA_LAST,
]);

export const ES_TOOLKIT_METHODS = new Set([
  ...ES_TOOLKIT_STRING_METHODS,
  ...ES_TOOLKIT_MATH_DATA_LAST,
  ...ES_TOOLKIT_MATH_COLLECTION,
  ...ES_TOOLKIT_TIMING_DATA_LAST,
]);

export class PipelineResolutionError extends Error {
  constructor(message: string, readonly span: Expression["span"]) {
    super(message);
    this.name = "PipelineResolutionError";
  }
}

interface PipelineResolutionContext {
  bindings: ReadonlyMap<string, BindingDeclaration>;
  pipelineCompanions?: ReadonlyMap<number, PipelineCompanionModule>;
  allowAmbiguousPipeline?: boolean;
  isUserBinding(name: string): boolean;
  effectImports: Set<string>;
  esToolkitImports: Set<string>;
  requireDecodeUnknown(): void;
}

/** Resolves pipeline stages and records the imports required by their lowering. */
export class PipelineResolver {
  constructor(private readonly context: PipelineResolutionContext) {}

  public inferPipelineCompanion(source: Expression): CompanionModule | undefined {
    const inferred = this.context.pipelineCompanions?.get(source.span.start.offset);
    if (inferred) return inferred;
    if (source.kind === "ArrayExpression") return "Array";
    if (source.kind === "StringLiteral") return "String";
    if (source.kind === "RecordExpression") return "Record";
    if (source.kind === "EffectBlockExpression" || source.kind === "JsExpression") return "Effect";
    if (source.kind === "Identifier") {
      const binding = this.context.bindings.get(source.name);
      if (binding?.typeAnnotation) {
        if (binding.typeAnnotation.kind === "EffectTypeNode") return "Effect";
        if (binding.typeAnnotation.kind === "ArrayTypeNode") return "Array";
        if (binding.typeAnnotation.kind === "TypeReferenceNode") {
          const module = binding.typeAnnotation.name.name;
          if (module === "Option" || module === "Result" || module === "Chunk" || module === "Array" || module === "Schedule" || module === "Layer" || module === "Stream" || module === "Schema") return module;
        }
      }
      // Local bindings preserve enough AST to prove ordinary initializers even
      // before the TypeScript checker handles imported values in the next pass.
      if (binding && binding.init !== source) return this.inferPipelineCompanion(binding.init);
    }
    const companionSource = source.kind === "CallExpression" && source.callee.kind === "MemberExpression" && source.callee.object.kind === "UpperIdentifier"
      ? source.callee.object
      : source.kind === "MemberExpression" && source.object.kind === "UpperIdentifier"
      ? source.object
      : undefined;
    if (companionSource) {
      const module = companionSource.name;
      if (module === "Effect" || module === "Option" || module === "Result" || module === "Chunk" || module === "Array" || module === "Schedule" || module === "Layer" || module === "Stream" || module === "Schema") return module;
    }
    return undefined;
  }

  public hasPlaceholder(expr: Expression): boolean {
    switch (expr.kind) {
      case "Placeholder":
        return true;
      case "BinaryExpression":
        return this.hasPlaceholder(expr.left) || this.hasPlaceholder(expr.right);
      case "UnaryExpression":
        return this.hasPlaceholder(expr.argument);
      case "CallExpression":
        return this.hasPlaceholder(expr.callee) || expr.args.some((a) => this.hasPlaceholder(a));
      case "MemberExpression":
        return this.hasPlaceholder(expr.object);
      case "IndexExpression":
        return this.hasPlaceholder(expr.object) || this.hasPlaceholder(expr.index);
      case "RecordExpression":
        return expr.entries.some((e) => {
          if (e.kind === "SpreadEntry") return this.hasPlaceholder(e.argument);
          if (e.kind === "FieldEntry") return this.hasPlaceholder(e.value);
          if (e.kind === "DotPathEntry") return this.hasPlaceholder(e.value);
          return false;
        });
      case "ArrayExpression":
        return expr.elements.some((e) => this.hasPlaceholder(e));
      case "PipelineExpression":
        return this.hasPlaceholder(expr.left) || this.hasPlaceholder(expr.right);
      case "JsExpression":
        return this.hasPlaceholder(expr.expression);
      case "SpreadElement":
        return this.hasPlaceholder(expr.argument);
      case "TemplateLiteral":
        return expr.parts.some((p) => p.kind === "StringInterpolationPart" && this.hasPlaceholder(p.expression));
      case "TaggedTemplateExpression":
        return this.hasPlaceholder(expr.tag) || expr.template.parts.some((p) => p.kind === "StringInterpolationPart" && this.hasPlaceholder(p.expression));
      default:
        return false;
    }
  }

  public resolvePipelineStage(stage: Expression, preferredCompanion?: CompanionModule): Expression {
    // 0. 'js' pipeline stage: eff |> js => pipe(eff, Effect.runPromise)
    if (stage.kind === "Identifier" && stage.name === "js") {
      this.context.effectImports.add("Effect");
      return {
        kind: "MemberExpression",
        object: { kind: "UpperIdentifier", name: "Effect", span: stage.span },
        property: { kind: "Identifier", name: "runPromise", span: stage.span },
        span: stage.span,
      };
    }

    // 1. Bare CallExpression: reduce(acc, f), map(f), lessThanOrEqualTo(0), orDie()
    if (stage.kind === "CallExpression" && stage.callee.kind === "Identifier") {
      const name = stage.callee.name;
      if (!this.context.isUserBinding(name)) {
        if ((!preferredCompanion || (preferredCompanion === "String" && ES_TOOLKIT_STRING_METHODS.has(name))) && ES_TOOLKIT_METHODS.has(name)) {
          this.context.esToolkitImports.add(name);
          if (stage.args.length === 0) {
            return stage.callee;
          }
          if (ES_TOOLKIT_DATA_LAST_CALLS.has(name) && !this.hasPlaceholder(stage)) {
            return {
              ...stage,
              args: [{ kind: "Placeholder", span: stage.span }, ...stage.args],
            };
          }
          return stage;
        }
        const companion = this.getCompanionModule(name, preferredCompanion);
        if (companion) {
          this.context.effectImports.add(companion);
          if (companion === "Schema" && name === "decode") {
            this.context.requireDecodeUnknown();
          }
          return {
            ...stage,
            args: companion === "Struct" && (name === "pick" || name === "omit")
              ? [{ kind: "ArrayExpression", elements: stage.args, span: stage.span }]
              : stage.args,
            callee: {
              kind: "MemberExpression",
              object: { kind: "UpperIdentifier", name: companion, span: stage.callee.span },
              property: {
                ...stage.callee,
                name: name === "lines"
                  ? "linesIterator"
                  : name === "decode"
                  ? "decodeUnknown"
                  : (companion === "Number" || companion === "DateTime") && name in COMPARISON_METHOD_MAP
                  ? COMPARISON_METHOD_MAP[name]
                  : name,
              },
              span: stage.callee.span,
            },
          };
        }
      }
      if (!this.context.bindings.has(name) && ES_TOOLKIT_METHODS.has(name)) {
        this.context.esToolkitImports.add(name);
        if (stage.args.length === 0) {
          return stage.callee;
        }
        if (ES_TOOLKIT_DATA_LAST_CALLS.has(name) && !this.hasPlaceholder(stage)) {
          return {
            ...stage,
            args: [{ kind: "Placeholder", span: stage.span }, ...stage.args],
          };
        }
        return stage;
      }
    }

    // 1b. CallExpression with MemberExpression companion call: Array.map(f), Option.getOrElse(f), etc.
    if (stage.kind === "CallExpression" && stage.callee.kind === "MemberExpression") {
      const obj = stage.callee.object;
      const prop = stage.callee.property;
      if (obj.kind === "UpperIdentifier") {
        if (obj.name === "Math" && ES_TOOLKIT_MATH_DATA_LAST.has(prop.name)) {
          this.context.esToolkitImports.add(prop.name);
          if (stage.args.length === 0) {
            return prop;
          }
          if (!this.hasPlaceholder(stage)) {
            return {
              ...stage,
              callee: prop,
              args: [{ kind: "Placeholder", span: stage.span }, ...stage.args],
            };
          }
          return { ...stage, callee: prop };
        }
        if (obj.name === "String" && ES_TOOLKIT_STRING_METHODS.has(prop.name)) {
          this.context.esToolkitImports.add(prop.name);
          return stage.args.length === 0 ? prop : { ...stage, callee: prop };
        }
        const companion = obj.name as CompanionModule;
        if (this.isCompanionOperation(companion, prop.name)) {
          this.context.effectImports.add(companion);
          if (companion === "Schema" && prop.name === "decode") {
            this.context.requireDecodeUnknown();
            return {
              ...stage,
              callee: {
                ...stage.callee,
                property: { ...prop, name: "decodeUnknown" },
              },
            };
          }
          if (companion === "Struct" && (prop.name === "pick" || prop.name === "omit")) {
            return {
              ...stage,
              args: [{
                kind: "ArrayExpression",
                elements: stage.args,
                span: stage.args.length > 0 ? { start: stage.args[0].span.start, end: stage.args[stage.args.length - 1].span.end } : stage.span,
              }],
            };
          }
        }
      }
    }

    // 2. Bare Identifier in pipeline: orDie, length, etc.
    if (stage.kind === "Identifier") {
      const name = stage.name;
      if (!this.context.isUserBinding(name)) {
        if ((!preferredCompanion || (preferredCompanion === "String" && ES_TOOLKIT_STRING_METHODS.has(name))) && ES_TOOLKIT_METHODS.has(name)) {
          this.context.esToolkitImports.add(name);
          return stage;
        }
        const companion = this.getCompanionModule(name, preferredCompanion);
        if (companion) {
          this.context.effectImports.add(companion);
          return {
            kind: "MemberExpression",
            object: { kind: "UpperIdentifier", name: companion, span: stage.span },
            property: { ...stage, name: name === "lines" ? "linesIterator" : name },
            span: stage.span,
          };
        }
      }
      if (!this.context.bindings.has(name) && ES_TOOLKIT_METHODS.has(name)) {
        this.context.esToolkitImports.add(name);
        return stage;
      }
    }

    // 2b. Bare MemberExpression in pipeline: String.camelCase, Math.round, etc.
    if (stage.kind === "MemberExpression" && stage.object.kind === "UpperIdentifier") {
      if (stage.object.name === "String" && ES_TOOLKIT_STRING_METHODS.has(stage.property.name)) {
        this.context.esToolkitImports.add(stage.property.name);
        return stage.property;
      }
      if (
        stage.object.name === "Math" &&
        (ES_TOOLKIT_MATH_DATA_LAST.has(stage.property.name) || ES_TOOLKIT_MATH_COLLECTION.has(stage.property.name))
      ) {
        this.context.esToolkitImports.add(stage.property.name);
        return stage.property;
      }
    }

    return stage;
  }

  private getCompanionModule(name: string, preferredCompanion?: CompanionModule): CompanionModule | undefined {
    if (name === "pick" || name === "omit") return "Struct";
    if (preferredCompanion && this.isCompanionOperation(preferredCompanion, name)) return preferredCompanion;
    const candidates: CompanionModule[] = [];
    if (ARRAY_COMPANION_METHODS.has(name)) candidates.push("Array");
    if (EFFECT_COMPANION_METHODS.has(name)) candidates.push("Effect");
    if (OPTION_COMPANION_METHODS.has(name)) candidates.push("Option");
    if (RESULT_COMPANION_METHODS.has(name)) candidates.push("Result");
    if (CHUNK_COMPANION_METHODS.has(name)) candidates.push("Chunk");
    if (STRING_COMPANION_METHODS.has(name)) candidates.push("String");
    if (RECORD_COMPANION_METHODS.has(name)) candidates.push("Record");
    if (HASHMAP_COMPANION_METHODS.has(name)) candidates.push("HashMap");
    if (HASHSET_COMPANION_METHODS.has(name)) candidates.push("HashSet");
    if (DATETIME_COMPANION_METHODS.has(name)) candidates.push("DateTime");
    if (name === "decode" || (preferredCompanion === "Schema" && this.isCompanionOperation("Schema", name))) candidates.push("Schema");
    if (preferredCompanion && candidates.includes(preferredCompanion)) return preferredCompanion;
    if (candidates.length === 1) return candidates[0];
    // The caller turns an ambiguous core companion into a source diagnostic.
    // Keeping the sentinel local avoids silently reintroducing priority order.
    if (candidates.length > 1) return undefined;
    if (NUMBER_COMPANION_METHODS.has(name)) return "Number";
    if (DURATION_COMPANION_METHODS.has(name)) return "Duration";
    return undefined;
  }

  private isCompanionOperation(module: CompanionModule, operation: string): boolean {
    if (module === "Number") return NUMBER_COMPANION_METHODS.has(operation);
    if (module === "Duration") return DURATION_COMPANION_METHODS.has(operation);
    if (module === "Struct") return operation === "pick" || operation === "omit";
    return (PIPELINE_COMPANION_CATALOG[module as PipelineCompanionModule]?.includes(operation) ?? false) ||
      (module === "Effect" && operation in EFFECT_PIPELINE_COMPATIBILITY_ALIASES);
  }

  public assertPipelineStageIsNotAmbiguous(stage: Expression, preferredCompanion?: CompanionModule): void {
    const name = stage.kind === "Identifier"
      ? stage.name
      : stage.kind === "CallExpression" && stage.callee.kind === "Identifier"
      ? stage.callee.name
      : undefined;
    if (!name || preferredCompanion) return;
    if (this.context.isUserBinding(name)) return;
    const candidates = pipelineCompanionCandidates(name);
    if (candidates.length > 1 && !this.context.allowAmbiguousPipeline) {
      throw new PipelineResolutionError(
        `${name} is ambiguous for this pipeline; write ${candidates.map((module) => `${module}.${name}(...)`).join(" or ")}`,
        stage.span,
      );
    }
  }

}
