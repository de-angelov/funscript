import ts from "typescript";
import {
  type BinaryExpression,
  type BindingDeclaration,
  type BindingTarget,
  type CallExpression,
  type EffectBlockExpression,
  type ErrorDeclaration,
  type Expression,
  type FunctionBody,
  type FunctionExpression,
  type Identifier,
  type IndexExpression,
  type JsExpression,
  type JSXAttribute,
  type JSXChild,
  type JSXElement,
  type JSXExpressionContainer,
  type JSXSelfClosingElement,
  type JSXTagName,
  type JSXText,
  type MatchExpression,
  type MemberExpression,
  type MutBlockExpression,
  type ParBlockExpression,
  type Pattern,
  type PipelineExpression,
  type Program,
  type RecordExpression,
  type RecordPattern,
  type RecordTypeField,
  type SchemaDeclaration,
  type ServiceDeclaration,
  type Statement,
  type StringLiteral,
  type TaggedTemplateExpression,
  type TaggedUnionSchema,
  type TemplateLiteral,
  type TopLevelDeclaration,
  type TypeNode,
  type TypeParameter,
  type UnaryExpression,
  type UpperIdentifier,
  type WhenStatement,
  type Span,
} from "../ast/types.js";
import {
  isRecordContract,
  recordContractType,
} from "../compiler/record-contracts.js";
import { FunScriptError } from "../errors.js";
import {
  collectBindingNames,
  emitBindingDeclaration,
  emitErrorDeclaration,
  emitServiceDeclaration,
  emitTopLevelDeclaration,
  emitUnpackedRecordPattern,
  extractRecordFields,
  isPrimitiveType,
  patternHasOptionalField,
} from "./declarations.js";
import {
  emitJsxAttribute,
  emitJsxChild,
  emitJsxElement,
  emitJsxExpressionContainer,
  emitJsxSelfClosingElement,
  emitJsxTagName,
  emitJsxText,
} from "./jsx.js";
import { MatchEmitter, type RecordFieldInfo } from "./match.js";
import {
  COMPANION_IMPORT_SOURCE,
  PIPELINE_COMPANION_CATALOG,
  type PipelineCompanionModule,
} from "./pipeline-catalog.js";
import {
  COMPARISON_METHOD_MAP,
  ES_TOOLKIT_METHODS,
  PipelineResolver,
} from "./pipeline-resolution.js";
import { emitRuntimeHelpers } from "./runtime-helpers.js";
import { emitSchemaDeclaration, emitSchemaTypeField } from "./schemas.js";
import {
  emitArrowExpression,
  emitEffectBlockExpression,
  emitEffectCall,
  emitIndexTarget,
  emitMutativeRecipe,
  emitParBlockExpression,
  emitStatement,
  emitWhenStatement,
} from "./statements.js";
import {
  EFFECT_BUILTIN_MODULES,
  emitPropertyKey,
  emitTypeNode,
  emitTypeParameters,
} from "./types.js";
export {
  COMPARISON_METHOD_MAP,
  ES_TOOLKIT_DATA_LAST_CALLS,
  ES_TOOLKIT_MATH_COLLECTION,
  ES_TOOLKIT_MATH_DATA_LAST,
  ES_TOOLKIT_METHODS,
  ES_TOOLKIT_STRING_METHODS,
  ES_TOOLKIT_TIMING_DATA_LAST,
  PipelineResolutionError,
} from "./pipeline-resolution.js";

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
  /** Wrap logical `and`/`or` operands so the checker can enforce boolean-only use. */
  markBooleanOperands?: boolean;
  /** Preserve source locations of ordinary call arguments during checker analysis. */
  markCallArguments?: boolean;
  forwardOptionalArguments?: ReadonlySet<number>;
  forwardNullArguments?: ReadonlySet<number>;
  forwardOptionalProperties?: ReadonlySet<number>;
  forwardNullProperties?: ReadonlySet<number>;
  /** Pre-resolved Effect schema expressions for imported data types keyed by schema name. */
  importedSchemas?: ReadonlyMap<string, string>;
  /** Direct imported FunScript functions with verified optional-record parameters. */
  importedRecordFunctions?: ReadonlyMap<string, ReadonlySet<number>>;
  importedRecordContracts?: ReadonlyMap<
    string,
    import("../ast/types.js").RecordTypeNode
  >;
  /** Direct imported data schemas verified to have an identity encoding. */
  importedIdentitySchemas?: ReadonlySet<string>;
  importedGenericDataSchemas?: ReadonlyMap<string, number>;
  importedDataSchemas?: ReadonlySet<string>;
  importedNullishSchemas?: ReadonlyMap<string, ReadonlyMap<string, TypeNode>>;
  importedTaggedUnionVariants?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Whether the output is `.tsx`; generic arrows need a comma there. */
  isJsx?: boolean;
  context?: import("../compiler/typescript-context.js").TypeScriptCompilationContext;
  modularEffectImports?: boolean;
}

export const EFFECT_MODULE_NAMES = new Set([
  ...Object.keys(PIPELINE_COMPANION_CATALOG),
  "Context",
  "Data",
  "Duration",
  "Equal",
  "Number",
  "pipe",
]);

const BANNED_INSTANCE_METHODS = new Map<
  string,
  { category: string; replacement: string; pipeline: string }
>([
  // Array methods
  [
    "map",
    {
      category: "array",
      replacement: "Array.map",
      pipeline: "|> Array.map(...)",
    },
  ],
  [
    "filter",
    {
      category: "array",
      replacement: "Array.filter",
      pipeline: "|> Array.filter(...)",
    },
  ],
  [
    "reduce",
    {
      category: "array",
      replacement: "Array.reduce",
      pipeline: "|> Array.reduce(...)",
    },
  ],
  [
    "reduceRight",
    {
      category: "array",
      replacement: "Array.reduceRight",
      pipeline: "|> Array.reduceRight(...)",
    },
  ],
  [
    "flatMap",
    {
      category: "array",
      replacement: "Array.flatMap",
      pipeline: "|> Array.flatMap(...)",
    },
  ],
  [
    "flat",
    {
      category: "array",
      replacement: "Array.flatten",
      pipeline: "|> Array.flatten",
    },
  ],
  [
    "find",
    {
      category: "array",
      replacement: "Array.findFirst",
      pipeline: "|> Array.findFirst(...)",
    },
  ],
  [
    "findIndex",
    {
      category: "array",
      replacement: "Array.findFirstIndex",
      pipeline: "|> Array.findFirstIndex(...)",
    },
  ],
  [
    "findLast",
    {
      category: "array",
      replacement: "Array.findLast",
      pipeline: "|> Array.findLast(...)",
    },
  ],
  [
    "findLastIndex",
    {
      category: "array",
      replacement: "Array.findLastIndex",
      pipeline: "|> Array.findLastIndex(...)",
    },
  ],
  [
    "some",
    {
      category: "array",
      replacement: "Array.some",
      pipeline: "|> Array.some(...)",
    },
  ],
  [
    "every",
    {
      category: "array",
      replacement: "Array.every",
      pipeline: "|> Array.every(...)",
    },
  ],
  [
    "sort",
    {
      category: "array",
      replacement: "Array.sort",
      pipeline: "|> Array.sort(...)",
    },
  ],
  [
    "reverse",
    {
      category: "array",
      replacement: "Array.reverse",
      pipeline: "|> Array.reverse",
    },
  ],
  [
    "push",
    {
      category: "array",
      replacement: "Array.append",
      pipeline: "|> Array.append(...)",
    },
  ],
  [
    "pop",
    {
      category: "array",
      replacement: "Array.unappend",
      pipeline: "|> Array.unappend",
    },
  ],
  [
    "shift",
    {
      category: "array",
      replacement: "Array.unprepend",
      pipeline: "|> Array.unprepend",
    },
  ],
  [
    "unshift",
    {
      category: "array",
      replacement: "Array.prepend",
      pipeline: "|> Array.prepend(...)",
    },
  ],
  [
    "splice",
    {
      category: "array",
      replacement: "Array.remove / Array.modify",
      pipeline: "Array.remove(...)",
    },
  ],

  // String methods
  [
    "trim",
    {
      category: "string",
      replacement: "String.trim",
      pipeline: "|> String.trim",
    },
  ],
  [
    "trimStart",
    {
      category: "string",
      replacement: "String.trimStart",
      pipeline: "|> String.trimStart",
    },
  ],
  [
    "trimEnd",
    {
      category: "string",
      replacement: "String.trimEnd",
      pipeline: "|> String.trimEnd",
    },
  ],
  [
    "toLowerCase",
    {
      category: "string",
      replacement: "String.toLowerCase",
      pipeline: "|> String.toLowerCase",
    },
  ],
  [
    "toUpperCase",
    {
      category: "string",
      replacement: "String.toUpperCase",
      pipeline: "|> String.toUpperCase",
    },
  ],
  [
    "toLocaleLowerCase",
    {
      category: "string",
      replacement: "String.toLocaleLowerCase",
      pipeline: "|> String.toLocaleLowerCase",
    },
  ],
  [
    "toLocaleUpperCase",
    {
      category: "string",
      replacement: "String.toLocaleUpperCase",
      pipeline: "|> String.toLocaleUpperCase",
    },
  ],
  [
    "startsWith",
    {
      category: "string",
      replacement: "String.startsWith",
      pipeline: "|> String.startsWith(...)",
    },
  ],
  [
    "endsWith",
    {
      category: "string",
      replacement: "String.endsWith",
      pipeline: "|> String.endsWith(...)",
    },
  ],
  [
    "split",
    {
      category: "string",
      replacement: "String.split",
      pipeline: "|> String.split(...)",
    },
  ],
  [
    "replace",
    {
      category: "string",
      replacement: "String.replace",
      pipeline: "|> String.replace(...)",
    },
  ],
  [
    "replaceAll",
    {
      category: "string",
      replacement: "String.replaceAll",
      pipeline: "|> String.replaceAll(...)",
    },
  ],
  [
    "padStart",
    {
      category: "string",
      replacement: "String.padStart",
      pipeline: "|> String.padStart(...)",
    },
  ],
  [
    "padEnd",
    {
      category: "string",
      replacement: "String.padEnd",
      pipeline: "|> String.padEnd(...)",
    },
  ],
  [
    "repeat",
    {
      category: "string",
      replacement: "String.repeat",
      pipeline: "|> String.repeat(...)",
    },
  ],

  // Collection mutation methods
  [
    "add",
    {
      category: "collection",
      replacement: "HashSet.add",
      pipeline: "|> HashSet.add(...)",
    },
  ],
  [
    "clear",
    {
      category: "collection",
      replacement: "HashMap.empty() / HashSet.empty()",
      pipeline: "HashMap.empty()",
    },
  ],
  [
    "delete",
    {
      category: "collection",
      replacement: "HashMap.remove / Record.remove",
      pipeline: "|> HashMap.remove(...)",
    },
  ],
  [
    "set",
    {
      category: "collection",
      replacement: "HashMap.set / Record.set",
      pipeline: "|> HashMap.set(...)",
    },
  ],

  // Date mutation methods
  [
    "setFullYear",
    { category: "date", replacement: "DateTime.*", pipeline: "|> DateTime.*" },
  ],
  [
    "setMonth",
    { category: "date", replacement: "DateTime.*", pipeline: "|> DateTime.*" },
  ],
  [
    "setDate",
    { category: "date", replacement: "DateTime.*", pipeline: "|> DateTime.*" },
  ],
  [
    "setHours",
    { category: "date", replacement: "DateTime.*", pipeline: "|> DateTime.*" },
  ],
  [
    "setMinutes",
    { category: "date", replacement: "DateTime.*", pipeline: "|> DateTime.*" },
  ],
  [
    "setSeconds",
    { category: "date", replacement: "DateTime.*", pipeline: "|> DateTime.*" },
  ],
  [
    "setTime",
    { category: "date", replacement: "DateTime.*", pipeline: "|> DateTime.*" },
  ],
  [
    "setMilliseconds",
    { category: "date", replacement: "DateTime.*", pipeline: "|> DateTime.*" },
  ],
]);

