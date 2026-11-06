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
  OrPattern,
  EffectBlockExpression,
  EffectStatement,
  EffectBindStatement,
  EffectDiscardStatement,
  TypeNode,
  TypeReferenceNode,
  FunctionTypeNode,
  EffectTypeNode,
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

export interface EmitterOptions {
  /** TypeScript-directed companion facts keyed by the pipeline source offset. */
  pipelineCompanions?: ReadonlyMap<number, PipelineCompanionModule>;
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
}

const ARRAY_COMPANION_METHODS = new Set(PIPELINE_COMPANION_CATALOG.Array);
const EFFECT_COMPANION_METHODS = new Set(PIPELINE_COMPANION_CATALOG.Effect);
const OPTION_COMPANION_METHODS = new Set(PIPELINE_COMPANION_CATALOG.Option);
const RESULT_COMPANION_METHODS = new Set(PIPELINE_COMPANION_CATALOG.Result);
const CHUNK_COMPANION_METHODS = new Set(PIPELINE_COMPANION_CATALOG.Chunk);

type CompanionModule = PipelineCompanionModule | "Number" | "String" | "Duration" | "Struct";

const NUMBER_COMPANION_METHODS = new Set([
  "isGreaterThan",
  "isGreaterThanOrEqualTo",
  "isLessThan",
  "isLessThanOrEqualTo",
  "between",
  "clamp",
  "increment",
  "decrement",
]);

const EFFECT_V4_MEMBER_RENAMES: Readonly<Record<string, string>> = {
  ...EFFECT_PIPELINE_COMPATIBILITY_ALIASES,
  fork: "forkChild",
};

const STRING_COMPANION_METHODS = new Set(["trim", "trimStart", "trimEnd", "split", "lines", "toUpperCase", "toLowerCase"]);
const RECORD_COMPANION_METHODS = new Set(["omit", "pick"]);
const DURATION_COMPANION_METHODS = new Set(["seconds", "millis", "minutes", "hours", "days"]);

class PipelineResolutionError extends Error {
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
  Unknown: "unknown",
  Never: "never",
};

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
  "Math",
  "String",
  "Number",
  "Record",
  "Duration",
  "Struct",
]);

type RecordFieldInfo = { optional: boolean; defaultBinding?: string; fields?: Map<string, RecordFieldInfo> };

export class Emitter {
  private effectImports = new Set<string>();
  private parameterScopes: Array<Map<string, boolean>> = [];
  private recordScopes: Array<Map<string, Map<string, RecordFieldInfo> | undefined>> = [];
  private userEffectBindings = new Set<string>();
  private effectModuleBindings = new Set<string>();
  private needsTsPattern = false;
  private needsMutative = false;
  private needsReferenceEquality = false;
  private needsJsInterop = false;
  private needsDecodeUnknown = false;
  private primitiveIdentifiers = new Set<string>();
  private currentPlaceholderParam: string | null = null;
  private bindings = new Map<string, BindingDeclaration>();

  private declaredTypeNames = new Set<string>();
  private recordContracts = new Map<string, import("../ast/types.js").RecordTypeNode>();

