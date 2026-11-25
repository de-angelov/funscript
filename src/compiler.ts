import * as Effect from "effect/Effect";
import type { SourceMap } from "magic-string";
export type { SourceMap };
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type BindingTarget,
  type Pattern,
  type Program,
  type RecordTypeNode,
  type Span,
} from "./ast/types.js";
import { walkAst } from "./ast/walk.js";
import { resolveImportedRecordFunctions } from "./compiler/imported-record-functions.js";
import { resolveImportedSchemas } from "./compiler/imported-schemas.js";
import { applyJsInteropNullability } from "./compiler/js-interop-nullability.js";
import { validateNumericComparisons } from "./compiler/numeric-comparisons.js";
import { resolveOptionalArguments } from "./compiler/optional-arguments.js";
import { resolvePackageRecordContracts } from "./compiler/package-record-contracts.js";
import { inferPipelineCompanions } from "./compiler/pipeline-companions.js";
import { isPathPolicyEnabled } from "./compiler/project-config.js";
import { generateSourceMap } from "./compiler/source-map.js";
import { TypeScriptCompilationContext } from "./compiler/typescript-context.js";
import { prepareAssemblyScript } from "./emitter/assemblyscript.js";
import { Emitter, type EmitterOptions } from "./emitter/emitter.js";
import { PIPELINE_COMPANION_CATALOG } from "./emitter/pipeline-catalog.js";
import { FunScriptError, toErrorMessage } from "./errors.js";
import { Lexer, type LexerError } from "./lexer/lexer.js";
import { Parser, type ParseError } from "./parser/parser.js";

export {
  TYPE_FEST_DECLARATION,
  TypeScriptCompilationContext,
} from "./compiler/typescript-context.js";

export interface CompileOptions {
  sourcemap?: boolean;
  /** Reject raw TypeScript escapes in FunScript source. */
  noTs?: boolean;
  /** Reject authored references to globalThis. */
  noGlobalThis?: boolean;
  /** Reject authored optional parameters and fields ('?'). */
  noOptional?: boolean;
  /** Enforce bare pipeline stages for known companions instead of redundant Module.method prefixes. */
  barePipelines?: boolean;
  /** Reject deeply nested destructuring patterns exceeding maxDestructureDepth (defaults to 2). */
  noDeepDestructure?: boolean;
  /** Directories governed by the noDeepDestructure policy, relative to policyRoot. */
  noDeepDestructurePaths?: string[];
  /** Maximum destructuring depth allowed (defaults to 2 when noDeepDestructure is active). */
  maxDestructureDepth?: number;
  /** Restrict authored source to Effect ecosystem imports and explicit Effect APIs. */
  effectOnly?: boolean;
  /** Directories governed by the Effect-only policy, relative to policyRoot. */
  effectOnlyDirectories?: string[];
  /** Allow unfinished typed holes ('???') during compilation (defaults to false; holes fail build by default). */
  allowHoles?: boolean;
  policyRoot?: string;
  outputFile?: string;
  context?: TypeScriptCompilationContext;
  /** In-memory source files, keyed by absolute path, for cross-module analysis. */
  virtualSources?: ReadonlyMap<string, string>;
  /** Return compiler pipeline metadata without emitting a TypeScript program. @internal */
  pipelineAnalysisOnly?: boolean;
  /** Absolute source path when the displayed filename is project-relative. */
  sourcePath?: string;
  /** Emit modular subpath imports (e.g. 'effect/Effect', 'effect/Option') instead of barrel imports from 'effect'. */
  modularEffectImports?: boolean;
}

export interface CompileResult {
  source: string;
  ast: Program;
  typescript: string;
  targetExtension: string;
  /** Type-directed pipeline stage resolution produced by the compiler pass. */
  pipelineStageResolutions: ReadonlyMap<
    number,
    import("./emitter/emitter.js").StageResolution
  >;
  /** Inferred input companion for each pipeline stage offset. */
  pipelineStageInputCompanions: ReadonlyMap<number, string>;
  /** Qualified stages whose receiver type allows the equivalent bare form. */
  barePipelineStageResolutions: ReadonlyMap<
    number,
    import("./emitter/emitter.js").StageResolution
  >;
  map?: SourceMap;
  sourcemap?: SourceMap;
}