const BANNED_OBJECT_STATIC_METHODS = new Map<string, string>([
  ["keys", "Record.keys(...)"],
  ["values", "Record.values(...)"],
  ["entries", "Record.toEntries(...)"],
  ["fromEntries", "Record.fromEntries(...)"],
  ["assign", "Record.union(...) or object spread '{ ...a, ...b }'"],
  [
    "freeze",
    "plain record literals '{ ... }' (FunScript records are already immutable)",
  ],
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

const NATIVE_CONSTRUCTOR_NAMES = new Set([
  "Number",
  "String",
  "Boolean",
  "Array",
]);

interface EmitContext {
  readonly inPipelineStage: boolean;
  readonly currentPlaceholderParam: string | null;
  readonly inTryContext: boolean;
  readonly pendingTryThunk: boolean;
  readonly pendingTryRecord: boolean;
  readonly activeSchemaParameters?: ReadonlySet<string>;
}

export class Emitter {
  private effectImports = new Set<string>();
  public parameterScopes: Array<Map<string, boolean>> = [];
  public variableTypeScopes: Array<Map<string, TypeNode | undefined>> = [];
  public recordScopes: Array<
    Map<string, Map<string, RecordFieldInfo> | undefined>
  > = [];
  private userEffectBindings = new Set<string>();
  public effectModuleBindings = new Set<string>();
  private userEsToolkitBindings = new Set<string>();
  public userImportBindings = new Set<string>();
  private esToolkitImports = new Set<string>();
  private needsTsPattern = false;
  private needsMutative = false;
  private needsReferenceEquality = false;
  private needsJsInterop = false;
  private needsDecodeUnknown = false;
  private needsFromNullishOrElse = false;
  private needsFromNullishOr = false;
  private needsOptionTry = false;
  public primitiveIdentifiers = new Set<string>();
  private placeholderCounter = 0;
  public bindings = new Map<string, BindingDeclaration>();
  private emitCtx: EmitContext = {
    inPipelineStage: false,
    currentPlaceholderParam: null,
    inTryContext: false,
    pendingTryThunk: false,
    pendingTryRecord: false,
  };

  private withEmitContext<T>(patch: Partial<EmitContext>, fn: () => T): T {
    const prev = this.emitCtx;
    this.emitCtx = { ...prev, ...patch };
    try {
      return fn();
    } finally {
      this.emitCtx = prev;
    }
  }
  public activeDraftParams = new Set<string>();

  public declaredTypeNames = new Set<string>();
  public runtimeSchemaNames = new Set<string>();
  public genericDataSchemas = new Map<string, number>();
  public genericSchemaDeclarations = new Map<string, SchemaDeclaration>();
  public get activeSchemaParameters(): ReadonlySet<string> | undefined {
    return this.emitCtx.activeSchemaParameters;
  }

  public withSchemaParameters<T>(names: ReadonlySet<string>, fn: () => T): T {
    return this.withEmitContext({ activeSchemaParameters: names }, fn);
  }

  public readonly unsafeSchemaBinding: boolean;
  public recordContracts = new Map<
    string,
    import("../ast/types.js").RecordTypeNode
  >();
  private readonly nullishSchemaFields = new Map<
    string,
    Map<string, TypeNode>
  >();
  private readonly typeSignatureSchemas = new Map<string, TypeNode>();
  public needsCheckedRecordDecoder = false;
  public checkedCallbackKinds = new Set<"sync" | "void" | "effect">();
  public identityRecordSchemas = new Set<string>();
  public checkedTaggedSchemas = new Map<string, TaggedUnionSchema>();
  public variantFields = new Map<string, string[]>();
  private taggedUnionVariants = new Map<string, Set<string>>();
  public modularEffectImports: boolean;

  public getRecordTypeNode(
    name: string,
  ): import("../ast/types.js").RecordTypeNode | undefined {
    return this.recordContracts.get(name);
  }

  public addEffectImport(name: string): void {
    this.effectImports.add(name);
  }

  constructor(
    private program?: Program,
    contextProgram?: Program,
    public options: EmitterOptions = {},
  ) {
    this.modularEffectImports = options.modularEffectImports ?? false;
    for (const [name, contract] of options.importedRecordContracts ?? [])
      this.recordContracts.set(name, contract);
    for (const [name, fields] of options.importedNullishSchemas ?? [])
      this.nullishSchemaFields.set(name, new Map(fields));
    for (const [name, variants] of options.importedTaggedUnionVariants ?? [])
      this.taggedUnionVariants.set(name, new Set(variants));
    // Source-map emission renders declarations individually, but resolution
    // still needs the bindings from the complete source program.
    let unsafeSchemaBinding = false;
    const allItems = (contextProgram ?? program)?.body ?? [];
    for (const item of allItems) {
      const decl = item.kind === "ExportDeclaration" ? item.declaration : item;
      if (item.kind === "ImportDeclaration") {
        for (const spec of item.specifiers) {
          if (
            spec.local.name === "Schema" &&
            (item.isTypeOnly ||
              spec.isTypeOnly ||
              item.source.raw !== '"effect"' ||
              spec.imported.name !== "Schema")
          )
            unsafeSchemaBinding = true;
        }
        if (
          item.namespaceBinding?.name === "Schema" &&
          (item.isTypeOnly || item.source.raw !== '"effect/Schema"')
        )
          unsafeSchemaBinding = true;
        if (!item.isTypeOnly) {
          for (const spec of item.specifiers) {
            if (!spec.isTypeOnly) this.userImportBindings.add(spec.local.name);
          }
          if (item.namespaceBinding)
            this.userImportBindings.add(item.namespaceBinding.name);
        }
      }
      if (item.kind === "ImportDeclaration" && item.source.raw === '"effect"') {
        for (const spec of item.specifiers)
          this.userEffectBindings.add(spec.local.name);
      }
      if (
        item.kind === "ImportDeclaration" &&
        item.source.raw === '"es-toolkit"'
      ) {
        for (const spec of item.specifiers)
          this.userEsToolkitBindings.add(spec.local.name);
      }
      if (
        item.kind === "ImportDeclaration" &&
        /^"effect(?:\/|")/.test(item.source.raw)
      ) {
        for (const spec of item.specifiers)
          this.effectModuleBindings.add(spec.local.name);
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
      if (decl.kind === "BindingDeclaration" && "name" in decl.id)
        this.bindings.set(decl.id.name, decl);
    }
    this.unsafeSchemaBinding = unsafeSchemaBinding;

    const staticTypeNames = new Set<string>();
    for (const [name] of this.recordContracts) staticTypeNames.add(name);
    for (const item of allItems) {
      const decl = item.kind === "ExportDeclaration" ? item.declaration : item;
      if (
        decl.kind === "SchemaDeclaration" &&
        decl.body.kind === "TypeSignatureSchema"
      ) {
        staticTypeNames.add(decl.id.name);
        if (!decl.typeParams?.length) {
          this.typeSignatureSchemas.set(decl.id.name, decl.body.signature);
        }
      }
    }
    for (const item of allItems) {
      const decl = item.kind === "ExportDeclaration" ? item.declaration : item;
      if (
        decl.kind === "SchemaDeclaration" &&
        decl.body.kind === "RecordSchema"
      ) {
        const fields = new Map<string, TypeNode>();
        for (const field of decl.body.fields) {
          const resolvedFieldType = this.unwrapTypeAlias(field.typeAnnotation);
          if (
            resolvedFieldType?.kind === "TypeReferenceNode" &&
            resolvedFieldType.name.name === "JSNullish"
          ) {
            fields.set(field.name.name, resolvedFieldType);
          }
        }
        if (fields.size) this.nullishSchemaFields.set(decl.id.name, fields);
      }
    }
    // Conservative whitelist: only local, non-transforming record codecs are used
    // for generated Effect callback adapters. Optional/defaulted fields can change
    // their encoded representation and are deliberately excluded.
    const identityType = (type: TypeNode): boolean => {
      if (type.kind === "LiteralTypeNode") return true;
      if (type.kind === "UnionTypeNode") return type.types.every(identityType);
      if (type.kind === "ParenthesizedTypeNode")
        return identityType(type.typeNode);
      return (
        type.kind === "TypeReferenceNode" &&
        !type.typeArgs?.length &&
        ((["String", "Number", "Boolean"].includes(type.name.name) &&
          !this.declaredTypeNames.has(type.name.name)) ||
          this.identityRecordSchemas.has(type.name.name))
      );
    };
    let addedIdentity = true;
    while (addedIdentity) {
      addedIdentity = false;
      for (const item of allItems) {
        const decl =
          item.kind === "ExportDeclaration" ? item.declaration : item;
        if (
          decl.kind !== "SchemaDeclaration" ||
          decl.body.kind !== "RecordSchema" ||
          decl.typeParams?.length ||
          this.identityRecordSchemas.has(decl.id.name)
        )
          continue;
        if (
          decl.body.fields.every(
            (field) =>
              !field.defaultValue && identityType(field.typeAnnotation),
          )
        ) {
          this.identityRecordSchemas.add(decl.id.name);
          addedIdentity = true;
        }
      }
    }
    for (const item of allItems) {
      const decl = item.kind === "ExportDeclaration" ? item.declaration : item;
      if (
        decl.kind === "SchemaDeclaration" &&
        decl.body.kind === "TaggedUnionSchema"
      ) {
        this.taggedUnionVariants.set(
          decl.id.name,
          new Set(decl.body.variants.map((variant) => variant.name.name)),
        );
        for (const variant of decl.body.variants) {
          this.variantFields.set(
            variant.name.name,
            variant.fields.map((f) => f.name.name),
          );
        }
      }
    }
    // These codecs can be checked in place without transforming tagged payloads.
    // Optional/defaulted, recursive, generic, and unverified imports stay excluded.
    for (const item of allItems) {
      const decl = item.kind === "ExportDeclaration" ? item.declaration : item;
      if (
        decl.kind === "SchemaDeclaration" &&
        decl.body.kind === "TaggedUnionSchema" &&
        !decl.typeParams?.length &&
        decl.body.variants.length > 0 &&
        decl.body.variants.every((variant) =>
          variant.fields.every(
            (field) =>
              field.name.name !== "_tag" &&
              field.typeAnnotation.kind === "TypeReferenceNode" &&
              !field.typeAnnotation.typeArgs?.length &&
              ((["String", "Number", "Boolean"].includes(
                field.typeAnnotation.name.name,
              ) &&
                !this.declaredTypeNames.has(field.typeAnnotation.name.name)) ||
                this.identityRecordSchemas.has(
                  field.typeAnnotation.name.name,
                ) ||
                this.options.importedIdentitySchemas?.has(
                  field.typeAnnotation.name.name,
                ) === true),
          ),
        )
      ) {
        this.checkedTaggedSchemas.set(decl.id.name, decl.body);
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of allItems) {
        const decl =
          item.kind === "ExportDeclaration" ? item.declaration : item;
        if (
          decl.kind === "SchemaDeclaration" &&
          decl.body.kind === "RecordSchema" &&
          !staticTypeNames.has(decl.id.name)
        ) {
          const visibleStatics = new Set(staticTypeNames);
          for (const param of decl.typeParams ?? [])
            visibleStatics.delete(param.name.name);
          if (isRecordContract(decl.body, visibleStatics)) {
            staticTypeNames.add(decl.id.name);
            changed = true;
          }
        }
      }
    }

    for (const item of allItems) {
      const decl = item.kind === "ExportDeclaration" ? item.declaration : item;
      if (decl.kind === "SchemaDeclaration") {
        if (
          decl.body.kind === "RecordSchema" &&
          staticTypeNames.has(decl.id.name)
        ) {
          this.recordContracts.set(decl.id.name, recordContractType(decl.body));
        } else if (
          (decl.body.kind === "RecordSchema" &&
            !staticTypeNames.has(decl.id.name)) ||
          decl.body.kind === "StructuralUnionSchema" ||
          decl.body.kind === "RefinementSchema" ||
          decl.body.kind === "TsDerivedSchema" ||
          decl.body.kind === "ImportedTsSchema"
        ) {
          this.runtimeSchemaNames.add(decl.id.name);
        }
      }
    }
    for (const item of allItems) {
      const decl = item.kind === "ExportDeclaration" ? item.declaration : item;
      if (
        decl.kind === "SchemaDeclaration" &&
        (decl.body.kind === "RecordSchema" ||
          decl.body.kind === "StructuralUnionSchema") &&
        decl.typeParams?.length &&
        !this.recordContracts.has(decl.id.name)
      ) {
        this.genericDataSchemas.set(decl.id.name, decl.typeParams.length);
        this.genericSchemaDeclarations.set(decl.id.name, decl);
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
    const generatedEffectImports = Array.from(this.effectImports).filter(
      (name) => {
        const asMatch = /^(.+?)\s+as\s+(.+)$/.exec(name);
        const localName = asMatch ? asMatch[2] : name;
        const source = COMPANION_IMPORT_SOURCE[asMatch ? asMatch[1] : name];
        if (source) return !this.userImportBindings.has(localName);
        return !this.userEffectBindings.has(localName);
      },
    );
    if (generatedEffectImports.length > 0) {
      if (this.modularEffectImports) {
        for (const name of generatedEffectImports.sort()) {
          const asMatch = /^(.+?)\s+as\s+(.+)$/.exec(name);
          const moduleName = asMatch ? asMatch[1] : name;
          const localName = asMatch ? asMatch[2] : name;
          const source = COMPANION_IMPORT_SOURCE[moduleName];
          if (moduleName === "pipe") {
            const spec =
              localName === moduleName ? "pipe" : `pipe as ${localName}`;
            header += `import { ${spec} } from "effect/Function";\n`;
          } else if (source) {
            const spec =
              localName === moduleName
                ? moduleName
                : `${moduleName} as ${localName}`;
            header += `import { ${spec} } from ${JSON.stringify(source)};\n`;
          } else {
            header += `import * as ${localName} from "effect/${moduleName}";\n`;
          }
        }
      } else {
        const bySource = new Map<string, string[]>();
        for (const name of generatedEffectImports.sort()) {
          const asMatch = /^(.+?)\s+as\s+(.+)$/.exec(name);
          const moduleName = asMatch ? asMatch[1] : name;
          const source = COMPANION_IMPORT_SOURCE[moduleName] ?? "effect";
          const list = bySource.get(source) ?? [];
          list.push(name);
          bySource.set(source, list);
        }
        for (const source of [...bySource.keys()].sort()) {
          const sorted = bySource.get(source)!.join(", ");
          header += `import { ${sorted} } from ${JSON.stringify(source)};\n`;
        }
      }
    }
    const generatedEsToolkitImports = Array.from(this.esToolkitImports)
      .filter((name) => !this.userEsToolkitBindings.has(name))
      .map((name) => (name === "slug" ? "kebabCase as slug" : name))
      .sort((a, b) => a.localeCompare(b));
    if (generatedEsToolkitImports.length > 0) {
      header += `import { ${generatedEsToolkitImports.join(", ")} } from "es-toolkit";\n`;
    }
    if (this.needsCheckedRecordDecoder) {
      const helpers = ["decodeCheckedRecord as $funscriptDecodeCheckedRecord"];
      if (this.checkedCallbackKinds.has("sync"))
        helpers.push("checkedSync as $funscriptCheckedSync");
      if (this.checkedCallbackKinds.has("void"))
        helpers.push("checkedSyncVoid as $funscriptCheckedSyncVoid");
      if (this.checkedCallbackKinds.has("effect"))
        helpers.push(
          "checkedEffect as $funscriptCheckedEffect",
          "type CallbackBoundaryError as $funscriptCallbackBoundaryError",
        );
      header += `import { ${helpers.join(", ")} } from "funscript/callback";\n`;
    }
    if (this.needsTsPattern) {
      header += `import { match, P } from "ts-pattern";\n`;
    }
    if (this.needsMutative) {
      header += `import { create } from "mutative";\n`;
    }
    header += emitRuntimeHelpers({
      referenceEquality: this.needsReferenceEquality,
      jsInterop: this.needsJsInterop,
      decodeUnknown: this.needsDecodeUnknown,
      fromNullishOrElse: this.needsFromNullishOrElse,
      fromNullishOr: this.needsFromNullishOr,
      optionTry: this.needsOptionTry,
    });

    if (header.length > 0) {
      header += "\n";
    }

    return header + bodyCode.trim() + "\n";
  }

  private emitTopLevelDeclaration(
    decl: TopLevelDeclaration,
    isExport = false,
  ): string {
    return emitTopLevelDeclaration(this, decl, isExport);
  }

  public emitSchemaDeclaration(
    decl: SchemaDeclaration,
    isExport: boolean,
  ): string {
    return emitSchemaDeclaration(this, decl, isExport);
  }

  public emitSchemaTypeField(typeNode: TypeNode): string {
    return emitSchemaTypeField(this, typeNode);
  }

  public emitErrorDeclaration(
    decl: ErrorDeclaration,
    isExport: boolean,
  ): string {
    return emitErrorDeclaration(this, decl, isExport);
  }

  public emitServiceDeclaration(
    decl: ServiceDeclaration,
    isExport: boolean,
  ): string {
    return emitServiceDeclaration(this, decl, isExport);
  }

  public isPrimitiveType(type?: TypeNode): boolean {
    return isPrimitiveType(type);
  }

  public isPrimitive(expr: Expression): boolean {
    if (
      expr.kind === "NumberLiteral" ||
      expr.kind === "StringLiteral" ||
      expr.kind === "BooleanLiteral"
    ) {
      return true;
    }
    if (expr.kind === "UnaryExpression") {
      return true;
    }
    if (expr.kind === "BinaryExpression") {
      return true;
    }
    if (
      expr.kind === "Identifier" &&
      this.primitiveIdentifiers.has(expr.name)
    ) {
      return true;
    }
    return false;
  }

  private isOptionalParameter(name: string): boolean {
    return (
      [...this.parameterScopes]
        .reverse()
        .find((scope) => scope.has(name))
        ?.get(name) ?? false
    );
  }

  public recordFields(name: string): Map<string, RecordFieldInfo> | undefined {
    for (let i = this.recordScopes.length - 1; i >= 0; i--) {
      if (this.recordScopes[i].has(name)) return this.recordScopes[i].get(name);
    }
    return undefined;
  }

  public recordField(expr: Expression): RecordFieldInfo | undefined {
    if (
      expr.kind === "IndexExpression" &&
      expr.index.kind === "StringLiteral"
    ) {
      const propName = expr.index.parts
        .map((p) => ("value" in p ? String(p.value) : ""))
        .join("");
      const fields =
        expr.object.kind === "Identifier"
          ? this.recordFields(expr.object.name)
          : this.recordField(expr.object)?.fields;
      return fields?.get(propName);
    }
    if (expr.kind !== "MemberExpression") return undefined;
    const fields =
      expr.object.kind === "Identifier"
        ? this.recordFields(expr.object.name)
        : this.recordField(expr.object)?.fields;
    return fields?.get(expr.property.name);
  }

  public getTypeNodeForIdentifier(name: string): TypeNode | undefined {
    for (let i = this.variableTypeScopes.length - 1; i >= 0; i--) {
      if (this.variableTypeScopes[i].has(name)) {
        return this.variableTypeScopes[i].get(name);
      }
    }
    return this.bindings.get(name)?.typeAnnotation;
  }

  private unwrapTypeAlias(
    type: TypeNode | undefined,
    visited: Set<string> = new Set(),
  ): TypeNode | undefined {
    let curr = type;
    while (
      curr?.kind === "TypeReferenceNode" &&
      !curr.typeArgs?.length &&
      this.typeSignatureSchemas.has(curr.name.name) &&
      !visited.has(curr.name.name)
    ) {
      visited.add(curr.name.name);
      curr = this.typeSignatureSchemas.get(curr.name.name);
    }
    return curr;
  }

  public getTypeNodeForExpression(expr: Expression): TypeNode | undefined {
    return this.unwrapTypeAlias(
      this.resolveExpressionTypeNode(expr, new Set()),
    );
  }

  private resolveExpressionTypeNode(
    expr: Expression,
    visited: Set<string>,
  ): TypeNode | undefined {
    if (expr.kind === "Identifier") {
      for (let i = this.variableTypeScopes.length - 1; i >= 0; i--) {
        if (this.variableTypeScopes[i].has(expr.name))
          return this.variableTypeScopes[i].get(expr.name);
      }
      if (visited.has(expr.name)) return undefined;
      const binding = this.bindings.get(expr.name);
      if (!binding) return undefined;
      if (binding.typeAnnotation) return binding.typeAnnotation;
      visited.add(expr.name);
      return this.resolveExpressionTypeNode(binding.init, visited);
    }
    if (expr.kind === "FunctionExpression" && expr.returnType) {
      return {
        kind: "FunctionTypeNode",
        params: expr.params,
        typeParams: expr.typeParams,
        returnType: expr.returnType,
        span: expr.span,
      };
    }
    if (expr.kind === "CallExpression") {
      const callee = this.resolveExpressionTypeNode(expr.callee, visited);
      if (callee?.kind === "FunctionTypeNode") return callee.returnType;
    }
    if (expr.kind === "MemberExpression") {
      const objType = this.resolveExpressionTypeNode(expr.object, visited);
      if (!objType) return undefined;
      let recordType: TypeNode | undefined = objType;
      if (recordType.kind === "TypeReferenceNode") {
        const nullishField = this.nullishSchemaFields
          .get(recordType.name.name)
          ?.get(expr.property.name);
        if (nullishField) return nullishField;
        if (
          recordType.name.name === "Option" &&
          recordType.typeArgs?.length === 1
        ) {
          recordType = recordType.typeArgs[0];
        } else {
          recordType = this.recordContracts.get(recordType.name.name);
        }
      }
      if (recordType?.kind === "RecordTypeNode") {
        const field = recordType.fields.find(
          (f) => f.name.name === expr.property.name,
        );
        return field?.typeAnnotation;
      }
    }
    return undefined;
  }

  private isTargetNativeCategory(
    expr: Expression,
    category: string,
    prop: string,
    visitedBindings: Set<string> = new Set(),
  ): boolean {
    if (category === "array" && expr.kind === "ArrayExpression") return true;
    if (
      category === "string" &&
      (expr.kind === "StringLiteral" || expr.kind === "TemplateLiteral")
    )
      return true;
    if (expr.kind === "CallExpression") {
      const callee = expr.callee;
      if (callee.kind === "Identifier" || callee.kind === "UpperIdentifier") {
        if (category === "array" && callee.name === "Array") return true;
        if (
          category === "collection" &&
          (callee.name === "Map" ||
            callee.name === "Set" ||
            callee.name === "WeakMap" ||
            callee.name === "WeakSet")
        )
          return true;
        if (category === "date" && callee.name === "Date") return true;
      }
    }

    const typeNode = this.getTypeNodeForExpression(expr);
    if (typeNode) {
      if (typeNode.kind === "ArrayTypeNode") {
        return category === "array";
      }
      if (typeNode.kind === "TypeReferenceNode") {
        const typeName = typeNode.name.name;
        if (typeName === "Array" || typeName === "ReadonlyArray") {
          return category === "array";
        }
        if (typeName === "String" || typeName === "string") {
          return category === "string";
        }
        if (
          typeName === "Map" ||
          typeName === "Set" ||
          typeName === "WeakMap" ||
          typeName === "WeakSet"
        ) {
          return category === "collection";
        }
        if (typeName === "Date") {
          return category === "date";
        }
        // Any other type reference (URLSearchParams, Headers, FormData, Request, Response, URL, Observable, QueryBuilder, Parser, Store, etc.)
        // is NOT a native JavaScript type replaced by Effect.
        return false;
      }
      if (
        typeNode.kind === "RecordTypeNode" ||
        typeNode.kind === "FunctionTypeNode"
      ) {
        return false;
      }
    }

    if (expr.kind === "Identifier") {
      const name = expr.name;
      // Check if initialized from a binding
      const binding = this.bindings.get(name);
      if (binding) {
        if (!visitedBindings.has(name)) {
          visitedBindings.add(name);
          if (
            this.isTargetNativeCategory(
              binding.init,
              category,
              prop,
              visitedBindings,
            )
          ) {
            return true;
          }
        }
      }
    }

    // TypeScript TypeChecker check (for unannotated identifiers, ts escape blocks, external imports)
    if (this.options.context) {
      const checker = this.options.context.getTypeChecker();
      const program = this.options.context.getProgram();
      if (checker && program && expr.kind === "Identifier") {
        const sourceFile = program.getSourceFile(
          this.options.context.getNormalizedFilename(),
        );
        if (sourceFile) {
          const tsType = this.findTsTypeForIdentifier(
            sourceFile,
            checker,
            expr.name,
          );
          if (tsType) {
            const symName = tsType.symbol?.name ?? tsType.aliasSymbol?.name;
            if (category === "array") {
              return (
                checker.isArrayType(tsType) ||
                symName === "Array" ||
                symName === "ReadonlyArray"
              );
            }
            if (category === "string") {
              return Boolean(tsType.flags & ts.TypeFlags.StringLike);
            }
            if (category === "collection") {
              return (
                symName === "Map" ||
                symName === "Set" ||
                symName === "WeakMap" ||
                symName === "WeakSet"
              );
            }
            if (category === "date") {
              return symName === "Date";
            }
            return false;
          }
        }
      }
    }

    return false;
  }

  private findTsTypeForIdentifier(
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
    name: string,
  ): ts.Type | undefined {
    let foundType: ts.Type | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === name) {
        foundType = checker.getTypeAtLocation(node);
      }
      if (!foundType) {
        ts.forEachChild(node, visit);
      }
    };
    visit(sourceFile);
    return foundType;
  }

  private isHtmlPropsType(type?: TypeNode): boolean {
    if (!type) return false;
    if (type.kind === "TypeReferenceNode" && type.name.name === "HtmlProps")
      return true;
    if (type.kind === "IntersectionTypeNode") {
      return type.types.some((t) => this.isHtmlPropsType(t));
    }
    return false;
  }

  public isOptionalValue(expr: Expression): boolean {
    if (expr.kind === "Identifier") return this.isOptionalParameter(expr.name);
    if (expr.kind === "MemberExpression")
      return this.recordField(expr)?.optional ?? false;
    if (expr.kind === "IndexExpression") return true;
    return false;
  }

  private validateRecordDefault(
    value: Expression,
    currentParamNames: Set<string>,
    subsequentParamNames: Set<string>,
  ): void {
    const visit = (
      item: unknown,
      parent?: Record<string, unknown>,
      key?: string,
    ): void => {
      if (!item || typeof item !== "object") return;
      if (Array.isArray(item)) {
        for (const child of item) visit(child, parent, key);
        return;
      }
      const node = item as Record<string, unknown>;
      if (node.kind === "Identifier" && typeof node.name === "string") {
        if (
          (parent?.kind === "MemberExpression" && key === "property") ||
          (parent?.kind === "FieldEntry" && key === "key")
        )
          return;
        if (currentParamNames.has(node.name)) {
          throw new FunScriptError(
            `Defaulted record field cannot reference its own record parameter '${node.name}'`,
            node.span as Span | undefined,
          );
        }
        if (subsequentParamNames.has(node.name)) {
          throw new FunScriptError(
            `Parameter '${node.name}' cannot be referenced in a default value before its declaration`,
            node.span as Span | undefined,
          );
        }
      }
      for (const [childKey, child] of Object.entries(node)) {
        if (
          childKey !== "span" &&
          childKey !== "typeAnnotation" &&
          childKey !== "returnType"
        )
          visit(child, node, childKey);
      }
    };
    visit(value);
  }

  public emitBindingDeclaration(
    decl: BindingDeclaration,
    isExport = false,
  ): string {
    return emitBindingDeclaration(this, decl, isExport);
  }

  public emitBindingTarget(target: BindingTarget | Pattern): string {
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
      const arg = this.emitBindingTarget(target.argument);
      return arg ? `...${arg}` : "";
    }
    if (target.kind === "RecordPattern") {
      const fields = target.fields.map((f) => {
        if (f.isRest) {
          return `...${f.key.name}`;
        }
        if (
          !f.pattern ||
          (f.pattern.kind === "VariablePattern" &&
            f.pattern.name.name === f.key.name)
        ) {
          return f.key.name;
        }
        return `${f.key.name}: ${this.emitBindingTarget(f.pattern)}`;
      });
      return `{ ${fields.join(", ")} }`;
    }
    if (target.kind === "ArrayPattern") {
      const elements = target.elements.map((el) => this.emitBindingTarget(el));
      while (elements.length > 0 && elements[elements.length - 1] === "") {
        elements.pop();
      }
      return `[${elements.join(", ")}]`;
    }
    return "_";
  }

  public collectBindingNames(target: BindingTarget | Pattern): string[] {
    return collectBindingNames(target);
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
        if (this.recordContracts.has(expr.name))
          throw new FunScriptError(
            `${expr.name} is a compile-time record contract, not a runtime schema. Validate data separately and use an explicit checked callback boundary for foreign functions.`,
            expr.span,
          );
        if (expr.name === "Void") return "undefined";
        if (expr.name === "dbg" && !this.isUserBinding("dbg")) {
          return `((__v: any) => { console.log(__v); return __v; })`;
        }
        if (
          EFFECT_BUILTIN_MODULES.has(expr.name) &&
          !NATIVE_CONSTRUCTOR_NAMES.has(expr.name) &&
          !this.isUserBinding(expr.name)
        ) {
          this.effectImports.add(expr.name);
        }
        const fields = this.recordFields(expr.name);
        if (fields) {
          const defaults = [...fields.entries()].filter(
            ([_, info]) => info.defaultBinding,
          );
          if (defaults.length > 0) {
            return `({ ...${expr.name}, ${defaults.map(([key, info]) => `${key}: ${info.defaultBinding}`).join(", ")} })`;
          }
        }
        return expr.name;
      case "Placeholder":
        return this.emitCtx.currentPlaceholderParam ?? "__placeholder";
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
        const prop = expr.property.name;
        if (
          prop === "decodeJson" ||
          prop === "decodeJsonSync" ||
          prop === "encodeJson" ||
          prop === "encodeJsonSync"
        ) {
          this.effectImports.add("Schema");
          const schema = this.emitExpression(expr.object);
          let combinator = "Schema.decodeUnknownEffect";
          if (prop === "decodeJsonSync")
            combinator = "Schema.decodeUnknownSync";
          else if (prop === "encodeJson") combinator = "Schema.encodeEffect";
          else if (prop === "encodeJsonSync") combinator = "Schema.encodeSync";
          return `${combinator}(Schema.fromJsonString(${schema}))`;
        }
        const raw = `${this.emitExpression(expr.object)}.${this.emitMemberProperty(expr)}`;
        const field = this.recordField(expr);
        if (field?.defaultBinding) return field.defaultBinding;
        if (field?.optional) {
          this.effectImports.add("Option");
          return `Option.fromNullishOr(${raw})`;
        }
        return raw;
      }
      case "IndexExpression": {
        const raw = `${this.emitExpression(expr.object)}[${this.emitExpression(expr.index)}]`;
        const field = this.recordField(expr);
        if (field?.defaultBinding) return field.defaultBinding;
        if (field?.optional) {
          this.effectImports.add("Option");
          return `Option.fromNullishOr(${raw})`;
        }
        if (expr.index.kind === "StringLiteral") {
          return raw;
        }
        this.needsFromNullishOr = true;
        this.effectImports.add("Option");
        return `fromNullishOr(${raw})`;
      }
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
      case "ParBlockExpression":
        return this.emitParBlockExpression(expr);
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

  public emitJsExpression(expr: JsExpression): string {
    this.effectImports.add("Effect");
    this.effectImports.add("Option");
    this.needsJsInterop = true;
    // compiler.ts replaces this provisional flag with the nullability inferred
    // from the native TypeScript return type.
    const inner = this.emitInTryContext(expr.expression);
    if (
      expr.expression.kind === "FunctionExpression" &&
      expr.expression.params.length === 0
    ) {
      return `__funscriptJs(${inner}, false)`;
    }
    const wrapped =
      expr.expression.kind === "RecordExpression" ? `(${inner})` : inner;
    return `__funscriptJs(() => ${wrapped}, false)`;
  }

  public emitMemberProperty(expr: MemberExpression): string {
    if (
      expr.object.kind === "UpperIdentifier" &&
      expr.object.name === "Effect"
    ) {
      const replacement =
        expr.property.name === "catchAll"
          ? "catch"
          : expr.property.name === "fork"
            ? "forkChild"
            : undefined;
      if (replacement) {
        throw new FunScriptError(
          `Effect.${expr.property.name} was removed; use Effect.${replacement} instead.`,
          expr.span,
        );
      }
    }
    return expr.property.name;
  }

  public emitMutativeRecipe(expr: MutBlockExpression): string {
    return emitMutativeRecipe(this, expr);
  }

  public emitStringLiteral(lit: StringLiteral): string {
    if (lit.parts.length === 1 && lit.parts[0].kind === "StringRawPart") {
      return JSON.stringify(lit.parts[0].value);
    }
    const template = lit.parts
      .map((p) => {
        if (p.kind === "StringRawPart")
          return p.value.replace(/`/g, "\\`").replace(/\${/g, "\\${");
        return `\${${this.emitExpression(p.expression)}}`;
      })
      .join("");
    return `\`${template}\``;
  }

  private emitTemplateLiteral(lit: TemplateLiteral): string {
    const template = lit.parts
      .map((p) => {
        if (p.kind === "StringRawPart")
          return p.value.replace(/`/g, "\\`").replace(/\${/g, "\\${");
        return `\${${this.emitExpression(p.expression)}}`;
      })
      .join("");
    return `\`${template}\``;
  }

  private emitTaggedTemplateExpression(expr: TaggedTemplateExpression): string {
    const tag = this.emitExpression(expr.tag);
    let typeArgs = "";
    if (expr.typeArguments && expr.typeArguments.length > 0) {
      typeArgs =
        "<" +
        expr.typeArguments.map((t) => this.emitTypeNode(t)).join(", ") +
        ">";
    }
    return `${tag}${typeArgs}${this.emitTemplateLiteral(expr.template)}`;
  }

  private emitCallExpression(expr: CallExpression): string {
    if (
      !this.isUserBinding("dbg") &&
      expr.callee.kind === "Identifier" &&
      expr.callee.name === "dbg"
    ) {
      if (expr.args.length === 1) {
        const val = this.emitExpression(expr.args[0]);
        return `((__v) => { console.log(__v); return __v; })(${val})`;
      }
      if (expr.args.length >= 2) {
        const label = this.emitExpression(expr.args[0]);
        const val = this.emitExpression(expr.args[1]);
        return `((__v) => { console.log(${label}, __v); return __v; })(${val})`;
      }
      return `((__v: any) => { console.log(__v); return __v; })`;
    }

    if (
      expr.callee.kind === "Identifier" &&
      !this.isUserBinding(expr.callee.name)
    ) {
      const name = expr.callee.name;
      if (
        name === "decodeJson" ||
        name === "decodeJsonSync" ||
        name === "encodeJson" ||
        name === "encodeJsonSync"
      ) {
        this.effectImports.add("Schema");
        const schema =
          expr.args.length > 0
            ? this.emitExpression(expr.args[0])
            : "Schema.Unknown";
        let combinator = "Schema.decodeUnknownEffect";
        if (name === "decodeJsonSync") combinator = "Schema.decodeUnknownSync";
        else if (name === "encodeJson") combinator = "Schema.encodeEffect";
        else if (name === "encodeJsonSync") combinator = "Schema.encodeSync";

        const codec = `${combinator}(Schema.fromJsonString(${schema}))`;
        if (expr.args.length >= 2) {
          const target = this.emitExpression(expr.args[1]);
          return `${codec}(${target})`;
        }
        return codec;
      }
    }

    if (
      expr.callee.kind === "MemberExpression" &&
      (expr.callee.property.name === "decodeJson" ||
        expr.callee.property.name === "decodeJsonSync" ||
        expr.callee.property.name === "encodeJson" ||
        expr.callee.property.name === "encodeJsonSync")
    ) {
      this.effectImports.add("Schema");
      const schema = this.emitExpression(expr.callee.object);
      const prop = expr.callee.property.name;
      let combinator = "Schema.decodeUnknownEffect";
      if (prop === "decodeJsonSync") combinator = "Schema.decodeUnknownSync";
      else if (prop === "encodeJson") combinator = "Schema.encodeEffect";
      else if (prop === "encodeJsonSync") combinator = "Schema.encodeSync";

      const codec = `${combinator}(Schema.fromJsonString(${schema}))`;
      if (expr.args.length >= 1) {
        const target = this.emitExpression(expr.args[0]);
        return `${codec}(${target})`;
      }
      return codec;
    }

    if (
      expr.callee.kind === "MemberExpression" &&
      (expr.callee.object.kind === "Identifier" ||
        expr.callee.object.kind === "UpperIdentifier") &&
      expr.callee.object.name === "Option" &&
      expr.callee.property.name === "fromNullishOrElse"
    ) {
      this.needsFromNullishOrElse = true;
      this.effectImports.add("Option");
      return `fromNullishOrElse(${expr.args.map((a) => this.emitExpression(a)).join(", ")})`;
    }

    if (
      expr.callee.kind === "MemberExpression" &&
      (expr.callee.object.kind === "Identifier" ||
        expr.callee.object.kind === "UpperIdentifier") &&
      expr.callee.object.name === "Option" &&
      expr.callee.property.name === "fromNullishOr"
    ) {
      this.needsFromNullishOr = true;
      this.effectImports.add("Option");
      return `fromNullishOr(${expr.args.map((a) => this.emitExpression(a)).join(", ")})`;
    }

    if (
      expr.callee.kind === "Identifier" &&
      expr.callee.name === "fromNullishOr" &&
      !this.isUserBinding("fromNullishOr")
    ) {
      this.needsFromNullishOr = true;
      this.effectImports.add("Option");
      return `fromNullishOr(${expr.args.map((a) => this.emitExpression(a)).join(", ")})`;
    }

    if (
      expr.callee.kind === "Identifier" &&
      expr.callee.name === "fromNullishOrElse" &&
      !this.isUserBinding("fromNullishOrElse")
    ) {
      this.needsFromNullishOrElse = true;
      this.effectImports.add("Option");
      return `fromNullishOrElse(${expr.args.map((a) => this.emitExpression(a)).join(", ")})`;
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
      (expr.callee.kind === "UpperIdentifier" ||
        expr.callee.kind === "Identifier") &&
      expr.callee.name === "URL" &&
      !this.emitCtx.inTryContext
    ) {
      throw new FunScriptError(
        `'URL(...)' is unsafe because URL constructors throw on malformed input. Guard it with 'js URL(...)', 'Result.try(() => URL(...))', or 'Option.try(() => URL(...))'.`,
        expr.callee.span,
      );
    }

    if (
      expr.callee.kind === "MemberExpression" &&
      (expr.callee.object.kind === "Identifier" ||
        expr.callee.object.kind === "UpperIdentifier") &&
      expr.callee.object.name === "Option" &&
      expr.callee.property.name === "try"
    ) {
      this.needsOptionTry = true;
      this.effectImports.add("Option");
      const emittedArgs = expr.args.map((a) => this.emitTryArgument(a));
      return `optionTry(${emittedArgs.join(", ")})`;
    }

    if (
      expr.callee.kind === "MemberExpression" &&
      (expr.callee.object.kind === "Identifier" ||
        expr.callee.object.kind === "UpperIdentifier") &&
      expr.callee.object.name === "Result" &&
      expr.callee.property.name === "try"
    ) {
      this.effectImports.add("Result");
      const emittedArgs = expr.args.map((a) => this.emitTryArgument(a));
      return `Result.try(${emittedArgs.join(", ")})`;
    }

    if (expr.callee.kind === "MemberExpression") {
      const prop = expr.callee.property.name;
      const root = getRootCalleeName(expr.callee.object);
      const objName =
        expr.callee.object.kind === "Identifier" ||
        expr.callee.object.kind === "UpperIdentifier"
          ? expr.callee.object.name
          : null;

      if (
        (objName === "Number" || objName === "globalThis") &&
        (prop === "parseInt" || prop === "parseFloat")
      ) {
        throw new FunScriptError(
          `'${objName}.${prop}()' is banned by the Effect style guide because it produces NaN on invalid input. Use 'Number.parse(s)' instead for total parsing returning Option<number>.`,
          expr.callee.property.span,
        );
      }

      if (
        (objName === "JSON" || objName === "globalThis") &&
        prop === "parse" &&
        !this.emitCtx.inTryContext
      ) {
        throw new FunScriptError(
          `'JSON.parse()' is unsafe because it throws on malformed input. Guard it with 'js JSON.parse(...)', 'Result.try(() => JSON.parse(...))', or use 'Schema.decodeUnknown'.`,
          expr.callee.property.span,
        );
      }

      if (
        (objName === "Math" || objName === "globalThis") &&
        prop === "random"
      ) {
        throw new FunScriptError(
          `'Math.random()' is banned by the Effect style guide because it is unmanaged and non-deterministic. Use 'Random.next' or 'Random.nextIntBetween' instead.`,
          expr.callee.property.span,
        );
      }

      if (
        (expr.callee.object.kind === "Identifier" ||
          expr.callee.object.kind === "UpperIdentifier") &&
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

      if (
        !isAllowed &&
        !this.activeDraftParams.has(root ?? "") &&
        BANNED_INSTANCE_METHODS.has(prop)
      ) {
        const info = BANNED_INSTANCE_METHODS.get(prop)!;
        if (
          this.isTargetNativeCategory(expr.callee.object, info.category, prop)
        ) {
          if (["push", "pop", "shift", "unshift", "splice"].includes(prop)) {
            throw new FunScriptError(
              `In-place mutation '.${prop}()' is quarantined in FunScript. Use '${info.replacement}(...)' or pipeline '${info.pipeline}' instead, or isolate mutable edits inside 'mut (draft) => { ... }'.`,
              expr.callee.property.span,
            );
          } else {
            throw new FunScriptError(
              `Native ${info.category} method '.${prop}()' is banned by the Effect style guide. Use '${info.replacement}(...)' or pipeline '${info.pipeline}' instead.`,
              expr.callee.property.span,
            );
          }
        }
      }

      if (
        (expr.callee.object.kind === "Identifier" ||
          expr.callee.object.kind === "UpperIdentifier") &&
        EFFECT_BUILTIN_MODULES.has(expr.callee.object.name)
      ) {
        this.effectImports.add(expr.callee.object.name);
      }
    }

    if (
      (expr.callee.kind === "UpperIdentifier" ||
        expr.callee.kind === "Identifier") &&
      AUTO_NEW_CONSTRUCTORS.has(expr.callee.name) &&
      !this.bindings.has(expr.callee.name) &&
      !this.declaredTypeNames.has(expr.callee.name)
    ) {
      if (
        (expr.callee.name === "Map" || expr.callee.name === "WeakMap") &&
        expr.args.length === 1
      ) {
        return `new ${expr.callee.name}(${this.emitExpression(expr.args[0])} as any)`;
      }
      return `new ${expr.callee.name}(${expr.args.map((a) => this.emitExpression(a)).join(", ")})`;
    }

    if (
      expr.callee.kind === "MemberExpression" &&
      AUTO_NEW_CONSTRUCTORS.has(expr.callee.property.name) &&
      expr.callee.object.kind === "Identifier" &&
      (expr.callee.object.name === "globalThis" ||
        expr.callee.object.name === "window")
    ) {
      return `new ${this.emitExpression(expr.callee)}(${expr.args.map((a) => this.emitExpression(a)).join(", ")})`;
    }

    if (
      (expr.callee.kind === "UpperIdentifier" ||
        expr.callee.kind === "Identifier") &&
      expr.callee.name === "Brand"
    ) {
      this.effectImports.add("Schema");
      return `Schema.brand(${expr.args.map((a) => this.emitExpression(a)).join(", ")})`;
    }

    const isPipelineStageCall = this.emitCtx.inPipelineStage;
    return this.withEmitContext({ inPipelineStage: false }, () => {
      if (
        this.options.markPipelineSources &&
        !isPipelineStageCall &&
        expr.callee.kind === "Identifier" &&
        expr.args.length >= 1
      ) {
        const fnName = expr.callee.name;
        if (
          fnName in COMPARISON_METHOD_MAP ||
          (!this.bindings.has(fnName) && !this.userEffectBindings.has(fnName))
        ) {
          const firstArg = this.emitExpression(expr.args[0]);
          const restArgs = expr.args
            .slice(1)
            .map((a) => this.emitExpression(a));
          const markedFirstArg = `__funscriptDirectCall(${expr.span.start.offset}, ${firstArg})`;
          return `${fnName}(${[markedFirstArg, ...restArgs].join(", ")})`;
        }
      }

      if (this.options.directCallResolutions?.has(expr.span.start.offset)) {
        const res = this.options.directCallResolutions.get(
          expr.span.start.offset,
        )!;
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

      return `${this.emitExpression(expr.callee)}(${expr.args
        .map((a) => {
          const emitted = this.emitExpression(a);
          if (this.options.forwardNullArguments?.has(a.span.start.offset)) {
            this.effectImports.add("Option");
            return `Option.getOrNull(${emitted})`;
          }
          if (this.options.forwardOptionalArguments?.has(a.span.start.offset)) {
            this.effectImports.add("Option");
            return `Option.getOrUndefined(${emitted})`;
          }
          return this.options.markCallArguments
            ? `__funscriptCallArgument(${a.span.start.offset}, ${emitted})`
            : emitted;
        })
        .join(", ")})`;
    });
  }

  private emitPipelineExpression(expr: PipelineExpression): string {
    this.effectImports.add("pipe");

    const resolver = new PipelineResolver({
      bindings: this.bindings,
      pipelineCompanions: this.options.pipelineCompanions,
      allowAmbiguousPipeline: this.options.allowAmbiguousPipeline,
      isUserBinding: (name) => this.isUserBinding(name),
      effectImports: this.effectImports,
      esToolkitImports: this.esToolkitImports,
      requireDecodeUnknown: () => {
        this.needsDecodeUnknown = true;
      },
    });

    // Flatten left-nested pipelines: a |> b |> c
    const stages: Expression[] = [];
    let curr: Expression = expr;
    let deferredSource = false;

    while (curr.kind === "PipelineExpression") {
      stages.unshift(curr.right);
      if (curr.deferred) {
        deferredSource = true;
        curr = curr.left;
        break;
      }
      curr = curr.left;
    }
    stages.unshift(curr);

    let preferredCompanion = resolver.inferPipelineCompanion(stages[0]);
    const emittedStages = stages.map((s, idx) => {
      if (idx === 0) {
        return this.withEmitContext({ inPipelineStage: false }, () => {
          const value = this.emitExpression(s);
          const emitted = deferredSource ? `() => (${value})` : value;
          return this.options.markPipelineSources
            ? `__funscriptPipelineSource(${s.span.start.offset}, ${emitted})`
            : emitted;
        });
      }
      return this.withEmitContext({ inPipelineStage: true }, () => {
        if (
          idx === 1 &&
          deferredSource &&
          s.kind === "Identifier" &&
          [
            "sync",
            "suspend",
            "promise",
            "try",
            "tryPromise",
            "failSync",
          ].includes(s.name) &&
          !this.isUserBinding(s.name)
        ) {
          this.effectImports.add("Effect");
          return s.name === "try" || s.name === "tryPromise"
            ? `(__thunk) => Effect.${s.name}(__thunk)`
            : `Effect.${s.name}`;
        }
        if (
          idx === 1 &&
          deferredSource &&
          s.kind === "MemberExpression" &&
          s.object.kind === "UpperIdentifier" &&
          s.object.name === "Effect" &&
          (s.property.name === "try" || s.property.name === "tryPromise")
        ) {
          this.effectImports.add("Effect");
          return `(__thunk) => Effect.${s.property.name}(__thunk)`;
        }
        if (s.kind === "MatchExpression" && s.isCatch) {
          return this.emitMatchExpression(s);
        }
        if (s.kind === "MutBlockExpression") {
          this.needsMutative = true;
          return `(__mutInput) => create(__mutInput, ${this.emitMutativeRecipe(s)})`;
        }

        if (!this.isUserBinding("fromNullishOr")) {
          if (s.kind === "Identifier" && s.name === "fromNullishOr") {
            this.needsFromNullishOr = true;
            this.effectImports.add("Option");
            return `fromNullishOr`;
          }
        }

        if (!this.isUserBinding("fromNullishOrElse")) {
          if (
            s.kind === "CallExpression" &&
            s.callee.kind === "Identifier" &&
            s.callee.name === "fromNullishOrElse"
          ) {
            this.needsFromNullishOrElse = true;
            this.effectImports.add("Option");
            return `fromNullishOrElse(${s.args.map((a) => this.emitExpression(a)).join(", ")})`;
          }
        }

        if (!this.isUserBinding("dbg")) {
          if (s.kind === "Identifier" && s.name === "dbg") {
            return `((__v) => { console.log(__v); return __v; })`;
          }
          if (
            s.kind === "CallExpression" &&
            s.callee.kind === "Identifier" &&
            s.callee.name === "dbg"
          ) {
            const labelArg =
              s.args.length > 0 ? this.emitExpression(s.args[0]) : undefined;
            const logCall = labelArg
              ? `console.log(${labelArg}, __v)`
              : `console.log(__v)`;
            return `((__v) => { ${logCall}; return __v; })`;
          }
        }

        // Check if stage was resolved by type-directed resolution
        if (this.options.stageResolutions?.has(s.span.start.offset)) {
          const res = this.options.stageResolutions.get(s.span.start.offset)!;
          if (isEffectModule(res.module)) {
            this.effectImports.add(res.module);
          }
          if (
            res.module === "Effect" &&
            (res.method === "retry" ||
              (s.kind === "CallExpression" &&
                (s.callee as Identifier).name === "retry"))
          ) {
            const resolved = resolver.resolvePipelineStage(s, "Effect");
            return this.emitExpression(resolved);
          }
          if (s.kind === "Identifier" || s.kind === "UpperIdentifier") {
            return `${res.module}.${res.method ?? s.name}`;
          }
          if (s.kind === "CallExpression") {
            const callee = s.callee as Identifier | UpperIdentifier;
            if (
              res.module === "Schema" &&
              (res.method === "decode" ||
                (!res.method && callee.name === "decode"))
            ) {
              this.needsDecodeUnknown = true;
            }
            const method =
              res.module === "Schema" &&
              (res.method === "decode" ||
                (!res.method && callee.name === "decode"))
                ? "decodeUnknown"
                : (res.method ?? callee.name);
            const calleeName = `${res.module}.${method}`;
            if (resolver.hasPlaceholder(s)) {
              const placeholderParam = this.emitCtx.currentPlaceholderParam
                ? `__p${++this.placeholderCounter}`
                : "__p";
              return this.withEmitContext(
                { currentPlaceholderParam: placeholderParam },
                () => {
                  const args = s.args
                    .map((a) => this.emitExpression(a))
                    .join(", ");
                  return `(${placeholderParam}) => ${calleeName}(${args})`;
                },
              );
            }
            const args = s.args.map((a) => this.emitExpression(a)).join(", ");
            return `${calleeName}(${args})`;
          }
        }

        // Auto-namespace resolution for pipeline stage callee
        resolver.assertPipelineStageIsNotAmbiguous(s, preferredCompanion);
        const resolvedStage = resolver.resolvePipelineStage(
          s,
          preferredCompanion,
        );

        // `js`, `runPromise`, and `runSync` run an Effect and leave the Effect pipeline domain.
        const isEffectRunner =
          (s.kind === "Identifier" &&
            (s.name === "js" ||
              s.name === "runPromise" ||
              s.name === "runSync")) ||
          (s.kind === "CallExpression" &&
            s.callee.kind === "Identifier" &&
            (s.callee.name === "runPromise" || s.callee.name === "runSync") &&
            s.args.length === 0);
        if (isEffectRunner) preferredCompanion = undefined;

        // Check if stage has placeholder '_'
        if (resolver.hasPlaceholder(resolvedStage)) {
          const placeholderParam = this.emitCtx.currentPlaceholderParam
            ? `__p${++this.placeholderCounter}`
            : "__p";
          return this.withEmitContext(
            { currentPlaceholderParam: placeholderParam },
            () => {
              const body = this.emitExpression(resolvedStage);
              const formattedBody =
                resolvedStage.kind === "RecordExpression" ? `(${body})` : body;
              return `(${placeholderParam}) => ${formattedBody}`;
            },
          );
        }

        if (idx === 1 && s.kind === "MatchExpression" && !s.isCatch) {
          return this.emitMatchExpression(
            s,
            this.getTypeNodeForExpression(stages[0]),
          );
        }

        return this.emitExpression(resolvedStage);
      });
    });

    const checkedStages = this.options.markPipelineSources
      ? emittedStages.map((stage, index) =>
          index === 0
            ? stage
            : `(__funscriptPipelineValue) => (${stage})(__funscriptPipelineStageInput(${stages[index].span.start.offset}, __funscriptPipelineValue))`,
        )
      : emittedStages;
    return `pipe(\n  ${checkedStages.join(",\n  ")}\n)`;
  }

  public isUserBinding(name: string): boolean {
    return (
      this.bindings.has(name) ||
      this.userImportBindings.has(name) ||
      this.userEffectBindings.has(name) ||
      this.userEsToolkitBindings.has(name) ||
      this.declaredTypeNames.has(name) ||
      this.parameterScopes.some((scope) => scope.has(name))
    );
  }

  private emitBinaryExpression(expr: BinaryExpression): string {
    const emitOperand = (operand: Expression) => {
      const emitted = this.emitExpression(operand);
      return operand.kind === "FunctionExpression" ? `(${emitted})` : emitted;
    };
    const left = emitOperand(expr.left);
    const right = emitOperand(expr.right);
    const markBoolean = (operand: Expression, emitted: string) =>
      this.options.markBooleanOperands
        ? `__funscriptBooleanOperand(${operand.span.start.offset}, ${JSON.stringify(expr.operator)}, ${emitted})`
        : emitted;
    switch (expr.operator) {
      case "and":
        return `(${markBoolean(expr.left, left)} && ${markBoolean(expr.right, right)})`;
      case "or":
        return `(${markBoolean(expr.left, left)} || ${markBoolean(expr.right, right)})`;
      case "@=":
        if (this.isPrimitive(expr.left) || this.isPrimitive(expr.right)) {
          throw new Error(
            `Reference identity operator '@=' cannot be used with primitive values; use '#=' or '#!' for value equality`,
          );
        }
        this.needsReferenceEquality = true;
        return `referenceEquals(${left}, ${right})`;
      case "@!":
        if (this.isPrimitive(expr.left) || this.isPrimitive(expr.right)) {
          throw new Error(
            `Reference identity operator '@!' cannot be used with primitive values; use '#=' or '#!' for value equality`,
          );
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

  private emitInTryContext(arg: Expression): string {
    if (arg.kind === "FunctionExpression") {
      return this.withEmitContext({ pendingTryThunk: true }, () =>
        this.emitExpression(arg),
      );
    }
    return this.withEmitContext({ inTryContext: true }, () =>
      this.emitExpression(arg),
    );
  }

  private emitTryArgument(arg: Expression): string {
    if (arg.kind === "RecordExpression") {
      return this.withEmitContext({ pendingTryRecord: true }, () =>
        this.emitExpression(arg),
      );
    }
    return this.emitInTryContext(arg);
  }

  private emitRecordExpression(expr: RecordExpression): string {
    const isTryRecord = this.emitCtx.pendingTryRecord;
    return this.withEmitContext({ pendingTryRecord: false }, () => {
      const hasDotPaths = expr.entries.some((e) => e.kind === "DotPathEntry");
      if (hasDotPaths) {
        // Lower to Mutative create
        this.needsMutative = true;
        const baseSpread = expr.entries.find((e) => e.kind === "SpreadEntry");
        const base =
          baseSpread && "argument" in baseSpread
            ? this.emitExpression(baseSpread.argument)
            : "{}";
        const mutations = expr.entries
          .filter((e) => e.kind !== "SpreadEntry")
          .map((e) => {
            if (e.kind === "DotPathEntry") {
              return `  draft.${e.path.map((p) => p.name).join(".")} = ${this.emitExpression(e.value)};`;
            }
            if (e.kind === "FieldEntry") {
              const keyAccess = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(e.key.name)
                ? `.${e.key.name}`
                : `[${JSON.stringify(e.key.name)}]`;
              return `  draft${keyAccess} = ${this.emitExpression(e.value)};`;
            }
            return `  draft.${e.key.name} = ${e.key.name};`;
          })
          .join("\n");
        return `create(${base}, (draft) => {\n${mutations}\n})`;
      }

      const DISCRIMINANT_RECORD_KEYS = new Set([
        "_tag",
        "type",
        "kind",
        "status",
        "code",
        "tag",
        "ok",
        "state",
      ]);
      const entries = expr.entries
        .map((e) => {
          if (e.kind === "SpreadEntry")
            return `...${this.emitExpression(e.argument)}`;
          if (e.kind === "FieldEntry" || e.kind === "ShorthandEntry") {
            const keyName = e.key.name;
            const valueExpr = e.kind === "FieldEntry" ? e.value : e.key;
            let val: string;
            if (isTryRecord && keyName === "try") {
              val = this.emitInTryContext(valueExpr);
            } else {
              val = this.emitExpression(valueExpr);
            }
            if (
              this.options.forwardNullProperties?.has(
                valueExpr.span.start.offset,
              )
            ) {
              this.effectImports.add("Option");
              return `[${JSON.stringify(keyName)}]: Option.getOrNull(${val})`;
            }
            if (
              this.options.forwardOptionalProperties?.has(
                valueExpr.span.start.offset,
              )
            ) {
              this.effectImports.add("Option");
              return `...((__value: import("effect").Option.Option<any>) => Option.isSome(__value) ? { [${JSON.stringify(keyName)}]: __value.value } : {})(${val})`;
            }
            if (this.options.markCallArguments)
              val = `__funscriptCallArgument(${valueExpr.span.start.offset}, ${val})`;
            if (valueExpr.kind === "BooleanLiteral") {
              val = `${val} as const`;
            } else if (
              (valueExpr.kind === "StringLiteral" ||
                valueExpr.kind === "NumberLiteral") &&
              DISCRIMINANT_RECORD_KEYS.has(keyName)
            ) {
              val = `${val} as const`;
            }
            if (
              e.kind === "ShorthandEntry" &&
              !this.options.markCallArguments
            ) {
              return keyName;
            }
            return `${emitPropertyKey(keyName)}: ${val}`;
          }
          return "";
        })
        .join(", ");
      return `{ ${entries} }`;
    });
  }

  private emitFunctionExpression(expr: FunctionExpression): string {
    const isTryThunk = this.emitCtx.pendingTryThunk;
    const prevPrimitiveIdentifiers = new Set(this.primitiveIdentifiers);
    try {
      return this.withEmitContext(
        {
          pendingTryThunk: false,
          inTryContext: isTryThunk,
          inPipelineStage: false,
          currentPlaceholderParam: null,
        },
        () => {
          for (const p of expr.params) {
            const isPrim = this.isPrimitiveType(p.typeAnnotation);
            for (const n of this.collectBindingNames(p.name)) {
              if (isPrim) {
                this.primitiveIdentifiers.add(n);
              } else {
                this.primitiveIdentifiers.delete(n);
              }
            }
          }
          const params = expr.params
            .map((p, index) => {
              const rest = p.isRest ? "..." : "";
              let name = this.emitBindingTarget(p.name);
              if (p.name.kind === "RecordPattern") {
                let recType: TypeNode | undefined = p.typeAnnotation;
                if (recType?.kind === "TypeReferenceNode") {
                  recType = this.getRecordTypeNode(recType.name.name);
                }
                const recFields =
                  recType?.kind === "RecordTypeNode"
                    ? extractRecordFields(recType, (name) =>
                        this.getRecordTypeNode(name),
                      )
                    : undefined;
                if (patternHasOptionalField(p.name, recFields)) {
                  name = `$funscriptParam${index}`;
                }
              }
              let typeAnn = "";
              if (p.typeAnnotation) {
                const base = this.emitTypeNode(p.typeAnnotation);
                typeAnn = `: ${base}`;
              }
              const defaultValue = p.defaultValue
                ? ` = ${this.emitExpression(p.defaultValue)}`
                : "";
              return `${rest}${name}${typeAnn}${defaultValue}`;
            })
            .join(", ");
          const typeParams = this.emitTypeParameters(expr.typeParams, true);
          const retType = expr.returnType
            ? `: ${this.emitTypeNode(expr.returnType)}`
            : "";

          const records = new Map<
            string,
            Map<string, RecordFieldInfo> | undefined
          >();
          const recordDefaults: string[] = [];
          expr.params.forEach((param, paramIndex) => {
            if (param.name.kind === "RecordPattern") {
              let recType: TypeNode | undefined = param.typeAnnotation;
              if (recType?.kind === "TypeReferenceNode") {
                recType = this.getRecordTypeNode(recType.name.name);
              }
              const recFields =
                recType?.kind === "RecordTypeNode"
                  ? extractRecordFields(recType, (name) =>
                      this.getRecordTypeNode(name),
                    )
                  : undefined;
              if (patternHasOptionalField(param.name, recFields)) {
                recordDefaults.push(
                  ...emitUnpackedRecordPattern({
                    pat: param.name,
                    basePath: `$funscriptParam${paramIndex}`,
                    fieldsMap: recFields,
                    emitBindingTarget: (target) =>
                      this.emitBindingTarget(target),
                    addEffectImport: (name) => this.effectImports.add(name),
                    indent: "  ",
                    onRecordBinding: (varName, fields) => {
                      records.set(varName, fields);
                    },
                  }),
                );
              }
              return;
            }
            if (param.name.kind !== "Identifier") return;
            const paramName = param.name.name;
            const declared = param.typeAnnotation;
            if (this.isHtmlPropsType(declared)) {
              records.set(paramName, undefined);
              return;
            }
            const recordType =
              declared?.kind === "TypeReferenceNode"
                ? this.getRecordTypeNode(declared.name.name)
                : declared;
            if (recordType?.kind !== "RecordTypeNode") {
              records.set(paramName, undefined);
              return;
            }
            const fields = recordType.fields;
            const nestedFields = (
              type: TypeNode,
            ): Map<string, RecordFieldInfo> | undefined => {
              if (type.kind !== "RecordTypeNode") {
                return undefined;
              }
              const result = new Map<string, RecordFieldInfo>();
              for (const field of type.fields) {
                const children = nestedFields(field.typeAnnotation);
                result.set(field.name.name, {
                  optional: Boolean(field.optional),
                  fields: children,
                });
              }
              return [...result.values()].some(
                (field) => field.optional || field.fields,
              )
                ? result
                : undefined;
            };
            if (
              !fields.some(
                (field) =>
                  field.optional ||
                  field.defaultValue ||
                  nestedFields(field.typeAnnotation),
              )
            ) {
              records.set(paramName, undefined);
              return;
            }
            const mapped = new Map<string, RecordFieldInfo>();
            fields.forEach((field, fieldIndex) => {
              const binding = field.defaultValue
                ? `$funscriptField${paramIndex}_${fieldIndex}`
                : undefined;
              if (field.defaultValue) {
                const currentParamNames = new Set(
                  this.collectBindingNames(expr.params[paramIndex].name),
                );
                const subsequentParamNames = new Set(
                  expr.params
                    .slice(paramIndex + 1)
                    .flatMap((p) => this.collectBindingNames(p.name)),
                );
                this.validateRecordDefault(
                  field.defaultValue,
                  currentParamNames,
                  subsequentParamNames,
                );
                const raw = `$funscriptFieldRaw${paramIndex}_${fieldIndex}`;
                recordDefaults.push(
                  `  const ${raw} = ${paramName}.${field.name.name};`,
                );
                recordDefaults.push(
                  `  const ${binding} = ${raw} === undefined ? ${this.emitExpression(field.defaultValue)} : ${raw};`,
                );
              }
              const children = nestedFields(field.typeAnnotation);
              mapped.set(field.name.name, {
                optional: Boolean(field.optional),
                defaultBinding: binding,
                fields: children,
              });
            });
            records.set(paramName, mapped);
          });
          if (expr.body.kind === "BlockStatement") {
            for (const stmt of expr.body.statements) {
              if (
                stmt.kind !== "BindingDeclaration" ||
                stmt.isMut ||
                stmt.isJs ||
                !("name" in stmt.id) ||
                records.has(stmt.id.name)
              )
                continue;
              if (stmt.init.kind === "Identifier") {
                const fields = records.get(stmt.init.name);
                if (
                  !fields ||
                  [...fields.values()].some((field) => field.defaultBinding)
                )
                  continue;
                records.set(stmt.id.name, fields);
              } else if (stmt.init.kind === "RecordExpression") {
                const fields = new Map<string, RecordFieldInfo>();
                let hasTracked = false;
                for (const prop of stmt.init.entries) {
                  if (prop.kind === "SpreadEntry") {
                    if (prop.argument.kind === "Identifier") {
                      const spreadFields = records.get(prop.argument.name);
                      if (spreadFields) {
                        for (const [key, info] of spreadFields) {
                          if (info.optional) hasTracked = true;
                          fields.set(key, {
                            optional: info.optional,
                            defaultBinding: undefined,
                            fields: info.fields,
                          });
                        }
                      }
                    }
                  } else if (
                    prop.kind === "FieldEntry" ||
                    prop.kind === "ShorthandEntry"
                  ) {
                    const keyName = prop.key.name;
                    if (keyName) {
                      fields.set(keyName, {
                        optional: false,
                        defaultBinding: undefined,
                        fields: undefined,
                      });
                    }
                  }
                }
                if (hasTracked) {
                  records.set(stmt.id.name, fields);
                }
              }
            }
          }
          const paramScopeEntries: [string, boolean][] = [];
          const varTypeEntries: [string, TypeNode | undefined][] = [];
          for (const p of expr.params) {
            if (p.name.kind === "RecordPattern") {
              let recType: TypeNode | undefined = p.typeAnnotation;
              if (recType?.kind === "TypeReferenceNode") {
                recType = this.getRecordTypeNode(recType.name.name);
              }
              const recFields =
                recType?.kind === "RecordTypeNode"
                  ? extractRecordFields(recType, (name) =>
                      this.getRecordTypeNode(name),
                    )
                  : undefined;
              if (patternHasOptionalField(p.name, recFields)) {
                const collectParamsFromPattern = (
                  pat: RecordPattern,
                  fieldsMap?: Map<string, RecordFieldInfo>,
                  typeNode?: TypeNode,
                  parentIsOpt = false,
                ) => {
                  for (const f of pat.fields) {
                    if (f.isRest) {
                      paramScopeEntries.push([f.key.name, parentIsOpt]);
                      varTypeEntries.push([f.key.name, undefined]);
                      continue;
                    }
                    const info = fieldsMap?.get(f.key.name);
                    const isOpt = parentIsOpt || info?.optional === true;
                    const matchingFieldType =
                      typeNode?.kind === "RecordTypeNode"
                        ? typeNode.fields.find(
                            (tf) => tf.name.name === f.key.name,
                          )?.typeAnnotation
                        : undefined;
                    if (f.pattern?.kind === "RecordPattern") {
                      let subType: TypeNode | undefined = matchingFieldType;
                      if (subType?.kind === "TypeReferenceNode") {
                        subType = this.getRecordTypeNode(subType.name.name);
                      }
                      collectParamsFromPattern(
                        f.pattern,
                        info?.fields,
                        subType,
                        isOpt,
                      );
                    } else if (f.pattern?.kind === "ArrayPattern") {
                      const elemType =
                        matchingFieldType?.kind === "ArrayTypeNode"
                          ? matchingFieldType.elementType
                          : undefined;
                      for (const el of f.pattern.elements) {
                        for (const n of this.collectBindingNames(el)) {
                          paramScopeEntries.push([n, isOpt]);
                          varTypeEntries.push([n, elemType]);
                        }
                      }
                    } else {
                      const varName =
                        f.pattern?.kind === "VariablePattern"
                          ? f.pattern.name.name
                          : f.key.name;
                      paramScopeEntries.push([varName, isOpt]);
                      varTypeEntries.push([varName, matchingFieldType]);
                    }
                  }
                };
                collectParamsFromPattern(p.name, recFields, recType);
                continue;
              }
            }
            for (const n of this.collectBindingNames(p.name)) {
              paramScopeEntries.push([n, false]);
              varTypeEntries.push([n, p.typeAnnotation]);
            }
          }
          this.parameterScopes.push(new Map(paramScopeEntries));
          this.variableTypeScopes.push(new Map(varTypeEntries));
          this.recordScopes.push(records);
          try {
            if (expr.body.kind === "BlockStatement" || recordDefaults.length) {
              const body = this.emitFunctionBody(expr.body);
              return `${typeParams}(${params})${retType} => {\n${[...recordDefaults, body].filter(Boolean).join("\n")}\n}`;
            }
            return `${typeParams}(${params})${retType} => ${this.emitArrowExpression(expr.body)}`;
          } finally {
            this.recordScopes.pop();
            this.parameterScopes.pop();
            this.variableTypeScopes.pop();
          }
        },
      );
    } finally {
      this.primitiveIdentifiers = prevPrimitiveIdentifiers;
    }
  }

  public emitFunctionBody(body: FunctionBody): string {
    if (body.kind === "BlockStatement") {
      const stmts = body.statements
        .map((s) => "  " + this.emitStatement(s))
        .join("\n");
      const isUnit =
        body.finalExpression &&
        (body.finalExpression.kind === "Identifier" ||
          body.finalExpression.kind === "UpperIdentifier") &&
        body.finalExpression.name === "Void";
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
    const isUnit =
      (body.kind === "Identifier" || body.kind === "UpperIdentifier") &&
      body.name === "Void";
    if (isUnit) return "  return;";
    return `  return ${this.emitExpression(body)};`;
  }

  public emitArrowExpression(expr: Expression): string {
    return emitArrowExpression(this, expr);
  }

  public emitIndexTarget(expr: IndexExpression): string {
    return emitIndexTarget(this, expr);
  }

  public emitStatement(stmt: Statement): string {
    return emitStatement(this, stmt);
  }

  public emitWhenStatement(stmt: WhenStatement, insideEffect = false): string {
    return emitWhenStatement(this, stmt, insideEffect);
  }

  private emitMatchExpression(
    expr: MatchExpression,
    pipelineScrutineeType?: TypeNode,
  ): string {
    return new MatchEmitter({
      emitExpression: (expression) => this.emitExpression(expression),
      emitFunctionBody: (body) => this.emitFunctionBody(body),
      emitArrowExpression: (expression) => this.emitArrowExpression(expression),
      emitBindingTarget: (target) => this.emitBindingTarget(target),
      emitStringLiteral: (literal) => this.emitStringLiteral(literal),
      recordField: (expression) => this.recordField(expression),
      recordFields: (name) => this.recordFields(name),
      getRecordTypeNode: (name) => this.getRecordTypeNode(name),
      getVariantFields: (name) => this.variantFields.get(name),
      isTaggedUnionVariant: (type, variant) =>
        this.taggedUnionVariants.get(type)?.has(variant) ?? false,
      recordContracts: this.recordContracts,
      isOptionalParameter: (name) => this.isOptionalParameter(name),
      isOptionalValue: (expression) => this.isOptionalValue(expression),
      addEffectImport: (name) => this.addEffectImport(name),
      getTypeNodeForExpression: (expression) =>
        this.getTypeNodeForExpression(expression),
      requireTsPattern: () => {
        this.needsTsPattern = true;
      },
      enterOptionalPayload: (name, fields, _arm, payloadType) => {
        this.recordScopes.push(new Map([[name, fields]]));
        this.parameterScopes.push(new Map([[name, false]]));
        this.variableTypeScopes.push(new Map([[name, payloadType]]));
      },
      leaveOptionalPayload: () => {
        this.variableTypeScopes.pop();
        this.parameterScopes.pop();
        this.recordScopes.pop();
      },
      enterOptionalRecordPattern: (pattern, fields, _arm, payloadType) => {
        const recordScope = new Map<string, Map<string, RecordFieldInfo>>();
        const paramScope = new Map<string, boolean>();
        const varTypeScope = new Map<string, TypeNode | undefined>();

        let typeFields: RecordTypeField[] | undefined;
        if (payloadType?.kind === "RecordTypeNode") {
          typeFields = payloadType.fields;
        } else if (payloadType?.kind === "TypeReferenceNode") {
          const contract =
            this.getRecordTypeNode(payloadType.name.name) ??
            this.recordContracts.get(payloadType.name.name);
          if (contract?.kind === "RecordTypeNode") {
            typeFields = contract.fields;
          }
        }

        const registerRecordPatternFields = (
          pat: RecordPattern,
          fieldsMap?: Map<string, RecordFieldInfo>,
          recordTypeFields?: RecordTypeField[],
        ) => {
          for (const f of pat.fields) {
            if (f.isRest) {
              paramScope.set(f.key.name, false);
              continue;
            }
            if (f.pattern?.kind === "WildcardPattern") continue;
            const info = fieldsMap?.get(f.key.name);
            const isOpt = info?.optional === true;
            const fieldTypeNode = recordTypeFields?.find(
              (tf) => tf.name.name === f.key.name,
            )?.typeAnnotation;

            if (f.pattern?.kind === "RecordPattern") {
              let subTypeFields: RecordTypeField[] | undefined;
              if (fieldTypeNode?.kind === "RecordTypeNode") {
                subTypeFields = fieldTypeNode.fields;
              } else if (fieldTypeNode?.kind === "TypeReferenceNode") {
                const contract =
                  this.getRecordTypeNode(fieldTypeNode.name.name) ??
                  this.recordContracts.get(fieldTypeNode.name.name);
                if (contract?.kind === "RecordTypeNode") {
                  subTypeFields = contract.fields;
                }
              }
              registerRecordPatternFields(
                f.pattern,
                info?.fields,
                subTypeFields,
              );
            } else {
              const varName =
                f.pattern?.kind === "VariablePattern"
                  ? f.pattern.name.name
                  : f.key.name;
              paramScope.set(varName, isOpt);
              if (info?.fields) {
                recordScope.set(varName, info.fields);
              }
              if (fieldTypeNode) {
                if (isOpt) {
                  varTypeScope.set(varName, {
                    kind: "TypeReferenceNode",
                    name: { kind: "Identifier", name: "Option", span: f.span },
                    typeArgs: [fieldTypeNode],
                    span: f.span,
                  });
                } else {
                  varTypeScope.set(varName, fieldTypeNode);
                }
              }
            }
          }
        };

        registerRecordPatternFields(pattern, fields, typeFields);

        this.recordScopes.push(recordScope);
        this.parameterScopes.push(paramScope);
        this.variableTypeScopes.push(varTypeScope);
      },
      leaveOptionalRecordPattern: () => {
        this.variableTypeScopes.pop();
        this.parameterScopes.pop();
        this.recordScopes.pop();
      },
    }).emitMatchExpression(expr, pipelineScrutineeType);
  }

  public emitEffectBlockExpression(expr: EffectBlockExpression): string {
    return emitEffectBlockExpression(this, expr);
  }

  public emitParBlockExpression(expr: ParBlockExpression): string {
    return emitParBlockExpression(this, expr);
  }

  public emitEffectCall(effectExpr: Expression): string {
    return emitEffectCall(this, effectExpr);
  }

  // --- Types ---

  public emitTypeParameters(
    typeParams: TypeParameter[] | undefined,
    forArrowExpression = false,
  ): string {
    return emitTypeParameters(this, typeParams, forArrowExpression);
  }

  public emitTypeNode(node: TypeNode): string {
    return emitTypeNode(this, node);
  }

  // --- JSX ---

  public emitJsxElement(el: JSXElement): string {
    return emitJsxElement(this, el);
  }

  public emitJsxSelfClosingElement(el: JSXSelfClosingElement): string {
    return emitJsxSelfClosingElement(this, el);
  }

  public emitJsxTagName(name: JSXTagName): string {
    return emitJsxTagName(name);
  }

  public emitJsxAttribute(attr: JSXAttribute): string {
    return emitJsxAttribute(this, attr);
  }

  public emitJsxExpressionContainer(container: JSXExpressionContainer): string {
    return emitJsxExpressionContainer(this, container);
  }

  public emitJsxText(text: JSXText): string {
    return emitJsxText(text);
  }

  public emitJsxChild(child: JSXChild): string {
    return emitJsxChild(this, child);
  }
}
