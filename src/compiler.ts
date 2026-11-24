import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { isPathPolicyEnabled } from "./compiler/project-config.js";
import { prepareAssemblyScript } from "./emitter/assemblyscript.js";
import { Effect } from "effect";
import type { SourceMap } from "magic-string";
import { generateSourceMap } from "./compiler/source-map.js";
import { Lexer, type LexerError } from "./lexer/lexer.js";
import { Parser, type ParseError } from "./parser/parser.js";
import { Emitter, type EmitterOptions } from "./emitter/emitter.js";
import { type Program, type RecordTypeNode } from "./ast/types.js";
import { FunScriptError } from "./errors.js";
import { TypeScriptCompilationContext } from "./compiler/typescript-context.js";
import { validateNumericComparisons } from "./compiler/numeric-comparisons.js";
import { inferPipelineCompanions } from "./compiler/pipeline-companions.js";
import { applyJsInteropNullability } from "./compiler/js-interop-nullability.js";
import { resolveImportedSchemas } from "./compiler/imported-schemas.js";
import {
  resolveProviderSchemas,
  providerDependencies,
} from "./compiler/providers.js";
import { resolveImportedRecordFunctions } from "./compiler/imported-record-functions.js";
import { resolvePackageRecordContracts } from "./compiler/package-record-contracts.js";
import { resolveOptionalArguments } from "./compiler/optional-arguments.js";
import { PIPELINE_COMPANION_CATALOG } from "./emitter/pipeline-catalog.js";
import { loadProjectConfigForFile } from "./compiler/project-config.js";
import { prepareProviderResults } from "./compiler/provider-resolution.js";
import { renderProviderSchema } from "./compiler/provider-schema.js";

export {
  TypeScriptCompilationContext,
  TYPE_FEST_DECLARATION,
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
  /** Restrict authored source to Effect ecosystem imports and explicit Effect APIs. */
  effectOnly?: boolean;
  /** Directories governed by the Effect-only policy, relative to policyRoot. */
  effectOnlyDirectories?: string[];
  policyRoot?: string;
  outputFile?: string;
  context?: TypeScriptCompilationContext;
  /** In-memory source files, keyed by absolute path, for cross-module analysis. */
  virtualSources?: ReadonlyMap<string, string>;
  /** Return compiler pipeline metadata without emitting a TypeScript program. @internal */
  pipelineAnalysisOnly?: boolean;
  /** Absolute source path when the displayed filename is project-relative. */
  sourcePath?: string;
  /** Prepared provider schema expressions and dependency paths. @internal */
  preparedProviderSchemas?: PreparedProviderSchemas;
}

/** Provider output validated and prepared before compiler analysis. @internal */
export interface PreparedProviderSchemas {
  schemas: ReadonlyMap<string, string>;
  dependencies: ReadonlyArray<string>;
}

export interface CompileResult {
  providerDependencies?: string[];
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
  ) {
    const span = "span" in error ? (error as any).span : undefined;
    super(message, span);
    this.name = "CompilerError";
  }
}

/** Reject authored raw TypeScript escapes without inspecting strings or comments. */
function validateNoTs(ast: Program): void {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as Record<string, unknown>;
    if (
      node.kind === "TsEscapeDeclaration" ||
      node.kind === "TsEscapeExpression" ||
      node.kind === "TsEscapeTypeNode"
    ) {
      throw new FunScriptError(
        "TypeScript escapes are disabled by --no-ts; write this code in FunScript",
        node.span as any,
      );
    }
    if (node.kind === "AsDeclaration") {
      throw new FunScriptError(
        "AssemblyScript blocks are disabled by --no-ts; write this code in FunScript",
        node.span as any,
      );
    }
    for (const [key, child] of Object.entries(node))
      if (key !== "span") visit(child);
  };
  visit(ast);
}