export class CompilerError extends FunScriptError {
  readonly _tag = "CompilerError";
  constructor(
    public readonly message: string,
    public readonly error: LexerError | ParseError | Error,
    source?: string,
  ) {
    const span = "span" in error ? (error as { span?: Span }).span : undefined;
    super(message, span, source);
    this.name = "CompilerError";
  }
}

/** Reject authored raw TypeScript escapes and banned legacy/unsafe types. */
function validateNoBannedTypes(ast: Program): void {
  walkAst(ast, (node) => {
    if (node.kind === "TypeReferenceNode") {
      const typeName = (node.name as { name?: string })?.name;
      if (typeName === "Any") {
        throw new FunScriptError(
          "The 'Any' type is disabled in FunScript; use 'Unknown' and decode with Schema, or specify a concrete type",
          node.span as Span | undefined,
        );
      }
      if (typeName === "Unit") {
        throw new FunScriptError(
          "The 'Unit' type has been unified to 'Void' in FunScript; use 'Void' instead",
          node.span as Span | undefined,
        );
      }
      if (typeName === "Null") {
        throw new FunScriptError(
          "The 'Null' type is disabled in FunScript; model absence using 'Option<T>' instead",
          node.span as Span | undefined,
        );
      }
      if (typeName === "Undefined") {
        throw new FunScriptError(
          "The 'Undefined' type is disabled in FunScript; model absence using 'Option<T>' instead",
          node.span as Span | undefined,
        );
      }
    }
  });
}

/** Reject unfinished typed holes ('???') unless allowHoles is explicitly enabled. */
function validateNoHoles(ast: Program): void {
  walkAst(ast, (node) => {
    if (node.kind === "TypedHole") {
      const label = (node as { label?: string }).label || "???";
      throw new FunScriptError(
        `Typed hole '${label}' is unfinished code. Implement this expression before building or type-checking.`,
        node.span as Span | undefined,
      );
    }
  });
}

function validateNoTs(ast: Program): void {
  walkAst(ast, (node) => {
    if (
      node.kind === "TsEscapeDeclaration" ||
      node.kind === "TsEscapeExpression" ||
      node.kind === "TsEscapeTypeNode"
    ) {
      throw new FunScriptError(
        "TypeScript escapes are disabled by --no-ts; write this code in FunScript",
        node.span as Span | undefined,
      );
    }
    if (node.kind === "AsDeclaration") {
      throw new FunScriptError(
        "AssemblyScript blocks are disabled by --no-ts; write this code in FunScript",
        node.span as Span | undefined,
      );
    }
  });
}

/** Block globalThis references in authored AST, without matching property names or strings. */
function validateNoGlobalThis(ast: Program): void {
  walkAst(ast, (node, parent, property) => {
    if (
      (node.kind === "MemberExpression" || node.kind === "IndexExpression") &&
      ["window", "self", "global"].includes(
        (node.object as { name?: string } | undefined)?.name ?? "",
      )
    ) {
      const member =
        node.kind === "MemberExpression"
          ? (node.property as { name?: string } | undefined)?.name
          : (
                node.index as
                  | {
                      kind?: string;
                      parts?: { kind?: string; value?: string }[];
                    }
                  | undefined
              )?.kind === "StringLiteral"
            ? (
                node.index as { parts?: { kind?: string; value?: string }[] }
              ).parts
                ?.map((part) =>
                  part.kind === "StringRawPart" ? (part.value ?? "") : "",
                )
                .join("")
            : undefined;
      if (member === "globalThis")
        throw new FunScriptError(
          "globalThis is disabled by project policy; use explicit FunScript imports and interop",
          node.span as Span | undefined,
        );
    }
    const isPropertyName =
      (parent?.kind === "MemberExpression" && property === "property") ||
      (parent?.kind === "FieldEntry" && property === "key") ||
      (parent?.kind === "RecordTypeField" && property === "name") ||
      (parent?.kind === "RecordFieldSchema" && property === "name") ||
      (parent?.kind === "RecordPatternField" &&
        property === "key" &&
        Boolean((parent as { pattern?: unknown }).pattern));
    if (
      node.kind === "Identifier" &&
      node.name === "globalThis" &&
      !isPropertyName
    ) {
      throw new FunScriptError(
        "globalThis is disabled by project policy; use explicit FunScript imports and interop",
        node.span as Span | undefined,
      );
    }
  });
}

