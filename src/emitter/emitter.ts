import { FunScriptError } from "../errors.js";
import { renderImport } from "./imports.js";
import { isRecordContract, recordContractType, RECORD_CONTRACT_BRAND } from "../compiler/record-contracts.js";
import {
  Program,
  TopLevelDeclaration,
  ImportDeclaration,
  ExportDeclaration,
  ExportDefaultDeclaration,
  BindingDeclaration,
  BindingTarget,
  SchemaDeclaration,
  RecordSchema,
  TaggedUnionSchema,
  RefinementSchema,
  TypeSignatureSchema,
  TsDerivedSchema,
  ErrorDeclaration,
  ServiceDeclaration,
  Expression,
  Literal,
  NumberLiteral,
  StringLiteral,
  TemplateLiteral,
  TaggedTemplateExpression,
  BooleanLiteral,
  Identifier,
  UpperIdentifier,
  Placeholder,
  TypedHole,
  PipelineExpression,
  BinaryExpression,
  UnaryExpression,
  CallExpression,
  MemberExpression,
  IndexExpression,
  RecordExpression,
  DotPathEntry,
  ArrayExpression,
  FunctionExpression,
  FunctionBody,
  BlockStatement,
  Statement,
  AssignmentStatement,
  ExpressionStatement,
  ReturnStatement,
  WhenStatement,
  MutBlockExpression,
  MatchExpression,
  MatchArm,
  Pattern,
  ConstructorPattern,
  RecordPattern,
  ArrayPattern,
  RestPattern,
  OrPattern,
  EffectBlockExpression,
  EffectStatement,
  EffectBindStatement,
  EffectDiscardStatement,
  TypeNode,
  TypeReferenceNode,
  TypeParameter,
  FunctionTypeNode,
  EffectTypeNode,
  IntersectionTypeNode,
  TsEscapeDeclaration,
  JsExpression,
  TsEscapeExpression,
  TsEscapeTypeNode,
  JSXElement,
  JSXSelfClosingElement,
  JSXOpeningElement,
  JSXClosingElement,
  JSXAttribute,
  JSXExpressionContainer,
  JSXText,
  JSXChild,
  JSXTagName,
} from "../ast/types.js";
import {
  EFFECT_PIPELINE_COMPATIBILITY_ALIASES,
  PIPELINE_COMPANION_CATALOG,
  pipelineCompanionCandidates,
  type PipelineCompanionModule,
} from "./pipeline-catalog.js";

export interface StageResolution {
  module: string;
  method?: string;
  isComparison?: boolean;
}

export interface EmitterOptions {
  /** TypeScript-directed companion facts keyed by the pipeline source offset. */
  pipelineCompanions?: ReadonlyMap<number, PipelineCompanionModule>;
  /** Stage resolutions keyed by pipeline stage offset. */
  stageResolutions?: ReadonlyMap<number, StageResolution>;
  /** Direct call resolutions keyed by call expression offset. */
  directCallResolutions?: ReadonlyMap<number, StageResolution>;
  /** Used only for the checker pre-pass, whose unresolved stage names are intentional. */
  allowAmbiguousPipeline?: boolean;
  /** Wrap pipeline sources so the checker can locate their exact inferred type. */
  markPipelineSources?: boolean;
  /** Wrap native comparison operands so the checker can enforce number-only use. */
  markNumericComparisonOperands?: boolean;
  /** Pre-resolved Effect schema expressions for imported data types keyed by schema name. */
  importedSchemas?: ReadonlyMap<string, string>;
  /** Direct imported FunScript functions with verified optional-record parameters. */
  importedRecordFunctions?: ReadonlyMap<string, ReadonlySet<number>>;
  importedRecordContracts?: ReadonlyMap<string, import("../ast/types.js").RecordTypeNode>;
  /** Whether the output is `.tsx`; generic arrows need a comma there. */
  isJsx?: boolean;
}

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

export const EFFECT_MODULE_NAMES = new Set([
  "Array",
  "Chunk",
  "Context",
  "Data",
  "DateTime",
  "Duration",
  "Effect",
  "Equal",
  "HashMap",
  "HashSet",
  "Layer",
  "Number",
  "Option",
  "Order",
  "Record",
  "Result",
  "Schedule",
  "Schema",
  "Stream",
  "String",
  "pipe",
]);

const BANNED_INSTANCE_METHODS = new Map<string, { category: string; replacement: string; pipeline: string }>([
  // Array methods
  ["map", { category: "array", replacement: "Array.map", pipeline: "|> Array.map(...)" }],
  ["filter", { category: "array", replacement: "Array.filter", pipeline: "|> Array.filter(...)" }],
  ["reduce", { category: "array", replacement: "Array.reduce", pipeline: "|> Array.reduce(...)" }],
  ["reduceRight", { category: "array", replacement: "Array.reduceRight", pipeline: "|> Array.reduceRight(...)" }],
  ["flatMap", { category: "array", replacement: "Array.flatMap", pipeline: "|> Array.flatMap(...)" }],
  ["flat", { category: "array", replacement: "Array.flatten", pipeline: "|> Array.flatten" }],
  ["find", { category: "array", replacement: "Array.findFirst", pipeline: "|> Array.findFirst(...)" }],
  ["findIndex", { category: "array", replacement: "Array.findFirstIndex", pipeline: "|> Array.findFirstIndex(...)" }],
  ["findLast", { category: "array", replacement: "Array.findLast", pipeline: "|> Array.findLast(...)" }],
  ["findLastIndex", { category: "array", replacement: "Array.findLastIndex", pipeline: "|> Array.findLastIndex(...)" }],
  ["some", { category: "array", replacement: "Array.some", pipeline: "|> Array.some(...)" }],
  ["every", { category: "array", replacement: "Array.every", pipeline: "|> Array.every(...)" }],
  ["sort", { category: "array", replacement: "Array.sort", pipeline: "|> Array.sort(...)" }],
  ["reverse", { category: "array", replacement: "Array.reverse", pipeline: "|> Array.reverse" }],
  ["push", { category: "array", replacement: "Array.append", pipeline: "|> Array.append(...)" }],
  ["pop", { category: "array", replacement: "Array.unappend", pipeline: "|> Array.unappend" }],
  ["shift", { category: "array", replacement: "Array.unprepend", pipeline: "|> Array.unprepend" }],
  ["unshift", { category: "array", replacement: "Array.prepend", pipeline: "|> Array.prepend(...)" }],
  ["splice", { category: "array", replacement: "Array.remove / Array.modify", pipeline: "Array.remove(...)" }],

  // String methods
  ["trim", { category: "string", replacement: "String.trim", pipeline: "|> String.trim" }],
  ["trimStart", { category: "string", replacement: "String.trimStart", pipeline: "|> String.trimStart" }],
  ["trimEnd", { category: "string", replacement: "String.trimEnd", pipeline: "|> String.trimEnd" }],
  ["toLowerCase", { category: "string", replacement: "String.toLowerCase", pipeline: "|> String.toLowerCase" }],
  ["toUpperCase", { category: "string", replacement: "String.toUpperCase", pipeline: "|> String.toUpperCase" }],
  ["toLocaleLowerCase", { category: "string", replacement: "String.toLocaleLowerCase", pipeline: "|> String.toLocaleLowerCase" }],
  ["toLocaleUpperCase", { category: "string", replacement: "String.toLocaleUpperCase", pipeline: "|> String.toLocaleUpperCase" }],
  ["startsWith", { category: "string", replacement: "String.startsWith", pipeline: "|> String.startsWith(...)" }],
  ["endsWith", { category: "string", replacement: "String.endsWith", pipeline: "|> String.endsWith(...)" }],
  ["split", { category: "string", replacement: "String.split", pipeline: "|> String.split(...)" }],
  ["replace", { category: "string", replacement: "String.replace", pipeline: "|> String.replace(...)" }],
  ["replaceAll", { category: "string", replacement: "String.replaceAll", pipeline: "|> String.replaceAll(...)" }],
  ["padStart", { category: "string", replacement: "String.padStart", pipeline: "|> String.padStart(...)" }],
  ["padEnd", { category: "string", replacement: "String.padEnd", pipeline: "|> String.padEnd(...)" }],
  ["repeat", { category: "string", replacement: "String.repeat", pipeline: "|> String.repeat(...)" }],

  // Collection mutation methods
  ["add", { category: "collection", replacement: "HashSet.add", pipeline: "|> HashSet.add(...)" }],
  ["clear", { category: "collection", replacement: "HashMap.empty() / HashSet.empty()", pipeline: "HashMap.empty()" }],
  ["delete", { category: "collection", replacement: "HashMap.remove / Record.remove", pipeline: "|> HashMap.remove(...)" }],
  ["set", { category: "collection", replacement: "HashMap.set / Record.set", pipeline: "|> HashMap.set(...)" }],

  // Date mutation methods
  ["setFullYear", { category: "date", replacement: "DateTime.*", pipeline: "|> DateTime.*" }],
  ["setMonth", { category: "date", replacement: "DateTime.*", pipeline: "|> DateTime.*" }],
  ["setDate", { category: "date", replacement: "DateTime.*", pipeline: "|> DateTime.*" }],
  ["setHours", { category: "date", replacement: "DateTime.*", pipeline: "|> DateTime.*" }],
  ["setMinutes", { category: "date", replacement: "DateTime.*", pipeline: "|> DateTime.*" }],
  ["setSeconds", { category: "date", replacement: "DateTime.*", pipeline: "|> DateTime.*" }],
  ["setTime", { category: "date", replacement: "DateTime.*", pipeline: "|> DateTime.*" }],
  ["setMilliseconds", { category: "date", replacement: "DateTime.*", pipeline: "|> DateTime.*" }],
]);

const BANNED_OBJECT_STATIC_METHODS = new Map<string, string>([
  ["keys", "Record.keys(...)"],
  ["values", "Record.values(...)"],
  ["entries", "Record.toEntries(...)"],
  ["fromEntries", "Record.fromEntries(...)"],
  ["assign", "Record.union(...) or object spread '{ ...a, ...b }'"],
  ["freeze", "plain record literals '{ ... }' (FunScript records are already immutable)"],
  ["hasOwn", "Record.has(...)"],
]);

function getRootCalleeName(node: Expression): string | null {
  if (node.kind === "Identifier" || node.kind === "UpperIdentifier") {
    return node.name;
  }
  if (node.kind === "MemberExpression") {
    return getRootCalleeName(node.object);
  }
  if (node.kind === "CallExpression") {
    return getRootCalleeName(node.callee);
  }
  return null;
}

export function isEffectModule(moduleName: string): boolean {
  return EFFECT_MODULE_NAMES.has(moduleName);
}

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