  constructor(private program?: Program, contextProgram?: Program, private options: EmitterOptions = {}) {
    for (const [name, contract] of options.importedRecordContracts ?? []) this.recordContracts.set(name, contract);
    // Source-map emission renders declarations individually, but resolution
    // still needs the bindings from the complete source program.
    for (const item of (contextProgram ?? program)?.body ?? []) {
      const decl = item.kind === "ExportDeclaration" ? item.declaration : item;
      if (item.kind === "ImportDeclaration" && item.source.raw === '"effect"') {
        for (const spec of item.specifiers) this.userEffectBindings.add(spec.local.name);
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
      if (decl.kind === "SchemaDeclaration" && decl.body.kind === "RecordSchema" && isRecordContract(decl.body)) {
        this.recordContracts.set(decl.id.name, recordContractType(decl.body));
      }
      if (decl.kind === "BindingDeclaration") this.bindings.set(decl.id.name, decl);
    }
  }

  public emit(): string {
    let bodyCode = "";

    if (this.program) {
      const visit = (value: unknown, parent?: Record<string, unknown>, grandparent?: Record<string, unknown>, key?: string): void => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) { value.forEach((child) => visit(child, parent, grandparent, key)); return; }
        const node = value as Record<string, any>;
        if (node.kind === "TypeReferenceNode" && this.recordContracts.has(node.name.name)) {
          if (!(parent?.kind === "Parameter" && grandparent?.kind === "FunctionExpression" && key === "typeAnnotation")) {
            throw new FunScriptError(`${node.name.name} is a compile-time record contract and is currently supported only as a direct function parameter`, node.span);
          }
        }
        for (const [childKey, child] of Object.entries(node)) if (childKey !== "span") visit(child, node, parent, childKey);
      };
      visit(this.program);
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
    if (this.needsTsPattern) {
      header += `import { match, P } from "ts-pattern";\n`;
    }
    if (this.needsMutative) {
      header += `import { create } from "mutative";\n`;
    }
    if (this.needsReferenceEquality) {
      header += `const __funscriptReferenceEquals = <T extends object>(left: T, right: T): boolean => left === right;\n`;
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

    switch (decl.body.kind) {
      case "RecordSchema": {
        if (isRecordContract(decl.body)) {
          const hasDefault = (value: unknown): boolean => {
            if (!value || typeof value !== "object") return false;
            if (Array.isArray(value)) return value.some(hasDefault);
            const node = value as Record<string, unknown>;
            return Boolean(node.defaultValue) || Object.entries(node).some(([key, child]) => key !== "span" && hasDefault(child));
          };
          if (hasDefault(decl.body)) throw new FunScriptError("Compile-time record contracts cannot declare schema defaults", decl.span);
          const brand = `${RECORD_CONTRACT_BRAND}$${name}`;
          return `declare const ${brand}: unique symbol;\n${exp}type ${name} = ${this.emitTypeNode(recordContractType(decl.body))} & { readonly [${brand}]?: never };`;
        }
        this.effectImports.add("Schema");
        const schemaFields = decl.body.fields
          .map((f) => {
            const schema = this.emitSchemaTypeField(f.typeAnnotation);
            if (f.optional) return `  ${f.name.name}: Schema.OptionFromOptional(${schema})`;
            if (!f.defaultValue) return `  ${f.name.name}: ${schema}`;
            this.effectImports.add("Effect");
            return `  ${f.name.name}: ${schema}.pipe(Schema.withDecodingDefaultType(Effect.sync(() => ${this.emitExpression(f.defaultValue!)})))`;
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
        this.effectImports.add("pipe");
        return `${exp}const ${name} = pipe(${this.emitSchemaTypeField(decl.body.baseType)}, ${this.emitExpression(decl.body.refinement)});\n${exp}type ${name} = typeof ${name}.Type;`;
      }
      case "TypeSignatureSchema": {
        return `${exp}type ${name} = ${this.emitTypeNode(decl.body.signature)};`;
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
          schemaExpr = this.options.importedSchemas?.get(decl.id.name) ?? `(Schema.Unknown as unknown as Schema.Schema<${this.emitTypeNode(targetType)}>)`;
        } else {
          schemaExpr = this.options.importedSchemas?.get(decl.id.name) ?? this.emitSchemaTypeField(targetType);
        }
        return `${exp}const ${name} = ${schemaExpr};\n${exp}type ${name} = typeof ${name}.Type;\n${exp}const ${name}FromUnknown = (input: unknown): ${name} => Schema.decodeUnknownSync(${name})(input);`;
      }
      case "ImportedTsSchema": {
        this.effectImports.add("Schema");
        const schemaExpr = this.options.importedSchemas?.get(decl.id.name) ?? `(Schema.Unknown as unknown as Schema.Schema<${this.emitTypeNode(decl.body.typeNode)}>)`;
        return `${exp}const ${name} = ${schemaExpr};\n${exp}type ${name} = typeof ${name}.Type;\n${exp}const ${name}FromUnknown = (input: unknown): ${name} => Schema.decodeUnknownSync(${name})(input);`;
      }
    }
  }

  private emitSchemaTypeField(typeNode: TypeNode): string {
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
      if (this.recordContracts.has(tName)) throw new FunScriptError(`${tName} is a compile-time record contract, not a runtime schema`, typeNode.span);
      if (tName === "SchemaInput" && !this.declaredTypeNames.has(tName)) {
        throw new Error("SchemaInput is a static input type, not a runtime schema; use the schema itself for validation");
      }
      if (PRIMITIVE_TYPES[tName] || tName === "Duration") return `Schema.${tName}`;
      if (tName === "UUID") return "Schema.UUID";
      if (tName === "Option" && typeNode.typeArgs) {
        return `Schema.Option(${this.emitSchemaTypeField(typeNode.typeArgs[0])})`;
      }
      if (tName === "Array" && typeNode.typeArgs?.length === 1) {
        return `Schema.Array(${this.emitSchemaTypeField(typeNode.typeArgs[0])})`;
      }
      if (tName === "Record" && typeNode.typeArgs?.length === 2) {
        return `Schema.Record(${this.emitSchemaTypeField(typeNode.typeArgs[0])}, ${this.emitSchemaTypeField(typeNode.typeArgs[1])})`;
      }
      return tName;
    }
    return this.emitTypeNode(typeNode);
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

  private isOptionalValue(expr: Expression): boolean {
    if (expr.kind === "Identifier") return this.isOptionalParameter(expr.name);
    if (expr.kind === "MemberExpression") return this.recordField(expr)?.optional ?? false;
    return false;
  }

  private validateRecordParameterUse(expr: FunctionExpression, name: string, aliases: Set<BindingDeclaration>): void {
    const shadowed = new Set(expr.params.map((param) => param.name.name));
    const collectBindings = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(collectBindings); return; }
      const node = value as Record<string, unknown>;
      if ((node.kind === "BindingDeclaration" || node.kind === "EffectBindStatement") && node.id && typeof node.id === "object") shadowed.add((node.id as { name: string }).name);
      if (node.kind === "VariablePattern" && node.name && typeof node.name === "object") shadowed.add((node.name as { name: string }).name);
      if (node.kind === "FunctionExpression" && Array.isArray(node.params)) {
        for (const param of node.params) if (param?.name?.name) shadowed.add(param.name.name);
      }
      for (const [key, child] of Object.entries(node)) if (key !== "span") collectBindings(child);
    };
    collectBindings(expr.body);
    const source = expr.params.find((param) => param.name.name === name)?.typeAnnotation;
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
      if (node.kind === "FunctionExpression" && Array.isArray(node.params) && node.params.some((param: any) => param.name?.name === name)) return;
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
        if (allowMember && parent?.kind === "JSXSpreadAttribute" && key === "argument" && isSafeLocalForward({ kind: "CallExpression", callee: jsxTarget }, 0)) return;
        if ((parent?.kind === "MemberExpression" && key === "property") || (parent?.kind === "FieldEntry" && key === "key") || (parent?.kind === "JSXAttribute" && key === "name")) return;
        throw new FunScriptError(`A record parameter with optional fields cannot be passed, returned, aliased, or indexed yet; access ${name}.field directly`, node.span as any);
      }
      for (const [childKey, child] of Object.entries(node)) {
        const target = childKey === "attributes" && (node.kind === "JSXOpeningElement" || node.kind === "JSXSelfClosingElement") ? node.name : jsxTarget;
        if (childKey !== "span" && childKey !== "typeAnnotation" && childKey !== "returnType") visit(child, node, childKey, allowMember, inJs || node.kind === "JsExpression", undefined, target);
      }
    };
    visit(expr.body);
    const param = expr.params.find((item) => item.name.name === name);
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
    if (scope) scope.set(decl.id.name, this.isOptionalValue(decl.init));
    const aliasedFields = !decl.isMut && decl.init.kind === "Identifier" ? this.recordFields(decl.init.name) : undefined;
    this.recordScopes.at(-1)?.set(decl.id.name, aliasedFields);
    if (this.isPrimitiveType(decl.typeAnnotation) || this.isPrimitive(decl.init)) {
      this.primitiveIdentifiers.add(decl.id.name);
    }
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
          .filter((p) => p.typeAnnotation)
          .map((p) => `  ${p.name.name} = Schema.decodeUnknownSync(${this.emitSchemaTypeField(p.typeAnnotation!)})(${p.name.name});`)
          .join("\n");
        if (validations) this.effectImports.add("Schema");
        for (const p of fn.params) {
          if (this.isPrimitiveType(p.typeAnnotation)) {
            this.primitiveIdentifiers.add(p.name.name);
          }
        }
        const params = fn.params
          .map((p) => {
            const t = p.typeAnnotation ? `: ${this.emitTypeNode(p.typeAnnotation)}` : "";
            return `${p.name.name}${t}`;
          })
          .join(", ");
        if (fn.body.kind === "BlockStatement") {
          const retExpr = fn.body.finalExpression ? this.emitExpression(fn.body.finalExpression) : "undefined";
          if (fn.body.statements.length === 0) {
            return `${exp}${keyword} ${decl.id.name} = (${params}) => {\n${validations}\n  return Effect.runPromise(${retExpr});\n};`;
          }
          const stmts = fn.body.statements.map((s) => "    " + this.emitStatement(s)).join("\n");
          return `${exp}${keyword} ${decl.id.name} = (${params}) => {\n${validations}\n  return Effect.runPromise(Effect.gen(function* () {\n${stmts}\n    return ${retExpr};\n  }));\n};`;
        }
        return `${exp}${keyword} ${decl.id.name} = (${params}) => {\n${validations}\n  return Effect.runPromise(${this.emitExpression(fn.body)});\n};`;
      }
      return `${exp}${keyword} ${decl.id.name}${typeAnn} = Effect.runPromise(${this.emitExpression(decl.init)});`;
    }

    return `${exp}${keyword} ${decl.id.name}${typeAnn} = ${this.emitExpression(decl.init)};`;
  }

  // --- Expressions ---

  public emitExpression(expr: Expression): string {
    switch (expr.kind) {
      case "NumberLiteral":
        return expr.raw;
      case "StringLiteral":
        return this.emitStringLiteral(expr);
      case "BooleanLiteral":
        return expr.value ? "true" : "false";
      case "Identifier":
      case "UpperIdentifier":
        if (this.recordContracts.has(expr.name)) throw new FunScriptError(`${expr.name} is a compile-time record contract, not a runtime schema`, expr.span);
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
        return `${this.emitExpression(expr.callee)}(${expr.args.map((a) => this.emitExpression(a)).join(", ")})`;
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
        return `${this.emitExpression(expr.object)}[${this.emitExpression(expr.index)}]`;
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
  }

  private inferPipelineCompanion(source: Expression): CompanionModule | undefined {
    const inferred = this.options.pipelineCompanions?.get(source.span.start.offset);
    if (inferred) return inferred;
    if (source.kind === "ArrayExpression") return "Array";
    if (source.kind === "StringLiteral") return "String";
    if (source.kind === "RecordExpression") return "Struct";
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
            property: { ...stage.callee, name: name === "lines" ? "linesIterator" : name === "decode" ? "decodeUnknown" : name },
            span: stage.callee.span,
          },
        };
      }
    }

    // 1b. CallExpression with MemberExpression companion call: Array.map(f), Option.getOrElse(f), etc.
    if (stage.kind === "CallExpression" && stage.callee.kind === "MemberExpression") {
      const obj = stage.callee.object;
      const prop = stage.callee.property;
      if (obj.kind === "UpperIdentifier") {
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

    return stage;
  }

  private getCompanionModule(name: string, preferredCompanion?: CompanionModule): CompanionModule | undefined {
    if (preferredCompanion && this.isCompanionOperation(preferredCompanion, name)) return preferredCompanion;
    const candidates: CompanionModule[] = [];
    if (ARRAY_COMPANION_METHODS.has(name)) candidates.push("Array");
    if (EFFECT_COMPANION_METHODS.has(name)) candidates.push("Effect");
    if (OPTION_COMPANION_METHODS.has(name)) candidates.push("Option");
    if (RESULT_COMPANION_METHODS.has(name)) candidates.push("Result");
    if (CHUNK_COMPANION_METHODS.has(name)) candidates.push("Chunk");
    if (name === "decode" || (preferredCompanion === "Schema" && this.isCompanionOperation("Schema", name))) candidates.push("Schema");
    if (preferredCompanion && candidates.includes(preferredCompanion)) return preferredCompanion;
    if (candidates.length === 1) return candidates[0];
    // The caller turns an ambiguous core companion into a source diagnostic.
    // Keeping the sentinel local avoids silently reintroducing priority order.
    if (candidates.length > 1) return undefined;
    if (NUMBER_COMPANION_METHODS.has(name)) return "Number";
    if (STRING_COMPANION_METHODS.has(name)) return "String";
    if (RECORD_COMPANION_METHODS.has(name)) return "Struct";
    if (DURATION_COMPANION_METHODS.has(name)) return "Duration";
    return undefined;
  }

  private isCompanionOperation(module: CompanionModule, operation: string): boolean {
    if (module === "Number") return NUMBER_COMPANION_METHODS.has(operation);
    if (module === "String") return STRING_COMPANION_METHODS.has(operation);
    if (module === "Struct") return RECORD_COMPANION_METHODS.has(operation);
    if (module === "Duration") return DURATION_COMPANION_METHODS.has(operation);
    return (PIPELINE_COMPANION_CATALOG[module]?.includes(operation) ?? false) ||
      (module === "Effect" && operation in EFFECT_PIPELINE_COMPATIBILITY_ALIASES);
  }

  private assertPipelineStageIsNotAmbiguous(stage: Expression, preferredCompanion?: CompanionModule): void {
    const name = stage.kind === "Identifier"
      ? stage.name
      : stage.kind === "CallExpression" && stage.callee.kind === "Identifier"
      ? stage.callee.name
      : undefined;
    if (!name || preferredCompanion) return;
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
        return `__funscriptReferenceEquals(${left}, ${right})`;
      case "@!":
        if (this.isPrimitive(expr.left) || this.isPrimitive(expr.right)) {
          throw new Error(`Reference identity operator '@!' cannot be used with primitive values; use '#=' or '#!' for value equality`);
        }
        this.needsReferenceEquality = true;
        return `(!__funscriptReferenceEquals(${left}, ${right}))`;
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
            return `  draft.${e.key.name} = ${this.emitExpression(e.value)};`;
          }
          return `  draft.${e.key.name} = ${e.key.name};`;
        })
        .join("\n");
      return `create(${base}, (draft) => {\n${mutations}\n})`;
    }

    const entries = expr.entries
      .map((e) => {
        if (e.kind === "SpreadEntry") return `...${this.emitExpression(e.argument)}`;
        if (e.kind === "FieldEntry") return `${e.key.name}: ${this.emitExpression(e.value)}`;
        if (e.kind === "ShorthandEntry") return e.key.name;
        return "";
      })
      .join(", ");
    return `{ ${entries} }`;
  }

  private emitFunctionExpression(expr: FunctionExpression): string {
    for (const p of expr.params) {
      if (this.isPrimitiveType(p.typeAnnotation)) {
        this.primitiveIdentifiers.add(p.name.name);
      }
    }
    const params = expr.params
      .map((p, index) => {
        const name = p.optional ? `$funscriptOptional${index}` : p.name.name;
        const typeAnn = p.typeAnnotation ? `: ${this.emitTypeNode(p.typeAnnotation)}` : "";
        const defaultValue = p.defaultValue ? ` = ${this.emitExpression(p.defaultValue)}` : "";
        return `${name}${p.optional ? "?" : ""}${typeAnn}${defaultValue}`;
      })
      .join(", ");
    const retType = expr.returnType ? `: ${this.emitTypeNode(expr.returnType)}` : "";
    const optionalBindings = expr.params.flatMap((p, index) => {
      if (!p.optional) return [];
      this.effectImports.add("Option");
      return [`  const ${p.name.name} = Option.fromUndefinedOr($funscriptOptional${index});`];
    });

    const records = new Map<string, Map<string, RecordFieldInfo> | undefined>();
    const recordDefaults: string[] = [];
    expr.params.forEach((param, paramIndex) => {
      const declared = param.typeAnnotation;
      const recordType = declared?.kind === "TypeReferenceNode" ? this.recordContracts.get(declared.name.name) : declared;
      if (declared?.kind === "TypeReferenceNode" && recordType && (param.optional || param.defaultValue)) {
        throw new FunScriptError("A compile-time record contract parameter cannot itself be optional or defaulted yet", param.span);
      }
      if (recordType?.kind !== "RecordTypeNode") { records.set(param.name.name, undefined); return; }
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
      if (!fields.some((field) => field.optional || field.defaultValue || nestedFields(field.typeAnnotation))) { records.set(param.name.name, undefined); return; }
      const mapped = new Map<string, RecordFieldInfo>();
      fields.forEach((field, fieldIndex) => {
        const binding = field.defaultValue ? `$funscriptField${paramIndex}_${fieldIndex}` : undefined;
        if (field.defaultValue) {
          this.validateRecordDefault(field.defaultValue, new Set(expr.params.map((p) => p.name.name)));
          const raw = `$funscriptFieldRaw${paramIndex}_${fieldIndex}`;
          recordDefaults.push(`  const ${raw} = ${param.name.name}.${field.name.name};`);
          recordDefaults.push(`  const ${binding} = ${raw} === undefined ? ${this.emitExpression(field.defaultValue)} : ${raw};`);
        }
        const children = nestedFields(field.typeAnnotation);
        mapped.set(field.name.name, { optional: Boolean(field.optional), defaultBinding: binding, fields: children });
      });
      records.set(param.name.name, mapped);
    });
    const aliases = new Set<BindingDeclaration>();
    if (expr.body.kind === "BlockStatement") {
      for (const stmt of expr.body.statements) {
        if (stmt.kind !== "BindingDeclaration" || stmt.isMut || stmt.isJs || stmt.init.kind !== "Identifier" || records.has(stmt.id.name)) continue;
        const fields = records.get(stmt.init.name);
        if (!fields || [...fields.values()].some((field) => field.defaultBinding)) continue;
        records.set(stmt.id.name, fields);
        aliases.add(stmt);
      }
    }
    this.parameterScopes.push(new Map(expr.params.map((p) => [p.name.name, Boolean(p.optional)])));
    this.recordScopes.push(records);
    try {
      for (const name of records.keys()) if (records.get(name)) this.validateRecordParameterUse(expr, name, aliases);
      if (expr.body.kind === "BlockStatement" || optionalBindings.length || recordDefaults.length) {
        const body = this.emitFunctionBody(expr.body);
        return `(${params})${retType} => {\n${[...optionalBindings, ...recordDefaults, body].filter(Boolean).join("\n")}\n}`;
      }
      return `(${params})${retType} => ${this.emitArrowExpression(expr.body)}`;
    } finally {
      this.recordScopes.pop();
      this.parameterScopes.pop();
    }
  }

  private emitFunctionBody(body: FunctionBody): string {
    if (body.kind === "BlockStatement") {
      const stmts = body.statements.map((s) => "  " + this.emitStatement(s)).join("\n");
      const ret = body.finalExpression ? `  return ${this.emitExpression(body.finalExpression)};` : "";
      if (stmts && ret) return `${stmts}\n${ret}`;
      if (stmts) return stmts;
      if (ret) return ret;
      return "";
    }
    return `  return ${this.emitExpression(body)};`;
  }

  private emitArrowExpression(expr: Expression): string {
    const emitted = this.emitExpression(expr);
    return expr.kind === "RecordExpression" ? `(${emitted})` : emitted;
  }

  private emitStatement(stmt: Statement): string {
    if (stmt.kind === "BindingDeclaration") {
      return this.emitBindingDeclaration(stmt);
    }
    if (stmt.kind === "AssignmentStatement") {
      const target = stmt.target.kind === "Identifier" || stmt.target.kind === "IndexExpression"
        ? this.emitExpression(stmt.target)
        : stmt.target.path.map((p) => p.name).join(".");
      return `${target} = ${this.emitExpression(stmt.value)};`;
    }
    if (stmt.kind === "ReturnStatement") {
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
      const elements = pat.elements.map((e) => this.emitPattern(e)).join(", ");
      return `[${elements}]`;
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
    const optionalParameter = scrutinee?.kind === "Identifier" && this.isOptionalParameter(scrutinee.name);
    if (pat?.kind === "ConstructorPattern" && pat.constructorName.name === "Some" && pat.args.length === 1 && pat.args[0].kind === "VariablePattern" && vars.length === 1) {
      const unpack = optionalParameter
        ? `const { value: ${vars[0]} } = $matched;`
        : `const { _tag: _, ...__fields } = $matched;\n    const [${vars[0]}] = Object.values(__fields) as [typeof $matched extends import("effect").Option.Some<infer V> ? V : any];`;
      if (body.kind === "BlockStatement") return `($matched) => {\n    ${unpack}\n${this.emitFunctionBody(body)}\n  }`;
      return `($matched) => {\n    ${unpack}\n    return ${this.emitExpression(body)};\n  }`;
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
    return [];
  }

  private emitEffectBlockExpression(expr: EffectBlockExpression): string {
    this.effectImports.add("Effect");
    const statements = expr.body
      .map((s) => {
        if (s.kind === "EffectBindStatement") {
          return `    const ${s.id.name} = yield* ${this.emitEffectCall(s.effect)};`;
        }
        if (s.kind === "EffectDiscardStatement") {
          return `    yield* ${this.emitEffectCall(s.effect)};`;
        }
        if (s.kind === "BindingDeclaration") {
          return `    ${this.emitBindingDeclaration(s)}`;
        }
        if (s.kind === "AssignmentStatement") {
          const target = s.target.kind === "Identifier" || s.target.kind === "IndexExpression"
            ? this.emitExpression(s.target)
            : s.target.path.map((p) => p.name).join(".");
          return `    ${target} = ${this.emitExpression(s.value)};`;
        }
        if (s.kind === "WhenStatement") {
          return `    ${this.emitWhenStatement(s, true)}`;
        }
        return "";
      })
      .join("\n");

    const ret = `    return ${this.emitExpression(expr.finalExpression)};`;
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

  private emitTypeNode(node: TypeNode): string {
    switch (node.kind) {
      case "TypeReferenceNode": {
        let name = node.name.name;
        if (name === "SchemaInput" && !this.declaredTypeNames.has(name)) {
          const arg = node.typeArgs?.[0];
          if (node.typeArgs?.length !== 1 || arg?.kind !== "TypeReferenceNode" || arg.typeArgs?.length) {
            throw new Error("SchemaInput requires one named schema, for example SchemaInput<User>");
          }
          return `typeof ${arg.name.name}.Encoded`;
        }
        if (PRIMITIVE_TYPES[name]) return PRIMITIVE_TYPES[name];
        if (name === "Array" && !this.declaredTypeNames.has(name)) name = "ReadonlyArray";
        else if (["Option", "Record", "Duration"].includes(name) && !this.declaredTypeNames.has(name)) {
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
            const name = p.name ? p.name.name : "_";
            return p.typeAnnotation ? `${name}: ${this.emitTypeNode(p.typeAnnotation)}` : name;
          })
          .join(", ");
        return `(${params}) => ${this.emitTypeNode(node.returnType)}`;
      }
      case "EffectTypeNode": {
        this.effectImports.add("Effect");
        const succ = this.emitTypeNode(node.success);
        const err = node.error ? this.emitTypeNode(node.error) : "never";
        const req = node.requirements ? this.emitTypeNode(node.requirements) : "never";
        return `Effect.Effect<${succ}, ${err}, ${req}>`;
      }
      case "RecordTypeNode": {
        const fields = node.fields.map((f) => `readonly ${f.name.name}${f.optional || f.defaultValue ? "?" : ""}: ${this.emitTypeNode(f.typeAnnotation)}`).join("; ");
        return `{ ${fields} }`;
      }
      case "ArrayTypeNode":
        return `ReadonlyArray<${this.emitTypeNode(node.elementType)}>`;
      case "UnionTypeNode":
        return node.types.map((t) => this.emitTypeNode(t)).join(" | ");
      case "LiteralTypeNode":
        return JSON.stringify(node.value);
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