/** Block optional parameters and fields ('?') in authored AST when noOptional policy is active. */
function validateNoOptional(ast: Program): void {
  walkAst(ast, (node) => {
    if (node.kind === "Parameter" && node.optional) {
      throw new FunScriptError(
        "Optional parameters ('?') are disabled by project policy; use Option<T> or handle optionality at the TS interop edge",
        node.span as Span | undefined,
      );
    }
    if (node.kind === "RecordTypeField" && node.optional) {
      throw new FunScriptError(
        "Optional record fields ('?') are disabled by project policy; use Option<T> or handle optionality at the TS interop edge",
        node.span as Span | undefined,
      );
    }
    if (node.kind === "RecordFieldSchema" && node.optional) {
      throw new FunScriptError(
        "Optional schema fields ('?') are disabled by project policy; use Option<T> or handle optionality at the TS interop edge",
        node.span as Span | undefined,
      );
    }
  });
}

/** Calculate the structural destructuring depth of a pattern or binding target. */
export function getPatternDepth(
  pattern: Pattern | BindingTarget | undefined | null,
): number {
  if (!pattern) return 0;
  switch (pattern.kind) {
    case "Identifier":
    case "UpperIdentifier":
    case "WildcardPattern":
    case "LiteralPattern":
    case "VariablePattern":
      return 0;
    case "RestPattern":
      return getPatternDepth(pattern.argument);
    case "OrPattern":
      return pattern.patterns.reduce(
        (max, p) => Math.max(max, getPatternDepth(p)),
        0,
      );
    case "ArrayPattern": {
      if (pattern.elements.length === 0) return 0;
      let maxChild = 0;
      for (const el of pattern.elements) {
        if (el) maxChild = Math.max(maxChild, getPatternDepth(el));
      }
      return 1 + maxChild;
    }
    case "RecordPattern": {
      if (pattern.fields.length === 0) return 0;
      let maxChild = 0;
      for (const field of pattern.fields) {
        if (field.pattern) {
          maxChild = Math.max(maxChild, getPatternDepth(field.pattern));
        }
      }
      return 1 + maxChild;
    }
    case "ConstructorPattern": {
      if (pattern.args.length === 0) return 0;
      let maxChild = 0;
      for (const arg of pattern.args) {
        maxChild = Math.max(maxChild, getPatternDepth(arg));
      }
      return 1 + maxChild;
    }
    default:
      return 0;
  }
}

/** Block deeply nested destructuring patterns when noDeepDestructure or maxDestructureDepth is active. */
function validateMaxDestructureDepth(ast: Program, maxDepth: number): void {
  const checkDepth = (
    pattern: Pattern | BindingTarget | undefined | null,
    span?: Span,
  ) => {
    if (!pattern) return;
    const depth = getPatternDepth(pattern);
    if (depth > maxDepth) {
      throw new FunScriptError(
        `Destructuring depth of ${depth} exceeds the maximum allowed depth of ${maxDepth} (configured via 'maxDestructureDepth' / 'noDeepDestructure')`,
        span ?? pattern.span,
      );
    }
  };

  walkAst(ast, (node) => {
    if (node.kind === "BindingDeclaration") {
      checkDepth(node.id as BindingTarget, (node.id as BindingTarget).span);
    } else if (node.kind === "Parameter") {
      checkDepth(node.name as BindingTarget, (node.name as BindingTarget).span);
    } else if (node.kind === "MatchArm") {
      checkDepth(node.pattern as Pattern, (node.pattern as Pattern).span);
    } else if (node.kind === "EffectBindStatement") {
      checkDepth(node.id as BindingTarget, (node.id as BindingTarget).span);
    }
  });
}