const EFFECT_V4_MEMBER_RENAMES: Readonly<Record<string, string>> = {
  ...EFFECT_PIPELINE_COMPATIBILITY_ALIASES,
  fork: "forkChild",
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

const PRIMITIVE_TYPES: Readonly<Record<string, string>> = {
  String: "string",
  Number: "number",
  Boolean: "boolean",
  Void: "void",
  Unit: "void",
  Unknown: "unknown",
  Any: "any",
  Null: "null",
  Undefined: "undefined",
  Never: "never",
};

const AUTO_NEW_CONSTRUCTORS = new Set([
  "Set",
  "Map",
  "WeakSet",
  "WeakMap",
  "Date",
  "URL",
  "URLSearchParams",
  "FormData",
  "Headers",
  "Request",
  "Response",
  "AbortController",
  "Blob",
  "File",
]);

const EFFECT_BUILTIN_MODULES = new Set([
  "Console",
  "Effect",
  "Random",
  "Clock",
  "DateTime",
  "Schedule",
  "Array",
  "Option",
  "Schema",
  "Queue",
  "Ref",
  "Fiber",
  "Context",
  "Layer",
  "String",
  "Number",
  "Record",
  "Duration",
  "HashMap",
  "HashSet",
  "Result",
  "Struct",
  "Brand",
]);

type RecordFieldInfo = { optional: boolean; defaultBinding?: string; fields?: Map<string, RecordFieldInfo> };

function emitPropertyKey(name: string): string {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

export class Emitter {
  private effectImports = new Set<string>();
  private parameterScopes: Array<Map<string, boolean>> = [];
  private recordScopes: Array<Map<string, Map<string, RecordFieldInfo> | undefined>> = [];
  private userEffectBindings = new Set<string>();
  private effectModuleBindings = new Set<string>();
  private userEsToolkitBindings = new Set<string>();
  private userImportBindings = new Set<string>();
  private esToolkitImports = new Set<string>();
  private needsTsPattern = false;
  private needsMutative = false;
  private needsReferenceEquality = false;
  private needsJsInterop = false;
  private needsDecodeUnknown = false;
  private needsFromNullishOrElse = false;
  private needsFromNullishOr = false;
  private needsOptionTry = false;
  private primitiveIdentifiers = new Set<string>();
  private currentPlaceholderParam: string | null = null;
  private bindings = new Map<string, BindingDeclaration>();
  private tryContextDepth = 0;

  private declaredTypeNames = new Set<string>();
  private runtimeSchemaNames = new Set<string>();
  private inPipelineStage = false;
  private recordContracts = new Map<string, import("../ast/types.js").RecordTypeNode>();

  constructor(private program?: Program, contextProgram?: Program, private options: EmitterOptions = {}) {
    for (const [name, contract] of options.importedRecordContracts ?? []) this.recordContracts.set(name, contract);
    // Source-map emission renders declarations individually, but resolution
    // still needs the bindings from the complete source program.
    const allItems = (contextProgram ?? program)?.body ?? [];
    for (const item of allItems) {
      const decl = item.kind === "ExportDeclaration" ? item.declaration : item;
      if (item.kind === "ImportDeclaration") {
        if (!item.isTypeOnly) {
          for (const spec of item.specifiers) {
            if (!spec.isTypeOnly) this.userImportBindings.add(spec.local.name);
          }
          if (item.namespaceBinding) this.userImportBindings.add(item.namespaceBinding.name);
        }
      }
      if (item.kind === "ImportDeclaration" && item.source.raw === '"effect"') {
        for (const spec of item.specifiers) this.userEffectBindings.add(spec.local.name);
      }
      if (item.kind === "ImportDeclaration" && item.source.raw === '"es-toolkit"') {
        for (const spec of item.specifiers) this.userEsToolkitBindings.add(spec.local.name);
      }
      if (item.kind === "ImportDeclaration" && /^"effect(?:\/|\")/.test(item.source.raw)) {
        for (const spec of item.specifiers) this.effectModuleBindings.add(spec.local.name);
        if (item.namespaceBinding) {
          this.effectModuleBindings.add(item.namespaceBinding.name);
          if (item.source.raw === `"effect/${item.namespaceBinding.name}"`) {
            this.userEffectBindings.add(item.namespaceBinding.name);
          }
        }
      }
      if (
        decl.kind === "SchemaDeclaration" ||
        decl.kind === "ErrorDeclaration" ||
        decl.kind === "ServiceDeclaration"
      ) {
        this.declaredTypeNames.add(decl.id.name);
      }
      if (decl.kind === "BindingDeclaration" && "name" in decl.id) this.bindings.set(decl.id.name, decl);
    }

    const staticTypeNames = new Set<string>();
    for (const [name] of this.recordContracts) staticTypeNames.add(name);
    for (const item of allItems) {
      const decl = item.kind === "ExportDeclaration" ? item.declaration : item;
      if (decl.kind === "SchemaDeclaration" && decl.body.kind === "TypeSignatureSchema") {
        staticTypeNames.add(decl.id.name);
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of allItems) {
        const decl = item.kind === "ExportDeclaration" ? item.declaration : item;
        if (decl.kind === "SchemaDeclaration" && decl.body.kind === "RecordSchema" && !staticTypeNames.has(decl.id.name)) {
          if (isRecordContract(decl.body, staticTypeNames)) {
            staticTypeNames.add(decl.id.name);
            changed = true;
          }
        }
      }
    }

    for (const item of allItems) {
      const decl = item.kind === "ExportDeclaration" ? item.declaration : item;
      if (decl.kind === "SchemaDeclaration") {
        if (decl.body.kind === "RecordSchema" && staticTypeNames.has(decl.id.name)) {
          this.recordContracts.set(decl.id.name, recordContractType(decl.body));
        } else if (
          (decl.body.kind === "RecordSchema" && !staticTypeNames.has(decl.id.name)) ||
          decl.body.kind === "StructuralUnionSchema" ||
          decl.body.kind === "RefinementSchema" ||
          decl.body.kind === "TsDerivedSchema" ||
          decl.body.kind === "ImportedTsSchema"
        ) {
          this.runtimeSchemaNames.add(decl.id.name);
        }
      }
    }
  }

  public emit(): string {
    let bodyCode = "";

    if (this.program) {
      for (const decl of this.program.body) {
        bodyCode += this.emitTopLevelDeclaration(decl) + "\n\n";
      }
    }

    // Generate header imports
    let header = "";
    const generatedEffectImports = Array.from(this.effectImports).filter((name) => !this.userEffectBindings.has(name));
    if (generatedEffectImports.length > 0) {
      const sorted = generatedEffectImports.sort().join(", ");
      header += `import { ${sorted} } from "effect";\n`;
    }
    const generatedEsToolkitImports = Array.from(this.esToolkitImports)
      .filter((name) => !this.userEsToolkitBindings.has(name))
      .map((name) => (name === "slug" ? "kebabCase as slug" : name))
      .sort((a, b) => a.localeCompare(b));
    if (generatedEsToolkitImports.length > 0) {
      header += `import { ${generatedEsToolkitImports.join(", ")} } from "es-toolkit";\n`;
    }
    if (this.needsTsPattern) {
      header += `import { match, P } from "ts-pattern";\n`;
    }
    if (this.needsMutative) {
      header += `import { create } from "mutative";\n`;
    }
    if (this.needsReferenceEquality) {
      header += `const referenceEquals = <T extends object>(left: T, right: T): boolean => left === right;\n`;
    }
    if (this.needsJsInterop) {
      header += `class JsInteropError extends Error {\n  readonly _tag = "JsInteropError" as const;\n  readonly cause: unknown;\n  constructor(cause: unknown) {\n    super("Native JavaScript interop failed");\n    this.name = "JsInteropError";\n    this.cause = cause;\n  }\n}\n`;
      header += `function __funscriptJs<A>(thunk: () => Promise<A>, nullable: true): Effect.Effect<Option.Option<NonNullable<A>>, JsInteropError>;\n`;
      header += `function __funscriptJs<A>(thunk: () => Promise<A>, nullable: false): Effect.Effect<A, JsInteropError>;\n`;
      header += `function __funscriptJs<A>(thunk: () => Promise<A>, nullable: "unknown"): Effect.Effect<Option.Option<unknown>, JsInteropError>;\n`;
      header += `function __funscriptJs<A>(thunk: () => Promise<A>, nullable: boolean | "unknown"): Effect.Effect<A | Option.Option<NonNullable<A>> | Option.Option<unknown>, JsInteropError> {\n  const effect = Effect.tryPromise({ try: thunk, catch: (cause) => new JsInteropError(cause) });\n  return nullable === false ? effect : Effect.map(effect, Option.fromNullishOr);\n}\n`;
    }
    if (this.needsDecodeUnknown) {
      header += `declare module "effect" {\n  namespace Schema {\n    export const decodeUnknown: typeof Schema.decodeUnknownEffect;\n  }\n}\n`;
    }
    if (this.needsFromNullishOrElse) {
      header += `function fromNullishOrElse<A, B>(value: A | null | undefined, onNone: B): NonNullable<A> | B;\n`;
      header += `function fromNullishOrElse<B>(onNone: B): <A>(value: A | null | undefined) => NonNullable<A> | B;\n`;
      header += `function fromNullishOrElse(...args: unknown[]): unknown {\n  if (args.length === 1) { const onNone = args[0]; return (value: unknown) => fromNullishOrElse(value, onNone); }\n  let [value, onNone] = args;\n  while (value !== null && value !== undefined && typeof value === "object" && "_tag" in value) {\n    const candidate = value as { readonly _tag: string; readonly value?: unknown };\n    if (candidate._tag === "Some") value = candidate.value;\n    else if (candidate._tag === "None") return onNone;\n    else break;\n  }\n  if (value !== null && value !== undefined) return value;\n  return onNone;\n}\n`;
    }
    if (this.needsFromNullishOr) {
      this.effectImports.add("Option");
      header += `function fromNullishOr<A>(value: A): A extends import("effect").Option.Option<any> ? A : import("effect").Option.Option<NonNullable<A>> {\n  if (Option.isOption(value)) return value as any;\n  return Option.fromNullishOr(value) as any;\n}\n`;
    }
    if (this.needsOptionTry) {
      this.effectImports.add("Option");
      header += `function optionTry<A>(thunk: () => A): import("effect").Option.Option<NonNullable<A>> {\n  try {\n    return Option.fromNullishOr(thunk()) as any;\n  } catch {\n    return Option.none();\n  }\n}\n`;
    }

    if (header.length > 0) {
      header += "\n";
    }

    return header + bodyCode.trim() + "\n";
  }

  private emitTopLevelDeclaration(decl: TopLevelDeclaration, isExport = false): string {
    switch (decl.kind) {
      case "ImportDeclaration":
        return this.emitImportDeclaration(decl);
      case "ExportDeclaration":
        return this.emitTopLevelDeclaration(decl.declaration, true);
      case "ExportDefaultDeclaration":
        return `export default ${this.emitExpression(decl.expression)};`;
      case "SchemaDeclaration":
        return this.emitSchemaDeclaration(decl, isExport);
      case "ErrorDeclaration":
        return this.emitErrorDeclaration(decl, isExport);
      case "ServiceDeclaration":
        return this.emitServiceDeclaration(decl, isExport);
      case "BindingDeclaration":
        return this.emitBindingDeclaration(decl, isExport);
      case "WhenStatement":
        return this.emitWhenStatement(decl);
      case "TsEscapeDeclaration":
        return decl.code + "\n";
    }
  }

  private emitImportDeclaration(decl: ImportDeclaration): string {
    return renderImport(decl);
  }

  private emitSchemaDeclaration(decl: SchemaDeclaration, isExport: boolean): string {
    const name = decl.id.name;
    const exp = isExport ? "export " : "";

    if (decl.typeParams?.length && decl.body.kind !== "TypeSignatureSchema" && !(decl.body.kind === "RecordSchema" && this.recordContracts.has(name))) {
      throw new FunScriptError("Generic runtime schemas are not supported yet; use a TypeScript type alias", decl.span);
    }

    switch (decl.body.kind) {
      case "RecordSchema": {
        if (this.recordContracts.has(name)) {
          const brand = `${RECORD_CONTRACT_BRAND}$${name}`;
          const typeParamsStr = this.emitTypeParameters(decl.typeParams);
          return `declare const ${brand}: unique symbol;\n${exp}type ${name}${typeParamsStr} = ${this.emitTypeNode(recordContractType(decl.body))} & { readonly [${brand}]?: never };`;
        }
        this.effectImports.add("Schema");
        const schemaFields = decl.body.fields
          .map((f) => {
            const fieldKey = emitPropertyKey(f.name.name);
            const schema = this.emitSchemaTypeField(f.typeAnnotation);
            if (f.optional) return `  ${fieldKey}: Schema.OptionFromOptional(${schema})`;
            if (!f.defaultValue) return `  ${fieldKey}: ${schema}`;
            this.effectImports.add("Effect");
            return `  ${fieldKey}: ${schema}.pipe(Schema.withDecodingDefaultType(Effect.sync(() => ${this.emitExpression(f.defaultValue!)})))`;
          })
          .join(",\n");
        return `${exp}const ${name} = Schema.Struct({\n${schemaFields}\n});\n${exp}type ${name} = typeof ${name}.Type;\n${exp}const ${name}FromUnknown = (input: unknown): ${name} => Schema.decodeUnknownSync(${name})(input);`;
      }
      case "TaggedUnionSchema": {
        this.effectImports.add("Data");
        const typeVariants = decl.body.variants
          .map((v) => {
            if (v.fields.length === 0) {
              return `  ${v.name.name}: {}`;
            }
            const fields = v.fields.map((f) => `readonly ${f.name.name}: ${this.emitTypeNode(f.typeAnnotation)}`).join("; ");
            return `  ${v.name.name}: { ${fields} }`;
          })
          .join(";\n");

        const constructors = decl.body.variants
          .map((v) => {
            if (v.fields.length === 0) {
              return `${exp}const ${v.name.name}: ${name} = $${name}.${v.name.name}();`;
            }
            const params = v.fields.map((f) => `${f.name.name}: ${this.emitTypeNode(f.typeAnnotation)}`).join(", ");
            const args = v.fields.map((f) => f.name.name).join(", ");
            return `${exp}const ${v.name.name} = (${params}): ${name} => $${name}.${v.name.name}({ ${args} });`;
          })
          .join("\n");

        return `${exp}type ${name} = Data.TaggedEnum<{\n${typeVariants}\n}>;\nconst $${name} = Data.taggedEnum<${name}>();\n${constructors}`;
      }
      case "StructuralUnionSchema": {
        this.effectImports.add("Schema");
        const members = decl.body.members.map((member) => this.emitSchemaTypeField(member)).join(", ");
        return `${exp}const ${name} = Schema.Union([${members}]);\n${exp}type ${name} = typeof ${name}.Type;\n${exp}const ${name}FromUnknown = (input: unknown): ${name} => Schema.decodeUnknownSync(${name})(input);`;
      }
      case "RefinementSchema": {
        const stages = this.flattenPipelineStages(decl.body.refinement);
        const brands = this.extractBrandNames(stages);

        if (brands.length > 0) {
          this.effectImports.add("Schema");
          this.effectImports.add("Brand");
          const baseSchema = this.emitSchemaTypeField(decl.body.baseType);
          const emittedStages = stages.map((s) => this.emitRefinementStage(s));

          const baseTypeName =
            decl.body.baseType.kind === "TypeReferenceNode" && decl.body.baseType.name.name === "Int"
              ? "number"
              : this.emitTypeNode(decl.body.baseType);

          const brandTypeStr = brands.map((b) => `Brand.Brand<${JSON.stringify(b)}>`).join(" & ");
          const typeDef = `${baseTypeName} & ${brandTypeStr}`;

          return `${exp}const ${name} = ${baseSchema}.pipe(${emittedStages.join(", ")});\n${exp}type ${name} = ${typeDef};\n${exp}const ${name}FromUnknown = (input: unknown): ${name} => Schema.decodeUnknownSync(${name})(input);`;
        }

        this.effectImports.add("pipe");
        this.effectImports.add("Schema");
        return `${exp}const ${name} = pipe(${this.emitSchemaTypeField(decl.body.baseType)}, ${this.emitExpression(decl.body.refinement)});\n${exp}type ${name} = typeof ${name}.Type;\n${exp}const ${name}FromUnknown = (input: unknown): ${name} => Schema.decodeUnknownSync(${name})(input);`;
      }
      case "TypeSignatureSchema": {
        return `${exp}type ${name}${this.emitTypeParameters(decl.typeParams)} = ${this.emitTypeNode(decl.body.signature)};`;
      }
      case "TsDerivedSchema": {
        this.effectImports.add("Schema");
        let schemaExpr: string;
        const targetType = decl.body.targetType;
        if (targetType.kind === "TypeReferenceNode" && this.options.importedSchemas?.has(decl.id.name)) {
          schemaExpr = this.options.importedSchemas.get(decl.id.name)!;
        } else if (
          targetType.kind === "TypeReferenceNode" &&
          !PRIMITIVE_TYPES[targetType.name.name] &&
          targetType.name.name !== "Duration" &&
          targetType.name.name !== "UUID" &&
          !this.declaredTypeNames.has(targetType.name.name) &&
          targetType.name.name !== "Option" &&
          targetType.name.name !== "Array" &&
          targetType.name.name !== "Record"
        ) {
          schemaExpr = this.options.importedSchemas?.get(decl.id.name) ?? `(Schema.Unknown as unknown as Schema.Codec<${this.emitTypeNode(targetType)}>)`;
        } else {
          schemaExpr = this.options.importedSchemas?.get(decl.id.name) ?? this.emitSchemaTypeField(targetType);
        }
        return `${exp}const ${name} = ${schemaExpr};\n${exp}type ${name} = typeof ${name}.Type;\n${exp}const ${name}FromUnknown = (input: unknown): ${name} => Schema.decodeUnknownSync(${name})(input);`;
      }
      case "ImportedTsSchema": {
        this.effectImports.add("Schema");
        const schemaExpr = this.options.importedSchemas?.get(decl.id.name) ?? `(Schema.Unknown as unknown as Schema.Codec<${this.emitTypeNode(decl.body.typeNode)}>)`;
        return `${exp}const ${name} = ${schemaExpr};\n${exp}type ${name} = typeof ${name}.Type;\n${exp}const ${name}FromUnknown = (input: unknown): ${name} => Schema.decodeUnknownSync(${name})(input);`;
      }
    }
  }

  private emitSchemaTypeField(typeNode: TypeNode): string {
    if (typeNode.kind === "QualifiedTypeReferenceNode" || typeNode.kind === "TypeQueryNode" || typeNode.kind === "IndexedAccessTypeNode") {
      this.effectImports.add("Schema");
      return `(Schema.Unknown as unknown as Schema.Codec<${this.emitTypeNode(typeNode)}>)`;
    }
    if (typeNode.kind === "ParenthesizedTypeNode") {
      return this.emitSchemaTypeField(typeNode.typeNode);
    }
    this.effectImports.add("Schema");
    if (typeNode.kind === "LiteralTypeNode") return `Schema.Literal(${JSON.stringify(typeNode.value)})`;
    if (typeNode.kind === "FunctionTypeNode" || typeNode.kind === "EffectTypeNode") {
      throw new FunScriptError("Runtime schema fields cannot validate function or Effect types; use a separate type or an explicit schema", typeNode.span);
    }
    if (typeNode.kind === "RecordTypeNode") {
      const inner = typeNode.fields
        .map((f) => {
          if (f.defaultValue) throw new FunScriptError("Nested schema field defaults are not supported yet", f.span);
          const schema = this.emitSchemaTypeField(f.typeAnnotation);
          return `  ${f.name.name}: ${f.optional ? `Schema.OptionFromOptional(${schema})` : schema}`;
        })
        .join(",\n");
      return `Schema.Struct({\n${inner}\n})`;
    }
    if (typeNode.kind === "ArrayTypeNode") {
      return `Schema.Array(${this.emitSchemaTypeField(typeNode.elementType)})`;
    }
    if (typeNode.kind === "UnionTypeNode") {
      return `Schema.Union([${typeNode.types.map((type) => this.emitSchemaTypeField(type)).join(", ")}])`;
    }
    if (typeNode.kind === "TypeReferenceNode") {
      const tName = typeNode.name.name;
      if (tName === "SchemaInput" && !this.declaredTypeNames.has(tName)) {
        throw new Error("SchemaInput is a static input type, not a runtime schema; use the schema itself for validation");
      }
      if (PRIMITIVE_TYPES[tName] || tName === "Duration") return `Schema.${tName}`;
      if (tName === "UUID") return "Schema.UUID";
      if (tName === "Int") return "Schema.Int";
      if (tName === "Option" && typeNode.typeArgs) {
        return `Schema.Option(${this.emitSchemaTypeField(typeNode.typeArgs[0])})`;
      }
      if (tName === "Array" && typeNode.typeArgs?.length === 1) {
        return `Schema.Array(${this.emitSchemaTypeField(typeNode.typeArgs[0])})`;
      }
      if (tName === "Record" && typeNode.typeArgs?.length === 2) {
        return `Schema.Record(${this.emitSchemaTypeField(typeNode.typeArgs[0])}, ${this.emitSchemaTypeField(typeNode.typeArgs[1])})`;
      }
      if (this.runtimeSchemaNames.has(tName)) return tName;
      if (this.options.importedSchemas?.has(tName)) return this.options.importedSchemas.get(tName)!;
      if (this.userImportBindings.has(tName)) return tName;
      if (this.recordContracts.has(tName)) {
        throw new FunScriptError(`'${tName}' is a compile-time record contract, not a runtime schema; it cannot be used as a runtime schema field`, typeNode.span);
      }
      return `(Schema.Unknown as unknown as Schema.Codec<${this.emitTypeNode(typeNode)}>)`;
    }
    return this.emitTypeNode(typeNode);
  }

  private flattenPipelineStages(expr: Expression): Expression[] {
    if (expr.kind === "PipelineExpression") {
      return [...this.flattenPipelineStages(expr.left), ...this.flattenPipelineStages(expr.right)];
    }
    return [expr];
  }

  private extractBrandNames(stages: Expression[]): string[] {
    const brands: string[] = [];
    for (const stage of stages) {
      const b = this.getBrandNameFromStage(stage);
      if (b) brands.push(b);
    }
    return brands;
  }

  private getBrandNameFromStage(stage: Expression): string | null {
    if (stage.kind !== "CallExpression") return null;
    const callee = stage.callee;
    let isBrand = false;
    if (
      (callee.kind === "UpperIdentifier" || callee.kind === "Identifier") &&
      callee.name === "Brand"
    ) {
      isBrand = true;
    } else if (
      callee.kind === "MemberExpression" &&
      (callee.object.kind === "Identifier" || callee.object.kind === "UpperIdentifier") &&
      (callee.object.name === "Schema" || callee.object.name === "Brand") &&
      callee.property.name === "brand"
    ) {
      isBrand = true;
    }
    if (!isBrand || stage.args.length === 0) return null;
    const first = stage.args[0];
    if (first.kind === "StringLiteral") {
      return first.parts.map((p) => (p.kind === "StringRawPart" ? p.value : "")).join("");
    }
    return null;
  }

  private emitRefinementStage(stage: Expression): string {
    const brandName = this.getBrandNameFromStage(stage);
    if (brandName !== null) {
      this.effectImports.add("Schema");
      return `Schema.brand(${JSON.stringify(brandName)})`;
    }
    return this.emitExpression(stage);
  }

  private emitErrorDeclaration(decl: ErrorDeclaration, isExport: boolean): string {
    this.effectImports.add("Schema");
    const name = decl.id.name;
    const exp = isExport ? "export " : "";
    const fields = decl.fields
      .map((f) => `  ${f.name.name}: ${this.emitSchemaTypeField(f.typeAnnotation)}`)
      .join(",\n");

    const className = `${name}$Class`;
    return `${exp}class ${className} extends Schema.TaggedError<${className}>()("${name}", {\n${fields}\n}) {}\n${exp}type ${name} = InstanceType<typeof ${className}>;\n${exp}const ${name} = (function(args: ConstructorParameters<typeof ${className}>[0]): ${name} { return new ${className}(args); }) as { (args: ConstructorParameters<typeof ${className}>[0]): ${name}; new (args: ConstructorParameters<typeof ${className}>[0]): ${name} };`;
  }

  private emitServiceDeclaration(decl: ServiceDeclaration, isExport: boolean): string {
    this.effectImports.add("Context");
    this.effectImports.add("Effect");
    const name = decl.id.name;
    const exp = isExport ? "export " : "";
    const tag = decl.customTag ? decl.customTag.raw : `"app/${name}"`;
    const members = decl.members
      .map((m) => `  readonly ${m.name.name}: ${this.emitTypeNode(m.signature)};`)
      .join("\n");

    return `${exp}class ${name} extends Context.Service<${name}, {\n${members}\n}>()(${tag}) {}`;
  }

  private isAsyncOrPromiseType(type?: TypeNode): boolean {
    if (!type) return false;
    if (type.kind === "TypeReferenceNode") {
      const name = type.name.name;
      return name === "Promise" || name === "Async";
    }
    if (type.kind === "EffectTypeNode") {
      return this.isAsyncOrPromiseType(type.success);
    }
    return false;
  }

  private isPrimitiveType(type?: TypeNode): boolean {
    if (!type) return false;
    if (type.kind === "TypeReferenceNode") {
      const name = type.name.name.toLowerCase();
      return name === "number" || name === "string" || name === "boolean" || name === "int" || name === "float";
    }
    return false;
  }

  private isPrimitive(expr: Expression): boolean {
    if (expr.kind === "NumberLiteral" || expr.kind === "StringLiteral" || expr.kind === "BooleanLiteral") {
      return true;
    }
    if (expr.kind === "UnaryExpression") {
      return true;
    }
    if (expr.kind === "BinaryExpression") {
      return true;
    }
    if (expr.kind === "Identifier" && this.primitiveIdentifiers.has(expr.name)) {
      return true;
    }
    return false;
  }

  private isOptionalParameter(name: string): boolean {
    return [...this.parameterScopes].reverse().find((scope) => scope.has(name))?.get(name) ?? false;
  }

  private recordFields(name: string): Map<string, RecordFieldInfo> | undefined {
    for (let i = this.recordScopes.length - 1; i >= 0; i--) {
      if (this.recordScopes[i].has(name)) return this.recordScopes[i].get(name);
    }
    return undefined;
  }

  private recordField(expr: Expression): RecordFieldInfo | undefined {
    if (expr.kind !== "MemberExpression") return undefined;
    const fields = expr.object.kind === "Identifier" ? this.recordFields(expr.object.name) : this.recordField(expr.object)?.fields;
    return fields?.get(expr.property.name);
  }

  private isHtmlPropsType(type?: TypeNode): boolean {
    if (!type) return false;
    if (type.kind === "TypeReferenceNode" && type.name.name === "HtmlProps") return true;
    if (type.kind === "IntersectionTypeNode") {
      return type.types.some((t) => this.isHtmlPropsType(t));
    }
    return false;
  }

  private isDomOrExternalJsxTarget(target: unknown): boolean {
    if (!target || typeof target !== "object") return true;
    const node = target as Record<string, unknown>;
    if (node.kind === "Identifier" && typeof node.name === "string") {
      return /^[a-z]/.test(node.name);
    }
    if (node.kind === "UpperIdentifier" && typeof node.name === "string") {
      return node.name === "Slot" || node.name === "Comp";
    }
    if (node.kind === "MemberExpression") return true;
    return false;
  }

  private isOptionalValue(expr: Expression): boolean {
    if (expr.kind === "Identifier") return this.isOptionalParameter(expr.name);
    if (expr.kind === "MemberExpression") return this.recordField(expr)?.optional ?? false;
    if (expr.kind === "IndexExpression") return true;
    return false;
  }

  private validateRecordParameterUse(expr: FunctionExpression, name: string, aliases: Set<BindingDeclaration>): void {
    const shadowed = new Set(expr.params.flatMap((param) => this.collectBindingNames(param.name)));
    const collectBindings = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(collectBindings); return; }
      const node = value as Record<string, unknown>;
      if ((node.kind === "BindingDeclaration" || node.kind === "EffectBindStatement") && node.id && typeof node.id === "object") shadowed.add((node.id as { name: string }).name);
      if (node.kind === "VariablePattern" && node.name && typeof node.name === "object") shadowed.add((node.name as { name: string }).name);
      if (node.kind === "FunctionExpression" && Array.isArray(node.params)) {
        for (const param of node.params) if (param?.name) for (const n of this.collectBindingNames(param.name)) shadowed.add(n);
      }
      for (const [key, child] of Object.entries(node)) if (key !== "span") collectBindings(child);
    };
    collectBindings(expr.body);
    const source = expr.params.find((param) => param.name.kind === "Identifier" && param.name.name === name)?.typeAnnotation;
    if (this.isHtmlPropsType(source)) return;
    const hasDefaults = source?.kind === "RecordTypeNode" && source.fields.some((field) => field.defaultValue);
    const isSafeLocalForward = (parent: Record<string, unknown>, index: number | undefined): boolean => {
      if (hasDefaults || index === undefined || parent.kind !== "CallExpression") return false;
      const callee = parent.callee as { kind?: string; name?: string; object?: { kind?: string; name?: string }; property?: { name?: string } } | undefined;
      if (callee?.kind === "MemberExpression" && (callee.object?.kind === "Identifier" || callee.object?.kind === "UpperIdentifier") && callee.object.name && callee.property?.name && !shadowed.has(callee.object.name)) {
        return this.options.importedRecordFunctions?.get(`${callee.object.name}.${callee.property.name}`)?.has(index) ?? false;
      }
      if ((callee?.kind !== "Identifier" && callee?.kind !== "UpperIdentifier") || !callee.name || shadowed.has(callee.name)) return false;
      if (this.options.importedRecordFunctions?.get(callee.name)?.has(index)) return true;
      const target = this.bindings.get(callee.name);
      if (!target || target.isMut || target.isJs || target.init.kind !== "FunctionExpression") return false;
      const targetType = target.init.params[index]?.typeAnnotation;
      const type = targetType?.kind === "TypeReferenceNode" ? this.recordContracts.get(targetType.name.name) ?? targetType : targetType;
      const hasOptionalFields = (node: TypeNode | undefined): boolean => node?.kind === "RecordTypeNode" &&
        node.fields.some((field) => Boolean(field.optional || field.defaultValue) || hasOptionalFields(field.typeAnnotation));
      return hasOptionalFields(type);
    };
    const visit = (value: unknown, parent?: Record<string, unknown>, key?: string, allowMember = true, inJs = false, index?: number, jsxTarget?: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach((child, i) => visit(child, parent, key, allowMember, inJs, i, jsxTarget)); return; }
      const node = value as Record<string, unknown>;
      if (node.kind === "FunctionExpression" && Array.isArray(node.params) && node.params.some((param: any) => param.name && this.collectBindingNames(param.name).includes(name))) return;
      if (node.kind === "MemberExpression") {
        const field = this.recordField(node as unknown as Expression);
        const matchedOptional = field?.optional && parent?.kind === "MatchExpression" && key === "scrutinee";
        const allowedNested = !field?.optional && ((parent?.kind === "MemberExpression" && key === "object") || (inJs && parent?.kind === "CallExpression" && key === "args"));
        if (field?.fields && !matchedOptional && !allowedNested) {
          throw new FunScriptError("A nested record with optional fields cannot be passed, returned, aliased, or indexed yet; access its fields directly", node.span as any);
        }
      }
      if (node.kind === "Identifier" && node.name === name) {
        if (parent && parent.kind === "BindingDeclaration" && aliases.has(parent as unknown as BindingDeclaration) && (key === "init" || key === "id")) return;
        if (allowMember && parent?.kind === "MemberExpression" && key === "object") return;
        if (allowMember && inJs && parent?.kind === "CallExpression" && key === "args") return;
        if (allowMember && parent && key === "args" && isSafeLocalForward(parent, index)) return;
        if (allowMember && parent?.kind === "JSXSpreadAttribute" && key === "argument" && (this.isDomOrExternalJsxTarget(jsxTarget) || isSafeLocalForward({ kind: "CallExpression", callee: jsxTarget }, 0))) return;
        if ((parent?.kind === "MemberExpression" && key === "property") || (parent?.kind === "FieldEntry" && key === "key") || (parent?.kind === "JSXAttribute" && key === "name")) return;
        throw new FunScriptError(`A record parameter with optional fields cannot be passed, returned, aliased, or indexed yet; access ${name}.field directly`, node.span as any);
      }
      for (const [childKey, child] of Object.entries(node)) {
        const target = childKey === "attributes" && (node.kind === "JSXOpeningElement" || node.kind === "JSXSelfClosingElement") ? node.name : jsxTarget;
        if (childKey !== "span" && childKey !== "typeAnnotation" && childKey !== "returnType") visit(child, node, childKey, allowMember, inJs || node.kind === "JsExpression", undefined, target);
      }
    };
    visit(expr.body);
    const param = expr.params.find((item) => item.name.kind === "Identifier" && item.name.name === name);
    if (param?.typeAnnotation?.kind === "RecordTypeNode") {
      for (const field of param.typeAnnotation.fields) if (field.defaultValue) visit(field.defaultValue, undefined, undefined, false);
    }
  }

  private validateRecordDefault(value: Expression, parameterNames: Set<string>): void {
    const visit = (item: unknown, parent?: Record<string, unknown>, key?: string): void => {
      if (!item || typeof item !== "object") return;
      if (Array.isArray(item)) { for (const child of item) visit(child, parent, key); return; }
      const node = item as Record<string, unknown>;
      if (node.kind === "Identifier" && typeof node.name === "string" && parameterNames.has(node.name)) {
        if ((parent?.kind === "MemberExpression" && key === "property") || (parent?.kind === "FieldEntry" && key === "key")) return;
        throw new FunScriptError("Defaulted record fields cannot reference function parameters yet", node.span as any);
      }
      for (const [childKey, child] of Object.entries(node)) {
        if (childKey !== "span" && childKey !== "typeAnnotation" && childKey !== "returnType") visit(child, node, childKey);
      }
    };
    visit(value);
  }

  private emitBindingDeclaration(decl: BindingDeclaration, isExport = false): string {
    const scope = this.parameterScopes.at(-1);
    const idName = decl.id.kind === "Identifier" || decl.id.kind === "UpperIdentifier" ? decl.id.name : undefined;
    if (idName) {
      if (scope) scope.set(idName, this.isOptionalValue(decl.init));
      const aliasedFields = !decl.isMut && decl.init.kind === "Identifier" ? this.recordFields(decl.init.name) : undefined;
      this.recordScopes.at(-1)?.set(idName, aliasedFields);
      if (this.isPrimitiveType(decl.typeAnnotation) || this.isPrimitive(decl.init)) {
        this.primitiveIdentifiers.add(idName);
      }
    }
    const target = this.emitBindingTarget(decl.id);
    const exp = isExport ? "export " : "";
    const keyword = decl.isMut ? "let" : "const";
    const typeAnn = decl.typeAnnotation ? `: ${this.emitTypeNode(decl.typeAnnotation)}` : "";

    if (decl.isJs) {
      if (decl.init.kind === "FunctionExpression" && decl.init.params.some((p) => p.typeAnnotation?.kind === "TypeReferenceNode" && this.recordContracts.has(p.typeAnnotation.name.name))) {
        throw new FunScriptError("Compile-time record contracts are not supported on js entry bindings", decl.span);
      }
      this.effectImports.add("Effect");
      if (decl.init.kind === "FunctionExpression") {
        const fn = decl.init;
        const validations = fn.params
          .filter((p) => p.typeAnnotation && p.name.kind === "Identifier")
          .map((p) => `  ${(p.name as Identifier).name} = Schema.decodeUnknownSync(${this.emitSchemaTypeField(p.typeAnnotation!)})(${(p.name as Identifier).name});`)
          .join("\n");
        if (validations) this.effectImports.add("Schema");
        for (const p of fn.params) {
          if (this.isPrimitiveType(p.typeAnnotation)) {
            for (const n of this.collectBindingNames(p.name)) {
              this.primitiveIdentifiers.add(n);
            }
          }
        }
        const params = fn.params
          .map((p) => {
            const t = p.typeAnnotation ? `: ${this.emitTypeNode(p.typeAnnotation)}` : "";
            return `${this.emitBindingTarget(p.name)}${t}`;
          })
          .join(", ");
        if (fn.body.kind === "BlockStatement") {
          const retExpr = fn.body.finalExpression ? this.emitExpression(fn.body.finalExpression) : "undefined";
          if (fn.body.statements.length === 0) {
            return `${exp}${keyword} ${target} = (${params}) => {\n${validations}\n  return Effect.runPromise(${retExpr});\n};`;
          }
          const stmts = fn.body.statements.map((s) => "    " + this.emitStatement(s)).join("\n");
          return `${exp}${keyword} ${target} = (${params}) => {\n${validations}\n  return Effect.runPromise(Effect.gen(function* () {\n${stmts}\n    return ${retExpr};\n  }));\n};`;
        }
        return `${exp}${keyword} ${target} = (${params}) => {\n${validations}\n  return Effect.runPromise(${this.emitExpression(fn.body)});\n};`;
      }
      return `${exp}${keyword} ${target}${typeAnn} = Effect.runPromise(${this.emitExpression(decl.init)});`;
    }

    return `${exp}${keyword} ${target}${typeAnn} = ${this.emitExpression(decl.init)};`;
  }

  private emitBindingTarget(target: BindingTarget | Pattern): string {
    if (target.kind === "Identifier" || target.kind === "UpperIdentifier") {
      return target.name;
    }
    if (target.kind === "VariablePattern") {
      return target.name.name;
    }
    if (target.kind === "WildcardPattern" || target.kind === "LiteralPattern") {
      return "";
    }
    if (target.kind === "RestPattern") {
      return `...${this.emitBindingTarget(target.argument)}`;
    }
    if (target.kind === "RecordPattern") {
      const fields = target.fields.map((f) => {
        if (f.isRest) {
          return `...${f.key.name}`;
        }
        if (!f.pattern || (f.pattern.kind === "VariablePattern" && f.pattern.name.name === f.key.name)) {
          return f.key.name;
        }
        return `${f.key.name}: ${this.emitBindingTarget(f.pattern)}`;
      });
      return `{ ${fields.join(", ")} }`;
    }
    if (target.kind === "ArrayPattern") {
      const elements = target.elements.map((el) => this.emitBindingTarget(el));
      return `[${elements.join(", ")}]`;
    }
    return "_";
  }

  private collectBindingNames(target: BindingTarget | Pattern): string[] {
    if (target.kind === "Identifier" || target.kind === "UpperIdentifier") return [target.name];
    if (target.kind === "VariablePattern") return [target.name.name];
    if (target.kind === "RestPattern") return this.collectBindingNames(target.argument);
    if (target.kind === "RecordPattern") {
      return target.fields.flatMap((f) => (f.pattern ? this.collectBindingNames(f.pattern) : [f.key.name]));
    }
    if (target.kind === "ArrayPattern") {
      return target.elements.flatMap((el) => this.collectBindingNames(el));
    }
    return [];
  }

  // --- Expressions ---

  public emitExpression(expr: Expression): string {
    switch (expr.kind) {
      case "NumberLiteral":
        return expr.raw;
      case "StringLiteral":
        return this.emitStringLiteral(expr);
      case "TemplateLiteral":
        return this.emitTemplateLiteral(expr);
      case "TaggedTemplateExpression":
        return this.emitTaggedTemplateExpression(expr);
      case "BooleanLiteral":
        return expr.value ? "true" : "false";
      case "Identifier":
      case "UpperIdentifier":
        if (this.recordContracts.has(expr.name)) throw new FunScriptError(`${expr.name} is a compile-time record contract, not a runtime schema`, expr.span);
        if (expr.name === "Unit") return "undefined";
        return expr.name;
      case "Placeholder":
        return this.currentPlaceholderParam ?? "__placeholder";
      case "TypedHole":
        return `(() => { throw new Error("Typed hole reached: ${expr.label || "???"}"); })()`;
      case "PipelineExpression":
        return this.emitPipelineExpression(expr);
      case "BinaryExpression":
        return this.emitBinaryExpression(expr);
      case "UnaryExpression":
        return this.emitUnaryExpression(expr);
      case "CallExpression":
        return this.emitCallExpression(expr);
      case "MemberExpression": {
        const raw = `${this.emitExpression(expr.object)}.${this.emitMemberProperty(expr)}`;
        const field = this.recordField(expr);
        if (field?.defaultBinding) return field.defaultBinding;
        if (field?.optional) {
          this.effectImports.add("Option");
          return `Option.fromUndefinedOr(${raw})`;
        }
        return raw;
      }
      case "IndexExpression":
        if (expr.index.kind === "StringLiteral") {
          return `${this.emitExpression(expr.object)}[${this.emitExpression(expr.index)}]`;
        }
        this.needsFromNullishOr = true;
        this.effectImports.add("Option");
        return `fromNullishOr(${this.emitExpression(expr.object)}[${this.emitExpression(expr.index)}])`;
      case "RecordExpression":
        return this.emitRecordExpression(expr);
      case "ArrayExpression":
        return `[${expr.elements.map((e) => this.emitExpression(e)).join(", ")}]`;
      case "FunctionExpression":
        return this.emitFunctionExpression(expr);
      case "MutBlockExpression":
        this.needsMutative = true;
        return `create(${this.emitMutativeRecipe(expr)})`;
      case "MatchExpression":
        return this.emitMatchExpression(expr);
      case "EffectBlockExpression":
        return this.emitEffectBlockExpression(expr);
      case "JSXElement":
        return this.emitJsxElement(expr);
      case "JSXSelfClosingElement":
        return this.emitJsxSelfClosingElement(expr);
      case "JsExpression":
        return this.emitJsExpression(expr);
      case "TsEscapeExpression":
        return expr.code;
      case "SpreadElement":
        return `...${this.emitExpression(expr.argument)}`;
    }
  }

  private emitJsExpression(expr: JsExpression): string {
    this.effectImports.add("Effect");
    this.effectImports.add("Option");
    this.needsJsInterop = true;
    // compiler.ts replaces this provisional flag with the nullability inferred
    // from the native TypeScript return type.
    return `__funscriptJs(() => ${this.emitExpression(expr.expression)}, false)`;
  }

  private emitMemberProperty(expr: MemberExpression): string {
    if (expr.object.kind === "UpperIdentifier") {
      if (expr.object.name === "Effect") return EFFECT_V4_MEMBER_RENAMES[expr.property.name] ?? expr.property.name;
    }
    return expr.property.name;
  }

  private emitMutativeRecipe(expr: MutBlockExpression): string {
    // Mutative recipes mutate their draft in place and must return void.
    // A trailing draft expression is useful in FunScript's block syntax,
    // but returning that proxy selects the wrong create overload.
    const recipeBody = expr.body.kind === "BlockStatement" &&
      expr.body.finalExpression?.kind === "Identifier" &&
      expr.body.finalExpression.name === expr.draftParam.name
      ? this.emitFunctionBody({ ...expr.body, finalExpression: undefined })
      : this.emitFunctionBody(expr.body);
    return `(${expr.draftParam.name}) => {\n${recipeBody}\n}`;
  }

  private emitStringLiteral(lit: StringLiteral): string {
    if (lit.parts.length === 1 && lit.parts[0].kind === "StringRawPart") {
      return JSON.stringify(lit.parts[0].value);
    }
    const template = lit.parts
      .map((p) => {
        if (p.kind === "StringRawPart") return p.value.replace(/`/g, "\\`").replace(/\${/g, "\\${");
        return `\${${this.emitExpression(p.expression)}}`;
      })
      .join("");
    return `\`${template}\``;
  }

  private emitTemplateLiteral(lit: TemplateLiteral): string {
    const template = lit.parts
      .map((p) => {
        if (p.kind === "StringRawPart") return p.value.replace(/`/g, "\\`").replace(/\${/g, "\\${");
        return `\${${this.emitExpression(p.expression)}}`;
      })
      .join("");
    return `\`${template}\``;
  }

  private emitTaggedTemplateExpression(expr: TaggedTemplateExpression): string {
    const tag = this.emitExpression(expr.tag);
    let typeArgs = "";
    if (expr.typeArguments && expr.typeArguments.length > 0) {
      typeArgs = "<" + expr.typeArguments.map((t) => this.emitTypeNode(t)).join(", ") + ">";
    }
    return `${tag}${typeArgs}${this.emitTemplateLiteral(expr.template)}`;
  }

  private emitCallExpression(expr: CallExpression): string {
    if (
      expr.callee.kind === "MemberExpression" &&
      (expr.callee.object.kind === "Identifier" || expr.callee.object.kind === "UpperIdentifier") &&
      expr.callee.object.name === "Option" &&
      expr.callee.property.name === "fromNullishOrElse"
    ) {
      this.needsFromNullishOrElse = true;
      return `fromNullishOrElse(${expr.args.map((a) => this.emitExpression(a)).join(", ")})`;
    }

    if (
      expr.callee.kind === "MemberExpression" &&
      (expr.callee.object.kind === "Identifier" || expr.callee.object.kind === "UpperIdentifier") &&
      expr.callee.object.name === "Option" &&
      expr.callee.property.name === "fromNullishOr"
    ) {
      this.needsFromNullishOr = true;
      this.effectImports.add("Option");
      return `fromNullishOr(${expr.args.map((a) => this.emitExpression(a)).join(", ")})`;
    }

    if (
      expr.callee.kind === "Identifier" &&
      (expr.callee.name === "parseInt" || expr.callee.name === "parseFloat")
    ) {
      throw new FunScriptError(
        `'${expr.callee.name}()' is banned by the Effect style guide because it produces NaN on invalid input. Use 'Number.parse(s)' instead for total parsing returning Option<number>.`,
        expr.callee.span,
      );
    }

    if (
      (expr.callee.kind === "UpperIdentifier" || expr.callee.kind === "Identifier") &&
      expr.callee.name === "URL" &&
      this.tryContextDepth === 0
    ) {
      throw new FunScriptError(
        `'URL(...)' is unsafe because URL constructors throw on malformed input. Guard it with 'Result.try(() => URL(...))' or 'Option.try(() => URL(...))'.`,
        expr.callee.span,
      );
    }

    if (
      expr.callee.kind === "MemberExpression" &&
      (expr.callee.object.kind === "Identifier" || expr.callee.object.kind === "UpperIdentifier") &&
      expr.callee.object.name === "Option" &&
      expr.callee.property.name === "try"
    ) {
      this.needsOptionTry = true;
      this.effectImports.add("Option");
      this.tryContextDepth++;
      try {
        return `optionTry(${expr.args.map((a) => this.emitExpression(a)).join(", ")})`;
      } finally {
        this.tryContextDepth--;
      }
    }

    if (
      expr.callee.kind === "MemberExpression" &&
      (expr.callee.object.kind === "Identifier" || expr.callee.object.kind === "UpperIdentifier") &&
      expr.callee.object.name === "Result" &&
      expr.callee.property.name === "try"
    ) {
      this.effectImports.add("Result");
      this.tryContextDepth++;
      try {
        return `Result.try(${expr.args.map((a) => this.emitExpression(a)).join(", ")})`;
      } finally {
        this.tryContextDepth--;
      }
    }

    if (expr.callee.kind === "MemberExpression") {
      const prop = expr.callee.property.name;
      const root = getRootCalleeName(expr.callee.object);
      const objName = (expr.callee.object.kind === "Identifier" || expr.callee.object.kind === "UpperIdentifier")
        ? expr.callee.object.name
        : null;

      if ((objName === "Number" || objName === "globalThis") && (prop === "parseInt" || prop === "parseFloat")) {
        throw new FunScriptError(
          `'${objName}.${prop}()' is banned by the Effect style guide because it produces NaN on invalid input. Use 'Number.parse(s)' instead for total parsing returning Option<number>.`,
          expr.callee.property.span,
        );
      }

      if ((objName === "JSON" || objName === "globalThis") && prop === "parse" && this.tryContextDepth === 0) {
        throw new FunScriptError(
          `'JSON.parse()' is unsafe because it throws on malformed input. Guard it with 'Result.try(() => JSON.parse(...))' or use 'Schema.decodeUnknown'.`,
          expr.callee.property.span,
        );
      }

      if ((objName === "Math" || objName === "globalThis") && prop === "random") {
        throw new FunScriptError(
          `'Math.random()' is banned by the Effect style guide because it is unmanaged and non-deterministic. Use 'Random.next' or 'Random.nextIntBetween' instead.`,
          expr.callee.property.span,
        );
      }

      if (
        (expr.callee.object.kind === "Identifier" || expr.callee.object.kind === "UpperIdentifier") &&
        expr.callee.object.name === "Object" &&
        BANNED_OBJECT_STATIC_METHODS.has(prop)
      ) {
        const replacement = BANNED_OBJECT_STATIC_METHODS.get(prop)!;
        throw new FunScriptError(
          `'Object.${prop}()' is banned by the Effect style guide. Use ${replacement} instead.`,
          expr.callee.property.span,
        );
      }

      const isAllowed =
        root !== null &&
        (root[0] === root[0].toUpperCase() ||
          EFFECT_MODULE_NAMES.has(root) ||
          EFFECT_BUILTIN_MODULES.has(root));

      if (!isAllowed && BANNED_INSTANCE_METHODS.has(prop)) {
        const info = BANNED_INSTANCE_METHODS.get(prop)!;
        const isWebMutable =
          (prop === "set" || prop === "delete") &&
          root !== null &&
          /^(url|search|query|param|header|form|request|response|req|res)/i.test(root);
        if (!isWebMutable) {
          throw new FunScriptError(
            `Native ${info.category} method '.${prop}()' is banned by the Effect style guide. Use '${info.replacement}(...)' or pipeline '${info.pipeline}' instead.`,
            expr.callee.property.span,
          );
        }
      }

      if (
        (expr.callee.object.kind === "Identifier" || expr.callee.object.kind === "UpperIdentifier") &&
        EFFECT_BUILTIN_MODULES.has(expr.callee.object.name)
      ) {
        this.effectImports.add(expr.callee.object.name);
      }
    }

    if (
      (expr.callee.kind === "UpperIdentifier" || expr.callee.kind === "Identifier") &&
      AUTO_NEW_CONSTRUCTORS.has(expr.callee.name) &&
      !this.bindings.has(expr.callee.name) &&
      !this.declaredTypeNames.has(expr.callee.name)
    ) {
      if ((expr.callee.name === "Map" || expr.callee.name === "WeakMap") && expr.args.length === 1) {
        return `new ${expr.callee.name}(${this.emitExpression(expr.args[0])} as any)`;
      }
      return `new ${expr.callee.name}(${expr.args.map((a) => this.emitExpression(a)).join(", ")})`;
    }

    if (
      expr.callee.kind === "MemberExpression" &&
      AUTO_NEW_CONSTRUCTORS.has(expr.callee.property.name) &&
      expr.callee.object.kind === "Identifier" &&
      (expr.callee.object.name === "globalThis" || expr.callee.object.name === "window")
    ) {
      return `new ${this.emitExpression(expr.callee)}(${expr.args.map((a) => this.emitExpression(a)).join(", ")})`;
    }

    if (
      (expr.callee.kind === "UpperIdentifier" || expr.callee.kind === "Identifier") &&
      expr.callee.name === "Brand"
    ) {
      this.effectImports.add("Schema");
      return `Schema.brand(${expr.args.map((a) => this.emitExpression(a)).join(", ")})`;
    }

    if (
      this.options.markPipelineSources &&
      !this.inPipelineStage &&
      expr.callee.kind === "Identifier" &&
      expr.args.length >= 1
    ) {
      const fnName = expr.callee.name;
      if (
        fnName in COMPARISON_METHOD_MAP ||
        (!this.bindings.has(fnName) && !this.userEffectBindings.has(fnName))
      ) {
        const firstArg = this.emitExpression(expr.args[0]);
        const restArgs = expr.args.slice(1).map((a) => this.emitExpression(a));
        const markedFirstArg = `__funscriptDirectCall(${expr.span.start.offset}, ${firstArg})`;
        return `${fnName}(${[markedFirstArg, ...restArgs].join(", ")})`;
      }
    }

    if (this.options.directCallResolutions?.has(expr.span.start.offset)) {
      const res = this.options.directCallResolutions.get(expr.span.start.offset)!;
      if (isEffectModule(res.module)) {
        this.effectImports.add(res.module);
      }
      const callee = `${res.module}.${res.method ?? (expr.callee as Identifier).name}`;
      return `${callee}(${expr.args.map((a) => this.emitExpression(a)).join(", ")})`;
    }

    if (
      expr.callee.kind === "Identifier" &&
      !this.bindings.has(expr.callee.name) &&
      ES_TOOLKIT_METHODS.has(expr.callee.name)
    ) {
      this.esToolkitImports.add(expr.callee.name);
    }

    return `${this.emitExpression(expr.callee)}(${expr.args.map((a) => this.emitExpression(a)).join(", ")})`;
  }

  private emitPipelineExpression(expr: PipelineExpression): string {
    this.effectImports.add("pipe");

    // Flatten left-nested pipelines: a |> b |> c
    const stages: Expression[] = [];
    let curr: Expression = expr;

    while (curr.kind === "PipelineExpression") {
      stages.unshift(curr.right);
      curr = curr.left;
    }
    stages.unshift(curr);

    const prevInPipeline = this.inPipelineStage;
    this.inPipelineStage = true;
    try {
      let preferredCompanion = this.inferPipelineCompanion(stages[0]);
      const emittedStages = stages.map((s, idx) => {
        if (idx === 0) {
          const emitted = this.emitExpression(s);
          return this.options.markPipelineSources
            ? `__funscriptPipelineSource(${s.span.start.offset}, ${emitted})`
            : emitted;
        }

        if (s.kind === "MutBlockExpression") {
          this.needsMutative = true;
          return `(__mutInput) => create(__mutInput, ${this.emitMutativeRecipe(s)})`;
        }

        // Check if stage was resolved by type-directed resolution
        if (this.options.stageResolutions?.has(s.span.start.offset)) {
          const res = this.options.stageResolutions.get(s.span.start.offset)!;
          if (isEffectModule(res.module)) {
            this.effectImports.add(res.module);
          }
          if (s.kind === "Identifier" || s.kind === "UpperIdentifier") {
            return `${res.module}.${res.method ?? s.name}`;
          }
          if (s.kind === "CallExpression") {
            const callee = s.callee as Identifier | UpperIdentifier;
            if (res.module === "Schema" && (res.method === "decode" || (!res.method && callee.name === "decode"))) {
              this.needsDecodeUnknown = true;
            }
            const method = res.module === "Schema" && (res.method === "decode" || (!res.method && callee.name === "decode"))
              ? "decodeUnknown"
              : res.method ?? callee.name;
            const calleeName = `${res.module}.${method}`;
            if (this.hasPlaceholder(s)) {
              const placeholderParam = "__p";
              const prevPlaceholderParam = this.currentPlaceholderParam;
              this.currentPlaceholderParam = placeholderParam;
              try {
                const args = s.args.map((a) => this.emitExpression(a)).join(", ");
                return `(${placeholderParam}) => ${calleeName}(${args})`;
              } finally {
                this.currentPlaceholderParam = prevPlaceholderParam;
              }
            }
            const args = s.args.map((a) => this.emitExpression(a)).join(", ");
            return `${calleeName}(${args})`;
          }
        }

        // Auto-namespace resolution for pipeline stage callee
        this.assertPipelineStageIsNotAmbiguous(s, preferredCompanion);
        const resolvedStage = this.resolvePipelineStage(s, preferredCompanion);

        // `js` runs an Effect and leaves the Effect pipeline domain.
        if (s.kind === "Identifier" && s.name === "js") preferredCompanion = undefined;

        // Check if stage has placeholder '_'
        if (this.hasPlaceholder(resolvedStage)) {
          const placeholderParam = "__p";
          const prevPlaceholderParam = this.currentPlaceholderParam;
          this.currentPlaceholderParam = placeholderParam;
          try {
            const body = this.emitExpression(resolvedStage);
            const formattedBody = resolvedStage.kind === "RecordExpression" ? `(${body})` : body;
            return `(${placeholderParam}) => ${formattedBody}`;
          } finally {
            this.currentPlaceholderParam = prevPlaceholderParam;
          }
        }

        return this.emitExpression(resolvedStage);
      });

      return `pipe(\n  ${emittedStages.join(",\n  ")}\n)`;
    } finally {
      this.inPipelineStage = prevInPipeline;
    }
  }

  private inferPipelineCompanion(source: Expression): CompanionModule | undefined {
    const inferred = this.options.pipelineCompanions?.get(source.span.start.offset);
    if (inferred) return inferred;
    if (source.kind === "ArrayExpression") return "Array";
    if (source.kind === "StringLiteral") return "String";
    if (source.kind === "RecordExpression") return "Record";
    if (source.kind === "EffectBlockExpression" || source.kind === "JsExpression") return "Effect";
    if (source.kind === "Identifier") {
      const binding = this.bindings.get(source.name);
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

  private hasPlaceholder(expr: Expression): boolean {
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

  private resolvePipelineStage(stage: Expression, preferredCompanion?: CompanionModule): Expression {
    // 0. 'js' pipeline stage: eff |> js => pipe(eff, Effect.runPromise)
    if (stage.kind === "Identifier" && stage.name === "js") {
      this.effectImports.add("Effect");
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
      if (!this.isUserBinding(name)) {
        if ((!preferredCompanion || (preferredCompanion === "String" && ES_TOOLKIT_STRING_METHODS.has(name))) && ES_TOOLKIT_METHODS.has(name)) {
          this.esToolkitImports.add(name);
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
          this.effectImports.add(companion);
          if (companion === "Schema" && name === "decode") {
            this.needsDecodeUnknown = true;
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
      if (!this.bindings.has(name) && ES_TOOLKIT_METHODS.has(name)) {
        this.esToolkitImports.add(name);
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
          this.esToolkitImports.add(prop.name);
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
          this.esToolkitImports.add(prop.name);
          return stage.args.length === 0 ? prop : { ...stage, callee: prop };
        }
        const companion = obj.name as CompanionModule;
        if (this.isCompanionOperation(companion, prop.name)) {
          this.effectImports.add(companion);
          if (companion === "Schema" && prop.name === "decode") {
            this.needsDecodeUnknown = true;
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
      if (!this.isUserBinding(name)) {
        if ((!preferredCompanion || (preferredCompanion === "String" && ES_TOOLKIT_STRING_METHODS.has(name))) && ES_TOOLKIT_METHODS.has(name)) {
          this.esToolkitImports.add(name);
          return stage;
        }
        const companion = this.getCompanionModule(name, preferredCompanion);
        if (companion) {
          this.effectImports.add(companion);
          return {
            kind: "MemberExpression",
            object: { kind: "UpperIdentifier", name: companion, span: stage.span },
            property: { ...stage, name: name === "lines" ? "linesIterator" : name },
            span: stage.span,
          };
        }
      }
      if (!this.bindings.has(name) && ES_TOOLKIT_METHODS.has(name)) {
        this.esToolkitImports.add(name);
        return stage;
      }
    }

    // 2b. Bare MemberExpression in pipeline: String.camelCase, Math.round, etc.
    if (stage.kind === "MemberExpression" && stage.object.kind === "UpperIdentifier") {
      if (stage.object.name === "String" && ES_TOOLKIT_STRING_METHODS.has(stage.property.name)) {
        this.esToolkitImports.add(stage.property.name);
        return stage.property;
      }
      if (
        stage.object.name === "Math" &&
        (ES_TOOLKIT_MATH_DATA_LAST.has(stage.property.name) || ES_TOOLKIT_MATH_COLLECTION.has(stage.property.name))
      ) {
        this.esToolkitImports.add(stage.property.name);
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

  private isUserBinding(name: string): boolean {
    return (
      this.bindings.has(name) ||
      this.userImportBindings.has(name) ||
      this.userEffectBindings.has(name) ||
      this.userEsToolkitBindings.has(name)
    );
  }

  private assertPipelineStageIsNotAmbiguous(stage: Expression, preferredCompanion?: CompanionModule): void {
    const name = stage.kind === "Identifier"
      ? stage.name
      : stage.kind === "CallExpression" && stage.callee.kind === "Identifier"
      ? stage.callee.name
      : undefined;
    if (!name || preferredCompanion) return;
    if (this.isUserBinding(name)) return;
    const candidates = pipelineCompanionCandidates(name);
    if (candidates.length > 1 && !this.options.allowAmbiguousPipeline) {
      throw new PipelineResolutionError(
        `${name} is ambiguous for this pipeline; write ${candidates.map((module) => `${module}.${name}(...)`).join(" or ")}`,
        stage.span,
      );
    }
  }

  private emitBinaryExpression(expr: BinaryExpression): string {
    const emitOperand = (operand: Expression) => {
      const emitted = this.emitExpression(operand);
      return operand.kind === "FunctionExpression" ? `(${emitted})` : emitted;
    };
    const left = emitOperand(expr.left);
    const right = emitOperand(expr.right);
    switch (expr.operator) {
      case "and":
        return `(${left} && ${right})`;
      case "or":
        return `(${left} || ${right})`;
      case "@=":
        if (this.isPrimitive(expr.left) || this.isPrimitive(expr.right)) {
          throw new Error(`Reference identity operator '@=' cannot be used with primitive values; use '#=' or '#!' for value equality`);
        }
        this.needsReferenceEquality = true;
        return `referenceEquals(${left}, ${right})`;
      case "@!":
        if (this.isPrimitive(expr.left) || this.isPrimitive(expr.right)) {
          throw new Error(`Reference identity operator '@!' cannot be used with primitive values; use '#=' or '#!' for value equality`);
        }
        this.needsReferenceEquality = true;
        return `(!referenceEquals(${left}, ${right}))`;
      case "#=":
        if (this.isPrimitive(expr.left) || this.isPrimitive(expr.right)) {
          return `(${left} === ${right})`;
        }
        this.effectImports.add("Equal");
        return `Equal.equals(${left}, ${right})`;
      case "#!":
        if (this.isPrimitive(expr.left) || this.isPrimitive(expr.right)) {
          return `(${left} !== ${right})`;
        }
        this.effectImports.add("Equal");
        return `(!Equal.equals(${left}, ${right}))`;
      case "<":
      case "<=":
      case ">":
      case ">=": {
        if (!this.options.markNumericComparisonOperands) {
          return `(${left} ${expr.operator} ${right})`;
        }
        const mark = (operand: string, offset: number) =>
          `__funscriptNumericOperand(${offset}, ${JSON.stringify(expr.operator)}, ${operand})`;
        return `(${mark(left, expr.left.span.start.offset)} ${expr.operator} ${mark(right, expr.right.span.start.offset)})`;
      }
      default:
        return `(${left} ${expr.operator} ${right})`;
    }
  }

  private emitUnaryExpression(expr: UnaryExpression): string {
    const arg = this.emitExpression(expr.argument);
    if (expr.operator === "not") return `(!${arg})`;
    return `(-${arg})`;
  }

  private emitRecordExpression(expr: RecordExpression): string {
    const hasDotPaths = expr.entries.some((e) => e.kind === "DotPathEntry");
    if (hasDotPaths) {
      // Lower to Mutative create
      this.needsMutative = true;
      const baseSpread = expr.entries.find((e) => e.kind === "SpreadEntry") as any;
      const base = baseSpread ? this.emitExpression(baseSpread.argument) : "{}";
      const mutations = expr.entries
        .filter((e) => e.kind !== "SpreadEntry")
        .map((e) => {
          if (e.kind === "DotPathEntry") {
            return `  draft.${e.path.map((p) => p.name).join(".")} = ${this.emitExpression(e.value)};`;
          }
          if (e.kind === "FieldEntry") {
            const keyAccess = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(e.key.name) ? `.${e.key.name}` : `[${JSON.stringify(e.key.name)}]`;
            return `  draft${keyAccess} = ${this.emitExpression(e.value)};`;
          }
          return `  draft.${e.key.name} = ${e.key.name};`;
        })
        .join("\n");
      return `create(${base}, (draft) => {\n${mutations}\n})`;
    }

    const entries = expr.entries
      .map((e) => {
        if (e.kind === "SpreadEntry") return `...${this.emitExpression(e.argument)}`;
        if (e.kind === "FieldEntry") return `${emitPropertyKey(e.key.name)}: ${this.emitExpression(e.value)}`;
        if (e.kind === "ShorthandEntry") return e.key.name;
        return "";
      })
      .join(", ");
    return `{ ${entries} }`;
  }

  private emitFunctionExpression(expr: FunctionExpression): string {
    for (const p of expr.params) {
      if (this.isPrimitiveType(p.typeAnnotation)) {
        for (const n of this.collectBindingNames(p.name)) {
          this.primitiveIdentifiers.add(n);
        }
      }
    }
    const params = expr.params
      .map((p, index) => {
        const rest = p.isRest ? "..." : "";
        const name = p.optional ? `$funscriptOptional${index}` : this.emitBindingTarget(p.name);
        let typeAnn = "";
        if (p.typeAnnotation) {
          const base = this.emitTypeNode(p.typeAnnotation);
          if (p.optional) {
            this.effectImports.add("Option");
            const wrappedBase = p.typeAnnotation.kind === "FunctionTypeNode" ? `(${base})` : base;
            typeAnn = `: ${wrappedBase} | Option.Option<${base}>`;
          } else {
            typeAnn = `: ${base}`;
          }
        }
        const defaultValue = p.defaultValue ? ` = ${this.emitExpression(p.defaultValue)}` : "";
        return `${rest}${name}${p.optional ? "?" : ""}${typeAnn}${defaultValue}`;
      })
      .join(", ");
    const typeParams = this.emitTypeParameters(expr.typeParams, true);
    const retType = expr.returnType ? `: ${this.emitTypeNode(expr.returnType)}` : "";
    const optionalBindings = expr.params.flatMap((p, index) => {
      if (!p.optional) return [];
      this.effectImports.add("Option");
      return [`  const ${this.emitBindingTarget(p.name)} = Option.isOption($funscriptOptional${index}) ? $funscriptOptional${index} : Option.fromUndefinedOr($funscriptOptional${index});`];
    });

    const records = new Map<string, Map<string, RecordFieldInfo> | undefined>();
    const recordDefaults: string[] = [];
    expr.params.forEach((param, paramIndex) => {
      if (param.name.kind !== "Identifier") return;
      const paramName = param.name.name;
      const declared = param.typeAnnotation;
      if (this.isHtmlPropsType(declared)) { records.set(paramName, undefined); return; }
      const recordType = declared?.kind === "TypeReferenceNode" ? this.recordContracts.get(declared.name.name) : declared;
      if (param.optional || recordType?.kind !== "RecordTypeNode") { records.set(paramName, undefined); return; }
      const fields = recordType.fields;
      const nestedFields = (type: TypeNode): Map<string, RecordFieldInfo> | undefined => {
        if (type.kind !== "RecordTypeNode") {
          const containsOptionalRecord = (value: unknown): boolean => {
            if (!value || typeof value !== "object") return false;
            if (Array.isArray(value)) return value.some(containsOptionalRecord);
            const node = value as Record<string, unknown>;
            if (node.kind === "RecordTypeNode" && Array.isArray(node.fields) && node.fields.some((field: any) => field.optional || field.defaultValue)) return true;
            return Object.entries(node).some(([key, child]) => key !== "span" && containsOptionalRecord(child));
          };
          if (containsOptionalRecord(type)) throw new FunScriptError("Optional records inside callbacks or container types are not supported yet", type.span);
          return undefined;
        }
        const result = new Map<string, RecordFieldInfo>();
        for (const field of type.fields) {
          const children = nestedFields(field.typeAnnotation);
          result.set(field.name.name, { optional: Boolean(field.optional), fields: children });
        }
        return [...result.values()].some((field) => field.optional || field.fields) ? result : undefined;
      };
      if (!fields.some((field) => field.optional || field.defaultValue || nestedFields(field.typeAnnotation))) { records.set(paramName, undefined); return; }
      const mapped = new Map<string, RecordFieldInfo>();
      fields.forEach((field, fieldIndex) => {
        const binding = field.defaultValue ? `$funscriptField${paramIndex}_${fieldIndex}` : undefined;
        if (field.defaultValue) {
          this.validateRecordDefault(field.defaultValue, new Set(expr.params.flatMap((p) => this.collectBindingNames(p.name))));
          const raw = `$funscriptFieldRaw${paramIndex}_${fieldIndex}`;
          recordDefaults.push(`  const ${raw} = ${paramName}.${field.name.name};`);
          recordDefaults.push(`  const ${binding} = ${raw} === undefined ? ${this.emitExpression(field.defaultValue)} : ${raw};`);
        }
        const children = nestedFields(field.typeAnnotation);
        mapped.set(field.name.name, { optional: Boolean(field.optional), defaultBinding: binding, fields: children });
      });
      records.set(paramName, mapped);
    });
    const aliases = new Set<BindingDeclaration>();
    if (expr.body.kind === "BlockStatement") {
      for (const stmt of expr.body.statements) {
        if (stmt.kind !== "BindingDeclaration" || stmt.isMut || stmt.isJs || stmt.init.kind !== "Identifier" || !("name" in stmt.id) || records.has(stmt.id.name)) continue;
        const fields = records.get(stmt.init.name);
        if (!fields || [...fields.values()].some((field) => field.defaultBinding)) continue;
        records.set(stmt.id.name, fields);
        aliases.add(stmt);
      }
    }
    const paramScopeEntries: [string, boolean][] = [];
    for (const p of expr.params) {
      for (const n of this.collectBindingNames(p.name)) {
        paramScopeEntries.push([n, Boolean(p.optional)]);
      }
    }
    this.parameterScopes.push(new Map(paramScopeEntries));
    this.recordScopes.push(records);
    try {
      for (const name of records.keys()) if (records.get(name)) this.validateRecordParameterUse(expr, name, aliases);
      if (expr.body.kind === "BlockStatement" || optionalBindings.length || recordDefaults.length) {
        const body = this.emitFunctionBody(expr.body);
        return `${typeParams}(${params})${retType} => {\n${[...optionalBindings, ...recordDefaults, body].filter(Boolean).join("\n")}\n}`;
      }
      return `${typeParams}(${params})${retType} => ${this.emitArrowExpression(expr.body)}`;
    } finally {
      this.recordScopes.pop();
      this.parameterScopes.pop();
    }
  }

  private emitFunctionBody(body: FunctionBody): string {
    if (body.kind === "BlockStatement") {
      const stmts = body.statements.map((s) => "  " + this.emitStatement(s)).join("\n");
      const isUnit = body.finalExpression && (body.finalExpression.kind === "Identifier" || body.finalExpression.kind === "UpperIdentifier") && body.finalExpression.name === "Unit";
      const ret = isUnit
        ? "  return;"
        : body.finalExpression
        ? `  return ${this.emitExpression(body.finalExpression)};`
        : "";
      if (stmts && ret) return `${stmts}\n${ret}`;
      if (stmts) return stmts;
      if (ret) return ret;
      return "";
    }
    const isUnit = (body.kind === "Identifier" || body.kind === "UpperIdentifier") && body.name === "Unit";
    if (isUnit) return "  return;";
    return `  return ${this.emitExpression(body)};`;
  }

  private emitArrowExpression(expr: Expression): string {
    const emitted = this.emitExpression(expr);
    return expr.kind === "RecordExpression" ? `(${emitted})` : emitted;
  }

  private emitIndexTarget(expr: IndexExpression): string {
    return `${this.emitExpression(expr.object)}[${this.emitExpression(expr.index)}]`;
  }

  private emitStatement(stmt: Statement): string {
    if (stmt.kind === "BindingDeclaration") {
      return this.emitBindingDeclaration(stmt);
    }
    if (stmt.kind === "AssignmentStatement") {
      const target = stmt.target.kind === "Identifier"
        ? stmt.target.name
        : stmt.target.kind === "IndexExpression"
        ? this.emitIndexTarget(stmt.target)
        : stmt.target.path.map((p) => p.name).join(".");
      return `${target} = ${this.emitExpression(stmt.value)};`;
    }
    if (stmt.kind === "ReturnStatement") {
      if ((stmt.argument.kind === "Identifier" || stmt.argument.kind === "UpperIdentifier") && stmt.argument.name === "Unit") {
        return "return;";
      }
      const arg = this.emitExpression(stmt.argument);
      if (arg.startsWith("(") && arg.endsWith(")")) {
        return `return ${arg};`;
      }
      return `return (${arg});`;
    }
    if (stmt.kind === "WhenStatement") {
      return this.emitWhenStatement(stmt);
    }
    return `${this.emitExpression(stmt.expression)};`;
  }

  private emitWhenStatement(stmt: WhenStatement, insideEffect = false): string {
    const cond = this.emitExpression(stmt.condition);
    if (stmt.isEarlyReturn) {
      const consequence = stmt.consequent as Expression;
      if (
        insideEffect &&
        consequence.kind === "CallExpression" &&
        consequence.callee.kind === "MemberExpression" &&
        consequence.callee.object.kind === "UpperIdentifier" &&
        consequence.callee.object.name === "Effect" &&
        consequence.callee.property.name === "fail"
      ) {
        return `if (${cond}) return yield* ${this.emitEffectCall(consequence)};`;
      }
      return `if (${cond}) return ${this.emitExpression(consequence)};`;
    }
    const body = stmt.consequent as BlockStatement;
    const stmts = body.statements.map((s) => "  " + this.emitStatement(s)).join("\n");
    const ret = body.finalExpression && (body.finalExpression.kind !== "Identifier" || (body.finalExpression as Identifier).name !== "_error")
      ? `  ${this.emitExpression(body.finalExpression)};`
      : "";
    const allStmts = [stmts, ret].filter(Boolean).join("\n");
    return `if (${cond}) {\n${allStmts}\n}`;
  }

  private emitMatchExpression(expr: MatchExpression): string {
    if (!expr.scrutinee && !expr.isPipeline) {
      // Subjectless boolean match => ? : ternary or if / else
      let code = "";
      for (let i = 0; i < expr.arms.length; i++) {
        const arm = expr.arms[i];
        const isDefault = arm.pattern.kind === "WildcardPattern";
        const body = arm.body.kind === "BlockStatement" ? `(() => {\n${this.emitFunctionBody(arm.body)}\n})()` : this.emitExpression(arm.body);

        if (isDefault || i === expr.arms.length - 1) {
          code += body;
          break;
        } else {
          const cond = this.emitPatternAsCondition(arm.pattern);
          code += `${cond} ? ${body} : `;
        }
      }
      return `(${code})`;
    }

    // Scrutinee match or pipeline match => ts-pattern
    this.needsTsPattern = true;
    const isPipe = Boolean(expr.isPipeline);
    let code = isPipe ? `(($v) => match($v)` : `match(${this.emitExpression(expr.scrutinee!)})`;
    const optionalRecord = expr.scrutinee ? this.recordField(expr.scrutinee) : undefined;
    const payloadFields = optionalRecord?.optional ? optionalRecord.fields : undefined;

    for (const arm of expr.arms) {
      let payloadName: string | undefined;
      if (payloadFields) {
        const pat = arm.pattern;
        if (pat.kind === "ConstructorPattern" && pat.constructorName.name === "Some" && pat.args.length === 1 && pat.args[0].kind === "VariablePattern") {
          payloadName = pat.args[0].name.name;
        } else if (!(pat.kind === "WildcardPattern" || (pat.kind === "ConstructorPattern" && pat.constructorName.name === "None" && pat.args.length === 0))) {
          throw new FunScriptError("Match an optional record with Some(name), None, or _", pat.span);
        }
      }
      if (payloadName && payloadFields) {
        this.recordScopes.push(new Map([[payloadName, payloadFields]]));
        this.parameterScopes.push(new Map([[payloadName, false]]));
        const validateBody = (body: FunctionBody) => {
          const synthetic = { kind: "FunctionExpression", params: [{ kind: "Parameter", name: { kind: "Identifier", name: payloadName, span: arm.span }, span: arm.span }], body, span: arm.span } as FunctionExpression;
          this.validateRecordParameterUse(synthetic, payloadName!, new Set());
        };
        validateBody(arm.body);
        if (arm.guard) validateBody(arm.guard);
      }
      try {
      if (arm.pattern.kind === "WildcardPattern") {
        const body = this.emitArmHandler(arm.body, arm.pattern, expr.scrutinee);
        code += `\n  .otherwise(${body})`;
      } else {
        const pat = this.emitPattern(arm.pattern);
        const body = this.emitArmHandler(arm.body, arm.pattern, expr.scrutinee);
        if (arm.guard) {
          let guardFn: string;
          if (arm.pattern.kind === "RecordPattern") {
            const destructParts = this.collectRecordDestructuring(arm.pattern);
            const scrutineeName = expr.scrutinee?.kind === "Identifier" ? expr.scrutinee.name : undefined;
            if (destructParts.length > 0) {
              const lines = [
                ...(scrutineeName ? [`const ${scrutineeName} = $matched;`] : []),
                `const { ${destructParts.join(", ")} } = $matched;`,
                `return ${this.emitExpression(arm.guard)};`,
              ];
              guardFn = `($matched) => {\n    ${lines.join("\n    ")}\n  }`;
            } else if (scrutineeName) {
              guardFn = `(${scrutineeName}) => ${this.emitExpression(arm.guard)}`;
            } else {
              guardFn = `($matched) => ${this.emitExpression(arm.guard)}`;
            }
          } else if (arm.pattern.kind === "OrPattern" && arm.pattern.patterns.every((p) => p.kind === "RecordPattern")) {
            const scrutineeName = expr.scrutinee?.kind === "Identifier" ? expr.scrutinee.name : undefined;
            if (scrutineeName) {
              guardFn = `(${scrutineeName}) => ${this.emitExpression(arm.guard)}`;
            } else {
              guardFn = `($matched) => ${this.emitExpression(arm.guard)}`;
            }
          } else {
            const vars = this.collectPatternVariables(arm.pattern);
            if (vars.length > 0) {
              const some = arm.pattern.kind === "ConstructorPattern" && arm.pattern.constructorName.name === "Some" && arm.pattern.args.length === 1 && arm.pattern.args[0].kind === "VariablePattern" && vars.length === 1;
              const directOptional = expr.scrutinee?.kind === "Identifier" && this.isOptionalParameter(expr.scrutinee.name);
              const unpack = some && directOptional ? `const { value: ${vars[0]} } = $matched;` : some ? `const { _tag: _, ...__fields } = $matched;\n    const [${vars[0]}] = Object.values(__fields) as [typeof $matched extends import("effect").Option.Some<infer V> ? V : any];` : `const { _tag: _, ...__fields } = $matched as any;\n    const [${vars.join(", ")}] = Object.values(__fields) as any[];`;
              guardFn = `($matched) => {\n    ${unpack}\n    return ${this.emitExpression(arm.guard)};\n  }`;
            } else {
              guardFn = `() => ${this.emitExpression(arm.guard)}`;
            }
          }
          code += `\n  .with(${pat}, ${guardFn}, ${body})`;
        } else {
          code += `\n  .with(${pat}, ${body})`;
        }
      }
      } finally {
        if (payloadName && payloadFields) {
          this.parameterScopes.pop();
          this.recordScopes.pop();
        }
      }
    }

    if (!expr.arms.some((a) => a.pattern.kind === "WildcardPattern")) {
      code += `\n  .exhaustive()`;
    }

    if (isPipe) {
      code += `)`;
    }

    return code;
  }

  private emitPatternAsCondition(pattern: Pattern): string {
    if (pattern.kind === "LiteralPattern") {
      if ((pattern.literal as any).rawExpr) {
        return this.emitExpression((pattern.literal as any).rawExpr);
      }
      if (pattern.literal.kind === "BooleanLiteral") {
        return pattern.literal.value ? "true" : "false";
      }
      if (pattern.literal.kind === "NumberLiteral") {
        return `${pattern.literal.value}`;
      }
      return this.emitStringLiteral(pattern.literal);
    }
    return "true";
  }

  private emitPattern(pat: Pattern): string {
    if (pat.kind === "WildcardPattern") return "P._";
    if (pat.kind === "LiteralPattern") {
      if (pat.literal.kind === "BooleanLiteral") return pat.literal.value ? "true" : "false";
      if (pat.literal.kind === "NumberLiteral") return `${pat.literal.value}`;
      return this.emitStringLiteral(pat.literal);
    }
    if (pat.kind === "VariablePattern") return `P.select("${pat.name.name}")`;
    if (pat.kind === "ConstructorPattern") {
      if (pat.args.length === 0) {
        return `{ _tag: "${pat.constructorName.name}" }`;
      }
      // Tagged union positional pattern matches fields
      return `{ _tag: "${pat.constructorName.name}" }`;
    }
    if (pat.kind === "OrPattern") {
      const sub = pat.patterns.map((p) => this.emitPattern(p)).join(", ");
      return `P.union(${sub})`;
    }
    if (pat.kind === "RecordPattern") {
      const fields = pat.fields
        .map((f) => {
          if (!f.pattern || f.pattern.kind === "VariablePattern") {
            return `${f.key.name}: P._`;
          }
          return `${f.key.name}: ${this.emitPattern(f.pattern)}`;
        })
        .join(", ");
      return `{ ${fields} }`;
    }
    if (pat.kind === "ArrayPattern") {
      const elements: string[] = [];
      for (const el of pat.elements) {
        if (el.kind === "RestPattern") {
          elements.push("...P.array()");
        } else if (el.kind === "VariablePattern" || el.kind === "WildcardPattern") {
          elements.push("P._");
        } else {
          elements.push(this.emitPattern(el));
        }
      }
      return `[${elements.join(", ")}]`;
    }
    return "P._";
  }

  private collectRecordDestructuring(pat: RecordPattern): string[] {
    const parts: string[] = [];
    for (const f of pat.fields) {
      if (!f.pattern) {
        parts.push(f.key.name);
      } else if (f.pattern.kind === "VariablePattern") {
        parts.push(`${f.key.name}: ${f.pattern.name.name}`);
      } else if (f.pattern.kind === "RecordPattern") {
        const sub = this.collectRecordDestructuring(f.pattern);
        if (sub.length > 0) {
          parts.push(`${f.key.name}: { ${sub.join(", ")} }`);
        }
      } else if (f.pattern.kind === "ArrayPattern") {
        parts.push(`${f.key.name}: ${this.emitBindingTarget(f.pattern)}`);
      }
    }
    return parts;
  }

  private emitArmHandler(body: FunctionBody, pat?: Pattern, scrutinee?: Expression): string {
    if (pat?.kind === "RecordPattern") {
      const destructParts = this.collectRecordDestructuring(pat);
      const scrutineeName = scrutinee?.kind === "Identifier" ? scrutinee.name : undefined;

      if (destructParts.length > 0) {
        const lines: string[] = [];
        if (scrutineeName) {
          lines.push(`const ${scrutineeName} = $matched;`);
        }
        lines.push(`const { ${destructParts.join(", ")} } = $matched;`);
        if (body.kind === "BlockStatement") {
          return `($matched) => {\n    ${lines.join("\n    ")}\n${this.emitFunctionBody(body)}\n  }`;
        }
        return `($matched) => {\n    ${lines.join("\n    ")}\n    return ${this.emitExpression(body)};\n  }`;
      }

      if (scrutineeName) {
        if (body.kind === "BlockStatement") {
          return `(${scrutineeName}) => {\n${this.emitFunctionBody(body)}\n}`;
        }
        return `(${scrutineeName}) => ${this.emitArrowExpression(body)}`;
      }

      if (body.kind === "BlockStatement") {
        return `($matched) => {\n${this.emitFunctionBody(body)}\n}`;
      }
      return `($matched) => ${this.emitArrowExpression(body)}`;
    }

    if (pat?.kind === "ArrayPattern") {
      const scrutineeName = scrutinee?.kind === "Identifier" ? scrutinee.name : undefined;
      const bindingStr = this.emitBindingTarget(pat);
      const lines: string[] = [];
      if (scrutineeName) {
        lines.push(`const ${scrutineeName} = $matched;`);
      }
      if (pat.elements.length > 0 && bindingStr !== "[]") {
        lines.push(`const ${bindingStr} = $matched;`);
      }
      if (lines.length > 0) {
        if (body.kind === "BlockStatement") {
          return `($matched: any) => {\n    ${lines.join("\n    ")}\n${this.emitFunctionBody(body)}\n  }`;
        }
        return `($matched: any) => {\n    ${lines.join("\n    ")}\n    return ${this.emitExpression(body)};\n  }`;
      }
      if (body.kind === "BlockStatement") {
        return `() => {\n${this.emitFunctionBody(body)}\n}`;
      }
      return `() => ${this.emitArrowExpression(body)}`;
    }

    if (pat?.kind === "OrPattern" && pat.patterns.every((p) => p.kind === "RecordPattern")) {
      const scrutineeName = scrutinee?.kind === "Identifier" ? scrutinee.name : undefined;
      if (scrutineeName) {
        if (body.kind === "BlockStatement") {
          return `(${scrutineeName}) => {\n${this.emitFunctionBody(body)}\n}`;
        }
        return `(${scrutineeName}) => ${this.emitArrowExpression(body)}`;
      }
      if (body.kind === "BlockStatement") {
        return `($matched) => {\n${this.emitFunctionBody(body)}\n}`;
      }
      return `($matched) => ${this.emitArrowExpression(body)}`;
    }

    const vars = pat ? this.collectPatternVariables(pat) : [];
    const isOptional = scrutinee ? this.isOptionalValue(scrutinee) : false;
    if (pat?.kind === "ConstructorPattern" && pat.constructorName.name === "Some" && pat.args.length === 1) {
      const bindingTarget = this.emitBindingTarget(pat.args[0]);
      if (bindingTarget && bindingTarget !== "[]" && bindingTarget !== "{}") {
        const unpack = isOptional
          ? `const { value: ${bindingTarget} } = $matched;`
          : `const { value: ${bindingTarget} } = $matched as unknown as { value: typeof $matched extends import("effect").Option.Some<infer V> ? V : any };`;
        if (body.kind === "BlockStatement") return `($matched) => {\n    ${unpack}\n${this.emitFunctionBody(body)}\n  }`;
        return `($matched) => {\n    ${unpack}\n    return ${this.emitExpression(body)};\n  }`;
      }
      if (body.kind === "BlockStatement") return `() => {\n${this.emitFunctionBody(body)}\n}`;
      return `() => ${this.emitArrowExpression(body)}`;
    }
    if (vars.length > 0) {
      const unpack = `const { _tag: _, ...__fields } = $matched as any;\n    const [${vars.join(", ")}] = Object.values(__fields) as any[];`;
      if (body.kind === "BlockStatement") {
        return `($matched) => {\n    ${unpack}\n${this.emitFunctionBody(body)}\n  }`;
      }
      return `($matched) => {\n    ${unpack}\n    return ${this.emitExpression(body)};\n  }`;
    }

    if (body.kind === "BlockStatement") {
      return `() => {\n${this.emitFunctionBody(body)}\n}`;
    }
    return `() => ${this.emitArrowExpression(body)}`;
  }

  private collectPatternVariables(pat: Pattern): string[] {
    if (pat.kind === "VariablePattern") return [pat.name.name];
    if (pat.kind === "ConstructorPattern") {
      const vars: string[] = [];
      for (const a of pat.args) {
        vars.push(...this.collectPatternVariables(a));
      }
      return vars;
    }
    if (pat.kind === "OrPattern") {
      return pat.patterns.length > 0 ? this.collectPatternVariables(pat.patterns[0]) : [];
    }
    if (pat.kind === "RecordPattern") {
      const vars: string[] = [];
      for (const f of pat.fields) {
        if (!f.pattern) {
          vars.push(f.key.name);
        } else {
          vars.push(...this.collectPatternVariables(f.pattern));
        }
      }
      return vars;
    }
    if (pat.kind === "ArrayPattern") {
      const vars: string[] = [];
      for (const el of pat.elements) {
        vars.push(...this.collectPatternVariables(el));
      }
      return vars;
    }
    if (pat.kind === "RestPattern") {
      return this.collectPatternVariables(pat.argument);
    }
    return [];
  }

  private emitEffectBlockExpression(expr: EffectBlockExpression): string {
    this.effectImports.add("Effect");
    const statements = expr.body
      .map((s) => {
        if (s.kind === "EffectBindStatement") {
          return `    const ${this.emitBindingTarget(s.id)} = yield* ${this.emitEffectCall(s.effect)};`;
        }
        if (s.kind === "EffectDiscardStatement") {
          return `    yield* ${this.emitEffectCall(s.effect)};`;
        }
        if (s.kind === "BindingDeclaration") {
          return `    ${this.emitBindingDeclaration(s)}`;
        }
        if (s.kind === "AssignmentStatement") {
          const target = s.target.kind === "Identifier"
            ? s.target.name
            : s.target.kind === "IndexExpression"
            ? this.emitIndexTarget(s.target)
            : s.target.path.map((p) => p.name).join(".");
          return `    ${target} = ${this.emitExpression(s.value)};`;
        }
        if (s.kind === "WhenStatement") {
          return `    ${this.emitWhenStatement(s, true)}`;
        }
        return "";
      })
      .join("\n");

    const isUnit = (expr.finalExpression.kind === "Identifier" || expr.finalExpression.kind === "UpperIdentifier") && expr.finalExpression.name === "Unit";
    const ret = isUnit
      ? `    return;`
      : `    return ${this.emitExpression(expr.finalExpression)};`;
    return `Effect.gen(function* () {\n${statements}\n${ret}\n  })`;
  }

  private emitEffectCall(effectExpr: Expression): string {
    if (effectExpr.kind === "JsExpression") {
      return this.emitJsExpression(effectExpr);
    }
    // Check if this is a direct service call: Service.method(args)
    if (effectExpr.kind === "CallExpression" && effectExpr.callee.kind === "MemberExpression") {
      const obj = effectExpr.callee.object;
      if (obj.kind === "UpperIdentifier") {
        if (EFFECT_BUILTIN_MODULES.has(obj.name) || this.effectModuleBindings.has(obj.name) || obj.name === "Promise") {
          return `${obj.name}.${this.emitMemberProperty(effectExpr.callee)}(${effectExpr.args.map((a) => this.emitExpression(a)).join(", ")})`;
        }
        // Direct Service Call: Service.method(...) => (yield* Service).method(...)
        return `(yield* ${obj.name}).${effectExpr.callee.property.name}(${effectExpr.args.map((a) => this.emitExpression(a)).join(", ")})`;
      }
    }
    return this.emitExpression(effectExpr);
  }

  // --- Types ---

  private emitTypeParameters(typeParams: TypeParameter[] | undefined, forArrowExpression = false): string {
    if (!typeParams || typeParams.length === 0) return "";
    const params = typeParams.map((param) =>
      param.constraint
        ? `${param.name.name} extends ${this.emitTypeNode(param.constraint)}`
        : param.name.name,
    );
    // TypeScript parses `<A>(...)` as JSX in `.tsx` (and in JSX-enabled contexts like Vite);
    // a trailing comma keeps unconstrained generic arrow functions valid in both `.ts` and `.tsx`.
    const needsTsxComma = forArrowExpression && (this.options.isJsx || typeParams.length === 1) && typeParams.every((param) => !param.constraint);
    return `<${params.join(", ")}${needsTsxComma ? "," : ""}>`;
  }

  private emitTypeNode(node: TypeNode): string {
    switch (node.kind) {
      case "QualifiedTypeReferenceNode": {
        const name = node.parts.map((part) => part.name).join(".");
        return node.typeArgs?.length ? `${name}<${node.typeArgs.map((arg) => this.emitTypeNode(arg)).join(", ")}>` : name;
      }
      case "TypeReferenceNode": {
        let name = node.name.name;
        if (name === "SchemaInput" && !this.declaredTypeNames.has(name)) {
          const arg = node.typeArgs?.[0];
          if (node.typeArgs?.length !== 1 || arg?.kind !== "TypeReferenceNode" || arg.typeArgs?.length) {
            throw new Error("SchemaInput requires one named schema, for example SchemaInput<User>");
          }
          return `typeof ${arg.name.name}.Encoded`;
        }
        if (name === "HtmlProps") {
          const tag = node.typeArgs?.[0] ? this.emitTypeNode(node.typeArgs[0]) : '"div"';
          return `React.ComponentPropsWithoutRef<${tag}>`;
        }
        if (PRIMITIVE_TYPES[name]) return PRIMITIVE_TYPES[name];
        if (name === "Array" && !this.declaredTypeNames.has(name)) name = "ReadonlyArray";
        else if (name === "Map" && !this.declaredTypeNames.has(name)) name = "ReadonlyMap";
        else if (name === "Set" && !this.declaredTypeNames.has(name)) name = "ReadonlySet";
        else if (["Option", "Record", "Duration", "Result"].includes(name) && !this.declaredTypeNames.has(name)) {
          this.effectImports.add(name);
          name = name === "Record" ? "Record.ReadonlyRecord" : `${name}.${name}`;
        }
        if (node.typeArgs && node.typeArgs.length > 0) {
          return `${name}<${node.typeArgs.map((t) => this.emitTypeNode(t)).join(", ")}>`;
        }
        return name;
      }
      case "FunctionTypeNode": {
        const params = node.params
          .map((p) => {
            const rest = p.isRest ? "..." : "";
            const name = p.name ? this.emitBindingTarget(p.name) : "_";
            const opt = p.optional ? "?" : "";
            if (p.optional && p.typeAnnotation) {
              this.effectImports.add("Option");
              const baseType = this.emitTypeNode(p.typeAnnotation);
              return `${rest}${name}${opt}: ${baseType} | Option.Option<${baseType}>`;
            }
            return p.typeAnnotation ? `${rest}${name}${opt}: ${this.emitTypeNode(p.typeAnnotation)}` : `${rest}${name}${opt}`;
          })
          .join(", ");
        return `${this.emitTypeParameters(node.typeParams)}(${params}) => ${this.emitTypeNode(node.returnType)}`;
      }
      case "EffectTypeNode": {
        this.effectImports.add("Effect");
        const succ = this.emitTypeNode(node.success);
        const err = node.error ? this.emitTypeNode(node.error) : "never";
        const req = node.requirements ? this.emitTypeNode(node.requirements) : "never";
        return `Effect.Effect<${succ}, ${err}, ${req}>`;
      }
      case "RecordTypeNode": {
        const fields = node.fields.map((f) => `readonly ${emitPropertyKey(f.name.name)}${f.optional || f.defaultValue ? "?" : ""}: ${this.emitTypeNode(f.typeAnnotation)}`).join("; ");
        return `{ ${fields} }`;
      }
      case "ArrayTypeNode":
        return `ReadonlyArray<${this.emitTypeNode(node.elementType)}>`;
      case "UnionTypeNode":
        return node.types.map((t) => this.emitTypeNode(t)).join(" | ");
      case "IntersectionTypeNode":
        return node.types.map((t) => this.emitTypeNode(t)).join(" & ");
      case "LiteralTypeNode":
        return JSON.stringify(node.value);
      case "TypeQueryNode":
        return `typeof ${this.emitExpression(node.expr)}`;
      case "IndexedAccessTypeNode":
        return `${this.emitTypeNode(node.objectType)}[${this.emitTypeNode(node.indexType)}]`;
      case "ParenthesizedTypeNode":
        return `(${this.emitTypeNode(node.typeNode)})`;
      case "TsEscapeTypeNode":
        return node.code;
    }
  }

  // --- JSX ---

  public emitJsxElement(el: JSXElement): string {
    const tagName = this.emitJsxTagName(el.openingElement.name);
    const attrs = el.openingElement.attributes.map((a) => this.emitJsxAttribute(a)).join(" ");
    const attrsStr = attrs.length > 0 ? ` ${attrs}` : "";
    const openTag = tagName === "" ? "<>" : `<${tagName}${attrsStr}>`;
    const closeTag = tagName === "" ? "</>" : `</${tagName}>`;
    const childrenStr = el.children.map((c) => this.emitJsxChild(c)).join("");
    return `${openTag}${childrenStr}${closeTag}`;
  }

  public emitJsxSelfClosingElement(el: JSXSelfClosingElement): string {
    const tagName = this.emitJsxTagName(el.name);
    const attrs = el.attributes.map((a) => this.emitJsxAttribute(a)).join(" ");
    const attrsStr = attrs.length > 0 ? ` ${attrs}` : "";
    if (tagName === "") {
      return `<${attrsStr} />`;
    }
    return `<${tagName}${attrsStr} />`;
  }

  public emitJsxTagName(name: JSXTagName): string {
    switch (name.kind) {
      case "Identifier":
      case "UpperIdentifier":
        return name.name;
      case "MemberExpression":
        return `${this.emitJsxTagName(name.object as JSXTagName)}.${name.property.name}`;
      default:
        return "";
    }
  }

  public emitJsxAttribute(attr: JSXAttribute): string {
    if (attr.kind === "JSXSpreadAttribute") return `{...${this.emitExpression(attr.argument)}}`;
    const name = attr.name.name;
    if (attr.value === undefined) {
      return name;
    }
    if (attr.value.kind === "StringLiteral") {
      const isSimple = attr.value.parts.every((p) => p.kind === "StringRawPart");
      if (isSimple) {
        const rawVal = attr.value.parts.map((p) => (p as any).value).join("");
        return `${name}=${JSON.stringify(rawVal)}`;
      }
      return `${name}={${this.emitStringLiteral(attr.value)}}`;
    }
    if (attr.value.kind === "JSXExpressionContainer") {
      return `${name}={${this.emitExpression(attr.value.expression)}}`;
    }
    return `${name}={${this.emitExpression(attr.value)}}`;
  }

  public emitJsxExpressionContainer(container: JSXExpressionContainer): string {
    return `{${this.emitExpression(container.expression)}}`;
  }

  public emitJsxText(text: JSXText): string {
    return text.value;
  }

  public emitJsxChild(child: JSXChild): string {
    switch (child.kind) {
      case "JSXText":
        return this.emitJsxText(child);
      case "JSXExpressionContainer":
        return this.emitJsxExpressionContainer(child);
      case "JSXElement":
        return this.emitJsxElement(child);
      case "JSXSelfClosingElement":
        return this.emitJsxSelfClosingElement(child);
    }
  }
}