/** Block globalThis references in authored AST, without matching property names or strings. */
function validateNoGlobalThis(ast: Program): void {
  const visit = (
    value: unknown,
    parent?: Record<string, unknown>,
    property?: string,
  ): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parent, property);
      return;
    }
    const node = value as Record<string, unknown>;
    if (
      (node.kind === "MemberExpression" || node.kind === "IndexExpression") &&
      ["window", "self", "global"].includes((node.object as any)?.name)
    ) {
      const member =
        node.kind === "MemberExpression"
          ? (node.property as any)?.name
          : (node.index as any)?.kind === "StringLiteral"
            ? (node.index as any).parts
                ?.map((part: any) =>
                  part.kind === "StringRawPart" ? part.value : "",
                )
                .join("")
            : undefined;
      if (member === "globalThis")
        throw new FunScriptError(
          "globalThis is disabled by project policy; use explicit FunScript imports and interop",
          node.span as any,
        );
    }
    const isPropertyName =
      (parent?.kind === "MemberExpression" && property === "property") ||
      (parent?.kind === "FieldEntry" && property === "key") ||
      (parent?.kind === "RecordTypeField" && property === "name") ||
      (parent?.kind === "RecordFieldSchema" && property === "name");
    if (
      node.kind === "Identifier" &&
      node.name === "globalThis" &&
      !isPropertyName
    ) {
      throw new FunScriptError(
        "globalThis is disabled by project policy; use explicit FunScript imports and interop",
        node.span as any,
      );
    }
    for (const [key, child] of Object.entries(node))
      if (key !== "span") visit(child, node, key);
  };
  visit(ast);
}

/** Block optional parameters and fields ('?') in authored AST when noOptional policy is active. */
function validateNoOptional(ast: Program): void {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.kind === "Parameter" && node.optional) {
      throw new FunScriptError(
        "Optional parameters ('?') are disabled by project policy; use Option<T> or handle optionality at the TS interop edge",
        node.span as any,
      );
    }
    if (node.kind === "RecordTypeField" && node.optional) {
      throw new FunScriptError(
        "Optional record fields ('?') are disabled by project policy; use Option<T> or handle optionality at the TS interop edge",
        node.span as any,
      );
    }
    if (node.kind === "RecordFieldSchema" && node.optional) {
      throw new FunScriptError(
        "Optional schema fields ('?') are disabled by project policy; use Option<T> or handle optionality at the TS interop edge",
        node.span as any,
      );
    }
    for (const [key, child] of Object.entries(node))
      if (key !== "span") visit(child);
  };
  visit(ast);
}

/** Block redundant companion prefixes in pipeline stages when barePipelines policy is active. */
function validateBarePipelines(ast: Program): void {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as Record<string, any>;
    if (node.kind === "PipelineExpression") {
      const stage = node.right;
      let target: any = null;
      if (stage?.kind === "MemberExpression") {
        target = stage;
      } else if (
        stage?.kind === "CallExpression" &&
        stage.callee?.kind === "MemberExpression"
      ) {
        target = stage.callee;
      }
      if (
        target &&
        target.object?.kind === "UpperIdentifier" &&
        target.property?.kind === "Identifier"
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
    for (const [key, child] of Object.entries(node))
      if (key !== "span") visit(child);
  };
  visit(ast);
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
  const visit = (
    value: unknown,
    parent?: Record<string, unknown>,
    property?: string,
  ): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parent, property);
      return;
    }
    const node = value as Record<string, any>;
    if (
      node.kind === "ImportDeclaration" ||
      node.kind === "ExportFromDeclaration"
    ) {
      const parts = node.source?.parts ?? [];
      const name = parts
        .map((part: any) => (part.kind === "StringRawPart" ? part.value : ""))
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
          node.span,
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
            node.span,
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
            node.span,
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
            node.span,
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
              node.span,
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
        node.span,
      );
    if (node.kind === "SchemaDeclaration" && node.isTs)
      throw new FunScriptError(
        "Effect-only policy disallows TypeScript-derived schemas",
        node.span,
      );
    const isPropertyName =
      (parent?.kind === "MemberExpression" && property === "property") ||
      (parent?.kind === "FieldEntry" && property === "key") ||
      (parent?.kind === "RecordTypeField" && property === "name") ||
      (parent?.kind === "RecordFieldSchema" && property === "name");
    if (
      (node.kind === "Identifier" || node.kind === "UpperIdentifier") &&
      forbiddenGlobals.has(node.name) &&
      !isPropertyName
    ) {
      throw new FunScriptError(
        `Effect-only policy disallows '${node.name}'; use an Effect ecosystem API`,
        node.span,
      );
    }
    for (const [key, child] of Object.entries(node))
      if (key !== "span") visit(child, node, key);
  };
  validateNoTs(ast);
  visit(ast);
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
            catch: (error: any) => new CompilerError(error.message, error),
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
                  catch: (error: any) =>
                    new CompilerError(error.message, error),
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

          if (options?.effectOnly) validateEffectOnly(ast, options, filename);
          else if (options?.noTs) validateNoTs(ast);
          if (options?.noGlobalThis) validateNoGlobalThis(ast);
          if (options?.noOptional) validateNoOptional(ast);
          if (options?.barePipelines) validateBarePipelines(ast);

          // 3. Emit TypeScript
          const context =
            options?.context ??
            new TypeScriptCompilationContext(options?.sourcePath ?? filename);
          context.setFilename(options?.sourcePath ?? filename);
          const importedSchemas = new Map(
            resolveImportedSchemas(ast, source, context),
          );
          const providerSchemas =
            options?.preparedProviderSchemas?.schemas ??
            resolveProviderSchemas(ast, options?.sourcePath ?? filename);
          for (const [name, schema] of providerSchemas)
            importedSchemas.set(name, schema);
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
              importedSchemas,
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
            importedSchemas,
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
            providerDependencies: options?.preparedProviderSchemas
              ? [...options.preparedProviderSchemas.dependencies]
              : providerDependencies(ast, options?.sourcePath ?? filename),
            typescript,
            targetExtension,
            pipelineStageResolutions: stageResolutions,
            pipelineStageInputCompanions: stageInputCompanions,
            barePipelineStageResolutions: bareStageResolutions,
            map,
            sourcemap: map,
          };
        },
        catch: (error: any) => new CompilerError(error.message, error),
      }),
  );