/** Block redundant companion prefixes in pipeline stages when barePipelines policy is active. */
function validateBarePipelines(ast: Program): void {
  walkAst(ast, (node) => {
    if (node.kind === "PipelineExpression") {
      const stage = node.right as
        { kind?: string; callee?: { kind?: string } } | undefined;
      let target: {
        object?: { kind?: string; name?: string };
        property?: { kind?: string; name?: string };
        span?: Span;
      } | null = null;
      if (stage?.kind === "MemberExpression") {
        target = stage as {
          object?: { kind?: string; name?: string };
          property?: { kind?: string; name?: string };
          span?: Span;
        };
      } else if (
        stage?.kind === "CallExpression" &&
        stage.callee?.kind === "MemberExpression"
      ) {
        target = stage.callee as {
          object?: { kind?: string; name?: string };
          property?: { kind?: string; name?: string };
          span?: Span;
        };
      }
      if (
        target &&
        target.object?.kind === "UpperIdentifier" &&
        target.property?.kind === "Identifier" &&
        target.object.name &&
        target.property.name
      ) {
        const modName = target.object.name;
        const methodName = target.property.name;
        const catalogEntries = (
          PIPELINE_COMPANION_CATALOG as Record<string, readonly string[]>
        )[modName];
        if (catalogEntries && catalogEntries.includes(methodName)) {
          throw new FunScriptError(
            `Redundant pipeline prefix '${modName}.${methodName}'. FunScript infers the piped companion automatically; use '|> ${methodName}' instead to reduce noise`,
            target.span,
          );
        }
      }
    }
  });
}