/** Compile source after invoking explicitly registered async database providers. */
export const compileStringAsync = (
  source: string,
  filename: string = "<anonymous>",
  options?: CompileOptions,
): Effect.Effect<CompileResult, CompilerError> => {
  const sourcePath = options?.sourcePath ?? filename;
  const configured = loadProjectConfigForFile(sourcePath);
  if (!configured.config.providers?.size)
    return compileString(source, filename, options);
  return Effect.flatMap(
    Effect.tryPromise({
      try: async () => {
        const ast = new Parser(
          new Lexer(source, filename).tokenize(),
          filename,
          source,
        ).parse();
        const declarations = ast.body.some((item) => {
          const decl =
            item.kind === "ExportDeclaration" ? item.declaration : item;
          return decl.kind === "DatabaseDeclaration";
        });
        if (!declarations) return undefined;
        const require = createRequire(
          path.join(configured.root, "package.json"),
        );
        const prepared = await prepareProviderResults(
          ast,
          sourcePath,
          configured.config.providers!,
          configured.config.providerRoots ?? [],
          async (specifier) =>
            import(pathToFileURL(require.resolve(specifier)).href),
        );
        const schemas = new Map(
          prepared.results.map(({ name, result }) => [
            name,
            renderProviderSchema(result.schema),
          ]),
        );
        const dependencies = prepared.dependencies.flatMap((dependency) =>
          dependency.kind === "file" ? [dependency.path] : [],
        );
        return { schemas, dependencies };
      },
      catch: (error: any) => {
        const declaration = error?.declaration;
        return new CompilerError(error.message, declaration ?? error);
      },
    }),
    (prepared) =>
      compileString(
        source,
        filename,
        prepared ? { ...options, preparedProviderSchemas: prepared } : options,
      ),
  );
};

/**
 * Parses and checks a FunScript source string.
 */
export const checkString = (
  source: string,
  filename: string = "<anonymous>",
  options?: Pick<
    CompileOptions,
    "noTs" | "noGlobalThis" | "noOptional" | "barePipelines" | "effectOnly"
  >,
): Effect.Effect<Program, CompilerError> =>
  Effect.try({
    try: () => {
      const lexer = new Lexer(source, filename);
      const tokens = lexer.tokenize();
      const parser = new Parser(tokens, filename, source);
      const ast = parser.parse();
      if (options?.effectOnly) validateEffectOnly(ast, options, filename);
      else if (options?.noTs) validateNoTs(ast);
      if (options?.noGlobalThis) validateNoGlobalThis(ast);
      if (options?.noOptional) validateNoOptional(ast);
      if (options?.barePipelines) validateBarePipelines(ast);
      return ast;
    },
    catch: (error: any) => new CompilerError(error.message, error),
  });