/** Conservative source-level Effect ecosystem boundary; this is not a purity proof. */
function validateEffectOnly(
  ast: Program,
  options?: CompileOptions,
  filename = "<anonymous>",
): void {
  const forbiddenGlobals = new Set([
    "globalThis",
    "global",
    "window",
    "self",
    "process",
    "console",
    "fetch",
    "require",
    "eval",
    "Function",
    "Date",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "queueMicrotask",
    "WebSocket",
    "XMLHttpRequest",
    "Bun",
    "Deno",
  ]);
  validateNoTs(ast);
  walkAst(ast, (node, parent, property) => {
    if (
      node.kind === "ImportDeclaration" ||
      node.kind === "ExportFromDeclaration"
    ) {
      const parts =
        (
          node.source as
            { parts?: { kind?: string; value?: string }[] } | undefined
        )?.parts ?? [];
      const name = parts
        .map((part) =>
          part.kind === "StringRawPart" ? (part.value ?? "") : "",
        )
        .join("");
      if (
        !name.startsWith("./") &&
        !name.startsWith("../") &&
        name !== "effect" &&
        !name.startsWith("effect/") &&
        !name.startsWith("@effect/")
      ) {
        throw new FunScriptError(
          `Effect-only policy disallows import '${name}'; use an Effect ecosystem package or a local module`,
          node.span as Span | undefined,
        );
      }
      if (
        (name.startsWith("./") || name.startsWith("../")) &&
        options?.effectOnlyDirectories
      ) {
        const root = options.policyRoot ?? process.cwd();
        const source = options.sourcePath ?? filename;
        const target = path.resolve(
          path.dirname(path.resolve(root, source)),
          name,
        );
        const stem = target.replace(/\.(?:js|jsx|ts|tsx|fun|funx)$/, "");
        if (!isPathPolicyEnabled(options.effectOnlyDirectories, root, target)) {
          throw new FunScriptError(
            `Effect-only local import '${name}' must remain within an Effect-only directory`,
            node.span as Span | undefined,
          );
        }
        const nonFunSources = [
          target,
          `${stem}.js`,
          `${stem}.jsx`,
          `${stem}.ts`,
          `${stem}.tsx`,
          `${stem}.mjs`,
          `${stem}.cjs`,
        ].filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file));
        if (
          nonFunSources.some(
            (file) => fs.existsSync(file) || options.virtualSources?.has(file),
          )
        ) {
          throw new FunScriptError(
            `Effect-only local import '${name}' resolves to a JavaScript or TypeScript file`,
            node.span as Span | undefined,
          );
        }
        const funSources = [
          target,
          `${stem}.fun`,
          `${stem}.funx`,
          path.join(target, "index.fun"),
          path.join(target, "index.funx"),
        ].filter((file) => /\.funx?$/.test(file));
        const resolved = funSources.find(
          (file) => fs.existsSync(file) || options.virtualSources?.has(file),
        );
        if (!resolved)
          throw new FunScriptError(
            `Effect-only local import '${name}' must resolve to a FunScript source file`,
            node.span as Span | undefined,
          );
        if (fs.existsSync(resolved)) {
          const real = fs.realpathSync(resolved);
          const realDirs = options.effectOnlyDirectories.map((directory) => {
            const absolute = path.resolve(root, directory);
            return fs.existsSync(absolute)
              ? fs.realpathSync(absolute)
              : absolute;
          });
          if (
            !/\.funx?$/.test(real) ||
            !isPathPolicyEnabled(realDirs, root, real)
          ) {
            throw new FunScriptError(
              `Effect-only local import '${name}' must resolve to FunScript inside an Effect-only directory`,
              node.span as Span | undefined,
            );
          }
        }
      }
    }
    if (
      node.kind === "JsExpression" ||
      (node.kind === "BindingDeclaration" && node.isJs)
    )
      throw new FunScriptError(
        "Effect-only policy disallows 'js' interop; use Effect ecosystem APIs",
        node.span as Span | undefined,
      );
    if (node.kind === "SchemaDeclaration" && node.isTs)
      throw new FunScriptError(
        "Effect-only policy disallows TypeScript-derived schemas",
        node.span as Span | undefined,
      );
    const isPropertyName =
      (parent?.kind === "MemberExpression" && property === "property") ||
      (parent?.kind === "FieldEntry" && property === "key") ||
      (parent?.kind === "RecordTypeField" && property === "name") ||
      (parent?.kind === "RecordFieldSchema" && property === "name") ||
      (parent?.kind === "RecordPatternField" &&
        property === "key" &&
        Boolean((parent as { pattern?: unknown }).pattern));
    if (
      (node.kind === "Identifier" || node.kind === "UpperIdentifier") &&
      forbiddenGlobals.has(node.name as string) &&
      !isPropertyName
    ) {
      throw new FunScriptError(
        `Effect-only policy disallows '${String(node.name)}'; use an Effect ecosystem API`,
        node.span as Span | undefined,
      );
    }
  });
}

/**
 * Compiles FunScript source code directly to TypeScript code as an Effect.
 */
export const compileString = (
  source: string,
  filename: string = "<anonymous>",
  options?: CompileOptions,
): Effect.Effect<CompileResult, CompilerError> =>
  Effect.flatMap(
    /\bas[ \t]*\{/.test(source)
      ? Effect.flatMap(
          Effect.try({
            try: () => {
              const ast = new Parser(
                new Lexer(source, filename).tokenize(),
                filename,
                source,
              ).parse();
              if (options?.effectOnly)
                validateEffectOnly(ast, options, filename);
              else if (options?.noTs) validateNoTs(ast);
              return ast;
            },
            catch: (error: unknown) =>
              new CompilerError(
                toErrorMessage(error),
                error instanceof Error ? error : new Error(String(error)),
              ),
          }),
          (ast) => {
            const blocks = ast.body.filter(
              (decl) => decl.kind === "AsDeclaration",
            );
            return blocks.length === 0
              ? Effect.succeed(ast)
              : Effect.tryPromise({
                  try: async () => {
                    for (const decl of blocks)
                      await prepareAssemblyScript(decl);
                    return ast;
                  },
                  catch: (error: unknown) =>
                    new CompilerError(
                      toErrorMessage(error),
                      error instanceof Error ? error : new Error(String(error)),
                    ),
                });
          },
        )
      : Effect.succeed(undefined),
    (preparedAst) =>
      Effect.try({
        try: () => {
          // Reuse the AST already parsed while preparing AssemblyScript blocks.
          const ast =
            preparedAst ??
            new Parser(
              new Lexer(source, filename).tokenize(),
              filename,
              source,
            ).parse();

          validateNoBannedTypes(ast);
          if (!options?.allowHoles) validateNoHoles(ast);
          if (options?.effectOnly) validateEffectOnly(ast, options, filename);
          else if (options?.noTs) validateNoTs(ast);
          if (options?.noGlobalThis) validateNoGlobalThis(ast);
          if (options?.noOptional) validateNoOptional(ast);
          if (options?.barePipelines) validateBarePipelines(ast);
          const isDeepDestructureRestricted =
            options?.noDeepDestructure ||
            isPathPolicyEnabled(
              options?.noDeepDestructurePaths,
              options?.policyRoot ?? process.cwd(),
              filename,
            );
          const effectiveMaxDepth =
            options?.maxDestructureDepth ??
            (isDeepDestructureRestricted ? 2 : undefined);
          if (effectiveMaxDepth !== undefined) {
            validateMaxDestructureDepth(ast, effectiveMaxDepth);
          }

          // 3. Emit TypeScript
          const context =
            options?.context ??
            new TypeScriptCompilationContext(options?.sourcePath ?? filename);
          context.setFilename(options?.sourcePath ?? filename);
          const importedRecordContracts = new Map<string, RecordTypeNode>();
          const importedIdentitySchemas = new Set<string>();
          const importedGenericDataSchemas = new Map<string, number>();
          const importedDataSchemas = new Set<string>();
          const importedRecordFunctions = resolveImportedRecordFunctions(
            ast,
            options?.sourcePath ?? filename,
            options?.virtualSources,
            importedRecordContracts,
            importedIdentitySchemas,
            importedGenericDataSchemas,
            importedDataSchemas,
          );
          for (const [name, contract] of resolvePackageRecordContracts(
            ast,
            context,
            importedRecordContracts,
          ))
            importedRecordContracts.set(name, contract);
          if (!options?.pipelineAnalysisOnly) {
            validateNumericComparisons(
              ast,
              source,
              context,
              importedRecordFunctions,
              importedRecordContracts,
              importedGenericDataSchemas,
              importedIdentitySchemas,
              importedDataSchemas,
            );
          }
          const {
            pipelineCompanions,
            stageResolutions,
            stageInputCompanions,
            bareStageResolutions,
            directCallResolutions,
          } = inferPipelineCompanions(
            ast,
            context,
            importedRecordFunctions,
            importedRecordContracts,
            importedGenericDataSchemas,
            importedIdentitySchemas,
            importedDataSchemas,
            options?.pipelineAnalysisOnly,
          );
          if (options?.pipelineAnalysisOnly) {
            return {
              source,
              ast,
              typescript: "",
              targetExtension: filename.endsWith(".funx") ? ".tsx" : ".ts",
              pipelineStageResolutions: stageResolutions,
              pipelineStageInputCompanions: stageInputCompanions,
              barePipelineStageResolutions: bareStageResolutions,
            };
          }
          const importedSchemas = resolveImportedSchemas(ast, source, context);
          const emitterOptions: EmitterOptions = {
            pipelineCompanions,
            stageResolutions,
            directCallResolutions,
            importedSchemas,
            importedRecordFunctions,
            importedRecordContracts,
            importedIdentitySchemas,
            importedGenericDataSchemas,
            importedDataSchemas,
            isJsx: filename.endsWith(".funx"),
            modularEffectImports: options?.modularEffectImports,
            context,
          };
          const optionalResolutions = resolveOptionalArguments(
            ast,
            context,
            emitterOptions,
            options?.sourcePath ?? filename,
            options?.virtualSources,
          );
          emitterOptions.forwardOptionalArguments =
            optionalResolutions.arguments;
          emitterOptions.forwardNullArguments =
            optionalResolutions.nullArguments;
          emitterOptions.forwardOptionalProperties =
            optionalResolutions.properties;
          emitterOptions.forwardNullProperties =
            optionalResolutions.nullProperties;
          const emitter = new Emitter(ast, undefined, emitterOptions);
          const emitted = applyJsInteropNullability(emitter.emit(), context);
          const shebang = source.startsWith("#!")
            ? source.includes("\n")
              ? source.slice(0, source.indexOf("\n") + 1)
              : `${source}\n`
            : "";
          const typescript = shebang ? shebang + emitted : emitted;
          const targetExtension = filename.endsWith(".funx") ? ".tsx" : ".ts";

          const map =
            (options?.sourcemap ?? true)
              ? generateSourceMap(
                  source,
                  filename,
                  typescript,
                  ast,
                  emitterOptions,
                  options?.outputFile,
                )
              : undefined;

          return {
            source,
            ast,
            typescript,
            targetExtension,
            pipelineStageResolutions: stageResolutions,
            pipelineStageInputCompanions: stageInputCompanions,
            barePipelineStageResolutions: bareStageResolutions,
            map,
            sourcemap: map,
          };
        },
        catch: (error: unknown) =>
          new CompilerError(
            toErrorMessage(error),
            error instanceof Error ? error : new Error(String(error)),
            source,
          ),
      }),
  );

/**
 * Parses and checks a FunScript source string.
 */
export const checkString = (
  source: string,
  filename: string = "<anonymous>",
  options?: Pick<
    CompileOptions,
    | "noTs"
    | "noGlobalThis"
    | "noOptional"
    | "barePipelines"
    | "noDeepDestructure"
    | "noDeepDestructurePaths"
    | "maxDestructureDepth"
    | "policyRoot"
    | "effectOnly"
    | "allowHoles"
  >,
): Effect.Effect<Program, CompilerError> =>
  Effect.try({
    try: () => {
      const lexer = new Lexer(source, filename);
      const tokens = lexer.tokenize();
      const parser = new Parser(tokens, filename, source);
      const ast = parser.parse();
      validateNoBannedTypes(ast);
      if (!options?.allowHoles) validateNoHoles(ast);
      if (options?.effectOnly) validateEffectOnly(ast, options, filename);
      else if (options?.noTs) validateNoTs(ast);
      if (options?.noGlobalThis) validateNoGlobalThis(ast);
      if (options?.noOptional) validateNoOptional(ast);
      if (options?.barePipelines) validateBarePipelines(ast);
      const isDeepDestructureRestricted =
        options?.noDeepDestructure ||
        isPathPolicyEnabled(
          options?.noDeepDestructurePaths,
          options?.policyRoot ?? process.cwd(),
          filename,
        );
      const effectiveMaxDepth =
        options?.maxDestructureDepth ??
        (isDeepDestructureRestricted ? 2 : undefined);
      if (effectiveMaxDepth !== undefined) {
        validateMaxDestructureDepth(ast, effectiveMaxDepth);
      }
      return ast;
    },
    catch: (error: unknown) =>
      new CompilerError(
        toErrorMessage(error),
        error instanceof Error ? error : new Error(String(error)),
        source,
      ),
  });
