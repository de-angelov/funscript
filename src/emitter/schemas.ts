import type {
  BindingTarget,
  EffectTypeNode,
  Expression,
  FunctionTypeNode,
  Pattern,
  RecordTypeNode,
  SchemaDeclaration,
  TaggedUnionSchema,
  TypeNode,
  TypeParameter,
  TypeReferenceNode,
} from "../ast/types.js";
import {
  RECORD_CONTRACT_BRAND,
  recordContractType,
} from "../compiler/record-contracts.js";
import { FunScriptError } from "../errors.js";
import { PRIMITIVE_TYPES, emitPropertyKey } from "./types.js";

export interface SchemaEmitterContext {
  recordContracts: {
    has(name: string): boolean;
    get(name: string): RecordTypeNode | undefined;
  };
  declaredTypeNames: Set<string>;
  bindings: { has(name: string): boolean };
  userImportBindings: Set<string>;
  runtimeSchemaNames: Set<string>;
  identityRecordSchemas: Set<string>;
  checkedTaggedSchemas: Map<string, TaggedUnionSchema>;
  genericDataSchemas: Map<string, number>;
  genericSchemaDeclarations: Map<string, SchemaDeclaration>;
  readonly activeSchemaParameters?: ReadonlySet<string>;
  readonly unsafeSchemaBinding: boolean;
  needsCheckedRecordDecoder: boolean;
  checkedCallbackKinds: Set<string>;
  options: {
    importedSchemas?: ReadonlyMap<string, string>;
    importedIdentitySchemas?: ReadonlySet<string>;
    importedDataSchemas?: ReadonlySet<string>;
    importedGenericDataSchemas?: ReadonlyMap<string, number>;
  };
  withSchemaParameters<T>(names: ReadonlySet<string>, fn: () => T): T;
  addEffectImport(name: string): void;
  emitExpression(expr: Expression): string;
  emitBindingTarget(target: BindingTarget | Pattern): string;
  emitTypeNode(node: TypeNode): string;
  emitTypeParameters(typeParams?: TypeParameter[]): string;
}

function flattenPipelineStages(expr: Expression): Expression[] {
  if (expr.kind === "PipelineExpression") {
    return [
      ...flattenPipelineStages(expr.left),
      ...flattenPipelineStages(expr.right),
    ];
  }
  return [expr];
}

function extractBrandNames(stages: Expression[]): string[] {
  const brands: string[] = [];
  for (const stage of stages) {
    const b = getBrandNameFromStage(stage);
    if (b) brands.push(b);
  }
  return brands;
}

function getBrandNameFromStage(stage: Expression): string | null {
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
    (callee.object.kind === "Identifier" ||
      callee.object.kind === "UpperIdentifier") &&
    (callee.object.name === "Schema" || callee.object.name === "Brand") &&
    callee.property.name === "brand"
  ) {
    isBrand = true;
  }
  if (!isBrand || stage.args.length === 0) return null;
  const first = stage.args[0];
  if (first.kind === "StringLiteral") {
    return first.parts
      .map((p) => (p.kind === "StringRawPart" ? p.value : ""))
      .join("");
  }
  return null;
}

function emitRefinementStage(
  ctx: SchemaEmitterContext,
  stage: Expression,
): string {
  const brandName = getBrandNameFromStage(stage);
  if (brandName !== null) {
    ctx.addEffectImport("Schema");
    return `Schema.brand(${JSON.stringify(brandName)})`;
  }
  return ctx.emitExpression(stage);
}

export function emitSchemaDeclaration(
  ctx: SchemaEmitterContext,
  decl: SchemaDeclaration,
  isExport: boolean,
): string {
  const name = decl.id.name;
  const exp = isExport ? "export " : "";

  if (
    decl.typeParams?.length &&
    decl.body.kind !== "TypeSignatureSchema" &&
    decl.body.kind !== "TaggedUnionSchema" &&
    decl.body.kind !== "RecordSchema" &&
    decl.body.kind !== "StructuralUnionSchema"
  ) {
    throw new FunScriptError(
      "Generic runtime schemas are not supported yet; use a TypeScript type alias",
      decl.span,
    );
  }

  switch (decl.body.kind) {
    case "RecordSchema": {
      if (ctx.recordContracts.has(name)) {
        const brand = `${RECORD_CONTRACT_BRAND}$${name}`;
        const typeParamsStr = ctx.emitTypeParameters(decl.typeParams);
        const contract = `declare const ${brand}: unique symbol;\n${exp}type ${name}${typeParamsStr} = ${ctx.emitTypeNode(recordContractType(decl.body))} & { readonly [${brand}]?: never };`;
        return contract + emitCheckedRecordDecoder(ctx, decl, exp);
      }
      if (decl.typeParams?.length) return emitGenericDataSchema(ctx, decl, exp);
      ctx.addEffectImport("Schema");
      const schemaFields = decl.body.fields
        .map((f) => {
          const fieldKey = emitPropertyKey(f.name.name);
          const optionInner = !f.defaultValue
            ? extractOptionInnerType(f.typeAnnotation)
            : undefined;
          if (optionInner) {
            const innerSchema = emitSchemaTypeField(ctx, optionInner);
            return `  ${fieldKey}: Schema.OptionFromOptionalNullOr(${innerSchema}, { onNoneEncoding: "omit" })`;
          }
          const schema = emitSchemaTypeField(ctx, f.typeAnnotation);
          if (!f.defaultValue) return `  ${fieldKey}: ${schema}`;
          ctx.addEffectImport("Effect");
          return `  ${fieldKey}: ${schema}.pipe(Schema.withDecodingDefaultType(Effect.sync(() => ${ctx.emitExpression(f.defaultValue)})))`;
        })
        .join(",\n");
      return `${exp}const ${name} = Schema.Struct({\n${schemaFields}\n});\n${exp}type ${name} = typeof ${name}.Type;\n${exp}const ${name}FromUnknown = (input: unknown): ${name} => Schema.decodeUnknownSync(${name})(input);`;
    }
    case "TaggedUnionSchema": {
      ctx.addEffectImport("Data");
      const typeParams = ctx.emitTypeParameters(decl.typeParams);
      const hasTypeParams = Boolean(
        decl.typeParams && decl.typeParams.length > 0,
      );
      const anyArgs = hasTypeParams
        ? `<${decl.typeParams!.map(() => "any").join(", ")}>`
        : "";
      const neverArgs = hasTypeParams
        ? `<${decl.typeParams!.map(() => "never").join(", ")}>`
        : "";
      const typeArgs = hasTypeParams
        ? `<${decl.typeParams!.map((tp) => tp.name.name).join(", ")}>`
        : "";

      const collectTypeParamNames = (type: TypeNode): Set<string> => {
        const names = new Set<string>();
        const walk = (t: TypeNode | undefined): void => {
          if (!t) return;
          if (t.kind === "TypeReferenceNode") {
            names.add(t.name.name);
            if (t.typeArgs) t.typeArgs.forEach(walk);
          } else if (t.kind === "FunctionTypeNode") {
            t.params.forEach((p) => walk(p.typeAnnotation));
            walk(t.returnType);
          } else if (t.kind === "EffectTypeNode") {
            walk(t.success);
            walk(t.error);
            walk(t.requirements);
          } else if (t.kind === "RecordTypeNode") {
            t.fields.forEach((f) => walk(f.typeAnnotation));
          } else if (t.kind === "IntersectionTypeNode") {
            t.types.forEach(walk);
          }
        };
        walk(type);
        return names;
      };

      const typeVariants = decl.body.variants
        .map((v) => {
          if (v.fields.length === 0) {
            return `  ${v.name.name}: {}`;
          }
          const fields = v.fields
            .map(
              (f) =>
                `readonly ${f.name.name}: ${ctx.emitTypeNode(f.typeAnnotation)}`,
            )
            .join("; ");
          return `  ${v.name.name}: { ${fields} }`;
        })
        .join(";\n");

      const constructors = decl.body.variants
        .map((v) => {
          if (v.fields.length === 0) {
            const retType = hasTypeParams ? `${name}${neverArgs}` : name;
            return `${exp}const ${v.name.name}: ${retType} = $${name}.${v.name.name}();`;
          }
          const usedParams = new Set<string>();
          for (const f of v.fields) {
            for (const pName of collectTypeParamNames(f.typeAnnotation)) {
              usedParams.add(pName);
            }
          }
          let constrTypeParams = "";
          if (hasTypeParams) {
            const requiredParams = decl.typeParams!.filter((tp) =>
              usedParams.has(tp.name.name),
            );
            const optionalParams = decl.typeParams!.filter(
              (tp) => !usedParams.has(tp.name.name),
            );
            const paramsList = [
              ...requiredParams.map((tp) => tp.name.name),
              ...optionalParams.map((tp) => `${tp.name.name} = never`),
            ];
            constrTypeParams = `<${paramsList.join(", ")}>`;
          }
          const params = v.fields
            .map((f) => `${f.name.name}: ${ctx.emitTypeNode(f.typeAnnotation)}`)
            .join(", ");
          const args = v.fields.map((f) => f.name.name).join(", ");
          const retType = hasTypeParams ? `${name}${typeArgs}` : name;
          return `${exp}const ${v.name.name} = ${constrTypeParams}(${params}): ${retType} => $${name}.${v.name.name}({ ${args} });`;
        })
        .join("\n");

      return `${exp}type ${name}${typeParams} = Data.TaggedEnum<{\n${typeVariants}\n}>;\nconst $${name} = Data.taggedEnum<${name}${anyArgs}>();\n${constructors}`;
    }
    case "StructuralUnionSchema": {
      if (decl.typeParams?.length) return emitGenericDataSchema(ctx, decl, exp);
      ctx.addEffectImport("Schema");
      const members = decl.body.members
        .map((member) => emitSchemaTypeField(ctx, member))
        .join(", ");
      return `${exp}const ${name} = Schema.Union([${members}]);\n${exp}type ${name} = typeof ${name}.Type;\n${exp}const ${name}FromUnknown = (input: unknown): ${name} => Schema.decodeUnknownSync(${name})(input);`;
    }
    case "RefinementSchema": {
      const stages = flattenPipelineStages(decl.body.refinement);
      const brands = extractBrandNames(stages);

      if (brands.length > 0) {
        ctx.addEffectImport("Schema");
        ctx.addEffectImport("Brand");
        const baseSchema = emitSchemaTypeField(ctx, decl.body.baseType);
        const emittedStages = stages.map((s) => emitRefinementStage(ctx, s));

        const baseTypeName =
          decl.body.baseType.kind === "TypeReferenceNode" &&
          decl.body.baseType.name.name === "Int"
            ? "number"
            : ctx.emitTypeNode(decl.body.baseType);

        const brandTypeStr = brands
          .map((b) => `Brand.Brand<${JSON.stringify(b)}>`)
          .join(" & ");
        const typeDef = `${baseTypeName} & ${brandTypeStr}`;

        return `${exp}const ${name} = ${baseSchema}.pipe(${emittedStages.join(", ")});\n${exp}type ${name} = ${typeDef};\n${exp}const ${name}FromUnknown = (input: unknown): ${name} => Schema.decodeUnknownSync(${name})(input);`;
      }

      ctx.addEffectImport("pipe");
      ctx.addEffectImport("Schema");
      return `${exp}const ${name} = pipe(${emitSchemaTypeField(ctx, decl.body.baseType)}, ${ctx.emitExpression(decl.body.refinement)});\n${exp}type ${name} = typeof ${name}.Type;\n${exp}const ${name}FromUnknown = (input: unknown): ${name} => Schema.decodeUnknownSync(${name})(input);`;
    }
    case "TypeSignatureSchema": {
      return `${exp}type ${name}${ctx.emitTypeParameters(decl.typeParams)} = ${ctx.emitTypeNode(decl.body.signature)};`;
    }
    case "TsDerivedSchema": {
      ctx.addEffectImport("Schema");
      let schemaExpr: string;
      const targetType = decl.body.targetType;
      if (
        targetType.kind === "TypeReferenceNode" &&
        ctx.options.importedSchemas?.has(decl.id.name)
      ) {
        schemaExpr = ctx.options.importedSchemas.get(decl.id.name)!;
      } else if (
        targetType.kind === "TypeReferenceNode" &&
        ctx.recordContracts.has(targetType.name.name)
      ) {
        schemaExpr = emitSchemaTypeField(ctx, targetType);
      } else if (
        targetType.kind === "TypeReferenceNode" &&
        !PRIMITIVE_TYPES[targetType.name.name] &&
        targetType.name.name !== "Duration" &&
        targetType.name.name !== "UUID" &&
        !ctx.declaredTypeNames.has(targetType.name.name) &&
        targetType.name.name !== "Option" &&
        targetType.name.name !== "Array" &&
        targetType.name.name !== "Record"
      ) {
        schemaExpr =
          ctx.options.importedSchemas?.get(decl.id.name) ??
          `(Schema.Unknown as unknown as Schema.Codec<${ctx.emitTypeNode(targetType)}>)`;
      } else {
        schemaExpr =
          ctx.options.importedSchemas?.get(decl.id.name) ??
          emitSchemaTypeField(ctx, targetType);
      }
      return `${exp}const ${name} = ${schemaExpr};\n${exp}type ${name} = typeof ${name}.Type;\n${exp}const ${name}FromUnknown = (input: unknown): ${name} => Schema.decodeUnknownSync(${name})(input);`;
    }
    case "ImportedTsSchema": {
      ctx.addEffectImport("Schema");
      const schemaExpr =
        ctx.options.importedSchemas?.get(decl.id.name) ??
        `(Schema.Unknown as unknown as Schema.Codec<${ctx.emitTypeNode(decl.body.typeNode)}>)`;
      return `${exp}const ${name} = ${schemaExpr};\n${exp}type ${name} = typeof ${name}.Type;\n${exp}const ${name}FromUnknown = (input: unknown): ${name} => Schema.decodeUnknownSync(${name})(input);`;
    }
  }
}

function emitGenericDataSchema(
  ctx: SchemaEmitterContext,
  decl: SchemaDeclaration,
  exp: string,
): string {
  if (
    (decl.body.kind !== "RecordSchema" &&
      decl.body.kind !== "StructuralUnionSchema") ||
    !decl.typeParams?.length
  )
    throw new Error("Expected a generic record or union schema");
  const parameters = decl.typeParams.map((param) => param.name.name);
  const names = new Set(parameters);
  if (
    ctx.unsafeSchemaBinding ||
    ctx.declaredTypeNames.has("Schema") ||
    ctx.bindings.has("Schema")
  ) {
    throw new FunScriptError(
      "Generic data schemas require 'Schema' to refer to Effect Schema; rename the conflicting declaration or import.",
      decl.span,
    );
  }
  if (
    names.size !== parameters.length ||
    decl.typeParams.some(
      (param) =>
        param.constraint ||
        [
          "Schema",
          "String",
          "Number",
          "Boolean",
          "Array",
          "Option",
          "Record",
          decl.id.name,
        ].includes(param.name.name),
    )
  ) {
    throw new FunScriptError(
      "Generic data schemas require distinct, unconstrained type parameters that do not shadow built-in schema names.",
      decl.span,
    );
  }

  const visitFactory = (name: string, active: Set<string>): boolean => {
    if (active.has(name)) return false;
    const target = ctx.genericSchemaDeclarations.get(name);
    if (
      !target ||
      (target.body.kind !== "RecordSchema" &&
        target.body.kind !== "StructuralUnionSchema")
    )
      return true;
    const next = new Set(active).add(name);
    const params = new Set(target.typeParams?.map((param) => param.name.name));
    const visitType = (type: TypeNode): boolean => {
      if (type.kind === "ParenthesizedTypeNode")
        return visitType(type.typeNode);
      if (type.kind === "ArrayTypeNode") return visitType(type.elementType);
      if (type.kind === "UnionTypeNode") return type.types.every(visitType);
      if (type.kind === "RecordTypeNode")
        return type.fields.every((field) => visitType(field.typeAnnotation));
      if (type.kind !== "TypeReferenceNode") return true;
      return (
        (params.has(type.name.name) ||
          !ctx.genericSchemaDeclarations.has(type.name.name) ||
          visitFactory(type.name.name, next)) &&
        (type.typeArgs?.every(visitType) ?? true)
      );
    };
    if (target.body.kind === "RecordSchema") {
      return target.body.fields.every((field) =>
        visitType(field.typeAnnotation),
      );
    }
    return target.body.members.every(visitType);
  };
  if (!visitFactory(decl.id.name, new Set())) {
    throw new FunScriptError(
      `Generic data schema '${decl.id.name}' cannot use recursive generic schema factories.`,
      decl.span,
    );
  }
  const supportsArgument = (type: TypeNode): boolean => {
    if (type.kind === "ParenthesizedTypeNode")
      return supportsArgument(type.typeNode);
    if (type.kind !== "TypeReferenceNode") return false;
    const name = type.name.name;
    if (names.has(name)) return !type.typeArgs?.length;
    if (["String", "Number", "Boolean"].includes(name))
      return !type.typeArgs?.length && !ctx.declaredTypeNames.has(name);
    if (name === "Array" || name === "Option")
      return type.typeArgs?.length === 1 && supportsArgument(type.typeArgs[0]);
    const arity =
      ctx.genericDataSchemas.get(name) ??
      ctx.options.importedGenericDataSchemas?.get(name);
    if (arity !== undefined)
      return (
        type.typeArgs?.length === arity && type.typeArgs.every(supportsArgument)
      );
    return (
      !type.typeArgs?.length &&
      ((ctx.runtimeSchemaNames.has(name) &&
        !ctx.genericDataSchemas.has(name)) ||
        ctx.options.importedDataSchemas?.has(name) === true)
    );
  };
  const supports = (type: TypeNode): boolean => {
    if (type.kind === "ParenthesizedTypeNode") return supports(type.typeNode);
    if (type.kind === "LiteralTypeNode") return true;
    if (type.kind === "ArrayTypeNode") return supports(type.elementType);
    if (type.kind === "UnionTypeNode") return type.types.every(supports);
    if (type.kind === "RecordTypeNode")
      return type.fields.every(
        (field) =>
          field.name.name !== "__proto__" &&
          !field.defaultValue &&
          supports(field.typeAnnotation),
      );
    if (type.kind !== "TypeReferenceNode") return false;
    const name = type.name.name;
    if (names.has(name)) return !type.typeArgs?.length;
    if (["String", "Number", "Boolean"].includes(name))
      return !type.typeArgs?.length && !ctx.declaredTypeNames.has(name);
    if (name === "Array" || name === "Option")
      return type.typeArgs?.length === 1 && supports(type.typeArgs[0]);
    const arity =
      ctx.genericDataSchemas.get(name) ??
      ctx.options.importedGenericDataSchemas?.get(name);
    if (arity !== undefined)
      return (
        type.typeArgs?.length === arity && type.typeArgs.every(supportsArgument)
      );
    return (
      !type.typeArgs?.length &&
      ((ctx.runtimeSchemaNames.has(name) &&
        !ctx.genericDataSchemas.has(name)) ||
        ctx.options.importedDataSchemas?.has(name) === true)
    );
  };
  if (decl.body.kind === "RecordSchema") {
    for (const field of decl.body.fields) {
      if (
        field.name.name === "__proto__" ||
        field.defaultValue ||
        !supports(field.typeAnnotation)
      ) {
        throw new FunScriptError(
          `Generic data schema '${decl.id.name}' currently supports required or optional fields with primitive, local data-schema, type-parameter, array, union, verified generic application, or nested required-record types. Field '${field.name.name}' needs an explicit non-generic schema or contract.`,
          field.span,
        );
      }
    }
  } else {
    for (const member of decl.body.members) {
      if (!supports(member)) {
        throw new FunScriptError(
          `Generic data schema '${decl.id.name}' currently supports primitive, local data-schema, type-parameter, array, union, verified generic application, or nested required-record types in union members. Member '${ctx.emitTypeNode(member)}' needs an explicit non-generic schema or contract.`,
          member.span,
        );
      }
    }
  }
  ctx.addEffectImport("Schema");
  ctx.addEffectImport("SchemaAST as $funscriptSchemaAST");
  const body = decl.body;
  return ctx.withSchemaParameters(names, () => {
    const args = parameters
      .map(
        (param) =>
          `${param} extends Schema.Constraint & { readonly "~type.optionality": "required"; readonly "~type.mutability": "readonly" }`,
      )
      .join(", ");
    const values = parameters.map((param) => `${param}: ${param}`).join(", ");
    const checks = parameters
      .map(
        (param) =>
          `  if (!Schema.isSchema(${param}) || $funscriptSchemaAST.isOptional($funscriptSchemaAST.toType(${param}.ast)) || $funscriptSchemaAST.toType(${param}.ast).context?.isMutable) throw new TypeError(${JSON.stringify(`${decl.id.name} requires a schema without optional-key or mutable-key modifiers for ${param}`)});`,
      )
      .join("\n");

    if (body.kind === "RecordSchema") {
      const fields = body.fields
        .map((field) => {
          const optionInner = !field.defaultValue
            ? extractOptionInnerType(field.typeAnnotation)
            : undefined;
          if (optionInner) {
            const innerSchema = emitSchemaTypeField(ctx, optionInner);
            return `  ${emitPropertyKey(field.name.name)}: Schema.OptionFromOptionalNullOr(${innerSchema}, { onNoneEncoding: "omit" })`;
          }
          const schema = emitSchemaTypeField(ctx, field.typeAnnotation);
          return `  ${emitPropertyKey(field.name.name)}: ${schema}`;
        })
        .join(",\n");
      const dataType = `{ ${body.fields
        .map((field) => {
          const type = ctx.emitTypeNode(field.typeAnnotation);
          return `readonly ${emitPropertyKey(field.name.name)}: ${type}`;
        })
        .join("; ")} }`;
      return `${exp}const ${decl.id.name} = <${args}>(${values}) => {\n${checks}\n  return Schema.Struct({\n${fields}\n  });\n};\n${exp}type ${decl.id.name}<${parameters.join(", ")}> = ${dataType};`;
    } else {
      const members = body.members
        .map((member) => emitSchemaTypeField(ctx, member))
        .join(", ");
      const dataType = body.members
        .map((member) => ctx.emitTypeNode(member))
        .join(" | ");
      return `${exp}const ${decl.id.name} = <${args}>(${values}) => {\n${checks}\n  return Schema.Union([${members}]);\n};\n${exp}type ${decl.id.name}<${parameters.join(", ")}> = ${dataType};`;
    }
  });
}

function emitCheckedRecordDecoder(
  ctx: SchemaEmitterContext,
  decl: SchemaDeclaration,
  exp: string,
): string {
  if (decl.body.kind !== "RecordSchema" || decl.typeParams?.length) return "";
  const primitive = (type: TypeNode | undefined): boolean =>
    type?.kind === "TypeReferenceNode" &&
    !type.typeArgs?.length &&
    ["String", "Number", "Boolean"].includes(type.name.name) &&
    !ctx.declaredTypeNames.has(type.name.name);
  const codec = (type: TypeNode | undefined): type is TypeReferenceNode =>
    !!type &&
    type.kind === "TypeReferenceNode" &&
    ((!type.typeArgs?.length &&
      (primitive(type) ||
        ctx.identityRecordSchemas.has(type.name.name) ||
        ctx.checkedTaggedSchemas.has(type.name.name) ||
        ctx.options.importedIdentitySchemas?.has(type.name.name) === true)) ||
      (type.name.name === "Option" &&
        type.typeArgs?.length === 1 &&
        codec(type.typeArgs[0])));
  const fields = decl.body.fields;
  const hasEffect = fields.some(
    (field) =>
      field.typeAnnotation.kind === "FunctionTypeNode" &&
      field.typeAnnotation.returnType.kind === "EffectTypeNode",
  );
  if (!fields.some((field) => field.typeAnnotation.kind === "FunctionTypeNode"))
    return "";
  for (const field of fields) {
    if (field.defaultValue || field.name.name === "__proto__") return "";
    const type = field.typeAnnotation;
    if (type.kind === "FunctionTypeNode") {
      if (
        type.typeParams?.length ||
        type.params.some(
          (param) => param.isRest || !codec(param.typeAnnotation),
        )
      )
        return "";
      if (type.returnType.kind === "EffectTypeNode") {
        if (!codec(type.returnType.success)) return "";
      } else if (
        hasEffect ||
        !(
          primitive(type.returnType) ||
          (type.returnType.kind === "TypeReferenceNode" &&
            type.returnType.name.name === "Void" &&
            !type.returnType.typeArgs?.length &&
            !ctx.declaredTypeNames.has("Void"))
        )
      )
        return "";
    } else if (!codec(type)) return "";
  }
  const name = `${decl.id.name}DecodeChecked`;
  if (
    ctx.bindings.has(name) ||
    ctx.declaredTypeNames.has(name) ||
    ctx.userImportBindings.has(name)
  ) {
    return "";
  }
  if (hasEffect) {
    const checkedName = `${decl.id.name}Checked`;
    if (
      ctx.declaredTypeNames.has(checkedName) ||
      ctx.bindings.has(checkedName) ||
      ctx.userImportBindings.has(checkedName)
    )
      return "";
  }
  ctx.addEffectImport("Schema");
  ctx.needsCheckedRecordDecoder = true;
  const checkedCodec = (type: TypeNode): string => {
    if (type.kind === "TypeReferenceNode") {
      const tagged = ctx.checkedTaggedSchemas.get(type.name.name);
      if (tagged) {
        const checks = tagged.variants
          .map((variant) => {
            const clauses = [
              `($value as { readonly _tag?: unknown })._tag === ${JSON.stringify(variant.name.name)}`,
            ];
            for (const field of variant.fields) {
              const fieldType = (field.typeAnnotation as TypeReferenceNode).name
                .name;
              const access = `($value as { readonly [key: string]: unknown })[${JSON.stringify(field.name.name)}]`;
              if (
                ctx.identityRecordSchemas.has(fieldType) ||
                ctx.options.importedIdentitySchemas?.has(fieldType)
              ) {
                clauses.push(`Schema.is(${fieldType})(${access})`);
              } else {
                clauses.push(
                  `typeof ${access} === ${JSON.stringify(fieldType.toLowerCase())}`,
                );
              }
            }
            return `(${clauses.join(" && ")})`;
          })
          .join(" || ");
        return `Schema.declare(($value: unknown): $value is ${ctx.emitTypeNode(type)} => typeof $value === "object" && $value !== null && !globalThis.Array.isArray($value) && (${checks}))`;
      }
      if (ctx.options.importedIdentitySchemas?.has(type.name.name))
        return type.name.name;
    }
    return emitSchemaTypeField(ctx, type);
  };
  const data = fields
    .filter((field) => field.typeAnnotation.kind !== "FunctionTypeNode")
    .map((field) => {
      const optionInner = extractOptionInnerType(field.typeAnnotation);
      if (optionInner) {
        return `${emitPropertyKey(field.name.name)}: Schema.OptionFromOptionalNullOr(${checkedCodec(optionInner)}, { onNoneEncoding: "omit" })`;
      }
      return `${emitPropertyKey(field.name.name)}: ${checkedCodec(field.typeAnnotation)}`;
    })
    .join(", ");
  const callbacks = fields
    .filter((field) => field.typeAnnotation.kind === "FunctionTypeNode")
    .map((field) => {
      const type = field.typeAnnotation as FunctionTypeNode;
      const args = type.params
        .map((param) => checkedCodec(param.typeAnnotation!))
        .join(", ");
      if (type.returnType.kind === "EffectTypeNode") {
        ctx.checkedCallbackKinds.add("effect");
        const callbackType = `${decl.id.name}[${JSON.stringify(field.name.name)}]`;
        return `${emitPropertyKey(field.name.name)}: ($value: unknown) => $funscriptCheckedEffect($value as ${callbackType}, Schema.Tuple([${args}]), ${checkedCodec(type.returnType.success)})`;
      }
      if (
        type.returnType.kind === "TypeReferenceNode" &&
        type.returnType.name.name === "Void"
      ) {
        ctx.checkedCallbackKinds.add("void");
        return `${emitPropertyKey(field.name.name)}: ($value: unknown) => $funscriptCheckedSyncVoid($value, Schema.Tuple([${args}]), ${type.params.length})`;
      }
      ctx.checkedCallbackKinds.add("sync");
      return `${emitPropertyKey(field.name.name)}: ($value: unknown) => $funscriptCheckedSync($value, Schema.Tuple([${args}]), ${emitSchemaTypeField(ctx, type.returnType)})`;
    })
    .join(", ");
  if (hasEffect) {
    const callbackFields = fields.filter(
      (field) => field.typeAnnotation.kind === "FunctionTypeNode",
    );
    const keys = callbackFields
      .map((field) => JSON.stringify(field.name.name))
      .join(" | ");
    const checkedFields = callbackFields
      .map((field) => {
        const type = field.typeAnnotation as FunctionTypeNode;
        const output = type.returnType as EffectTypeNode;
        const params = type.params
          .map(
            (param) =>
              `${ctx.emitBindingTarget(param.name)}: ${ctx.emitTypeNode(param.typeAnnotation!)}`,
          )
          .join(", ");
        const error = output.error ? ctx.emitTypeNode(output.error) : "never";
        const requirements = output.requirements
          ? ctx.emitTypeNode(output.requirements)
          : "never";
        ctx.addEffectImport("Effect");
        return `${emitPropertyKey(field.name.name)}: (${params}) => Effect.Effect<${ctx.emitTypeNode(output.success)}, ${error} | $funscriptCallbackBoundaryError, ${requirements}>`;
      })
      .join("; ");
    const checkedName = `${decl.id.name}Checked`;
    return `\n${exp}type ${checkedName} = Omit<${decl.id.name}, ${keys}> & { ${checkedFields} };\n${exp}const ${name} = ($input: ${decl.id.name}): ${checkedName} => $funscriptDecodeCheckedRecord($input, Schema.Struct({ ${data} }), { ${callbacks} });`;
  }
  return `\n${exp}const ${name} = ($input: unknown): ${decl.id.name} => $funscriptDecodeCheckedRecord($input, Schema.Struct({ ${data} }), { ${callbacks} }, [] as const);`;
}

function extractOptionInnerType(typeNode: TypeNode): TypeNode | undefined {
  if (
    typeNode.kind === "TypeReferenceNode" &&
    typeNode.name.name === "Option" &&
    typeNode.typeArgs?.length === 1
  ) {
    return typeNode.typeArgs[0];
  }
  return undefined;
}

export function emitSchemaTypeField(
  ctx: SchemaEmitterContext,
  typeNode: TypeNode,
  rawRecordFields = false,
): string {
  if (
    typeNode.kind === "QualifiedTypeReferenceNode" ||
    typeNode.kind === "TypeQueryNode" ||
    typeNode.kind === "IndexedAccessTypeNode"
  ) {
    ctx.addEffectImport("Schema");
    return `(Schema.Unknown as unknown as Schema.Codec<${ctx.emitTypeNode(typeNode)}>)`;
  }
  if (typeNode.kind === "ParenthesizedTypeNode") {
    return emitSchemaTypeField(ctx, typeNode.typeNode, rawRecordFields);
  }
  ctx.addEffectImport("Schema");
  if (typeNode.kind === "LiteralTypeNode")
    return `Schema.Literal(${JSON.stringify(typeNode.value)})`;
  if (
    typeNode.kind === "FunctionTypeNode" ||
    typeNode.kind === "EffectTypeNode"
  ) {
    throw new FunScriptError(
      "Runtime schema fields cannot validate function or Effect types; use a separate type or an explicit schema",
      typeNode.span,
    );
  }
  if (typeNode.kind === "RecordTypeNode") {
    const inner = typeNode.fields
      .map((f) => {
        const fieldKey = emitPropertyKey(f.name.name);
        const optionInner = !f.defaultValue
          ? extractOptionInnerType(f.typeAnnotation)
          : undefined;
        if (optionInner) {
          const innerSchema = emitSchemaTypeField(
            ctx,
            optionInner,
            rawRecordFields,
          );
          return `  ${fieldKey}: Schema.OptionFromOptionalNullOr(${innerSchema}, { onNoneEncoding: "omit" })`;
        }
        const schema = emitSchemaTypeField(
          ctx,
          f.typeAnnotation,
          rawRecordFields,
        );
        if (f.defaultValue) {
          ctx.addEffectImport("Effect");
          return `  ${fieldKey}: ${schema}.pipe(Schema.withDecodingDefaultType(Effect.sync(() => ${ctx.emitExpression(f.defaultValue)})))`;
        }
        return `  ${fieldKey}: ${schema}`;
      })
      .join(",\n");
    return `Schema.Struct({\n${inner}\n})`;
  }
  if (typeNode.kind === "ArrayTypeNode") {
    return `Schema.Array(${emitSchemaTypeField(ctx, typeNode.elementType, rawRecordFields)})`;
  }
  if (typeNode.kind === "UnionTypeNode") {
    return `Schema.Union([${typeNode.types.map((type) => emitSchemaTypeField(ctx, type, rawRecordFields)).join(", ")}])`;
  }
  if (typeNode.kind === "TypeReferenceNode") {
    const tName = typeNode.name.name;
    if (ctx.activeSchemaParameters?.has(tName)) return tName;
    if (tName === "SchemaInput" && !ctx.declaredTypeNames.has(tName)) {
      throw new Error(
        "SchemaInput is a static input type, not a runtime schema; use the schema itself for validation",
      );
    }
    if (PRIMITIVE_TYPES[tName] || tName === "Duration")
      return `Schema.${tName}`;
    if (tName === "UUID") return "Schema.UUID";
    if (tName === "Int") return "Schema.Int";
    if (tName === "Option" && typeNode.typeArgs) {
      return `Schema.Option(${emitSchemaTypeField(ctx, typeNode.typeArgs[0])})`;
    }
    if (tName === "JSOptional" && typeNode.typeArgs?.length === 1) {
      return `Schema.NullishOr(${emitSchemaTypeField(ctx, typeNode.typeArgs[0])})`;
    }
    if (tName === "Array" && typeNode.typeArgs?.length === 1) {
      return `Schema.Array(${emitSchemaTypeField(ctx, typeNode.typeArgs[0])})`;
    }
    if (tName === "Record" && typeNode.typeArgs?.length === 2) {
      return `Schema.Record(${emitSchemaTypeField(ctx, typeNode.typeArgs[0])}, ${emitSchemaTypeField(ctx, typeNode.typeArgs[1])})`;
    }
    const genericArity =
      ctx.genericDataSchemas.get(tName) ??
      ctx.options.importedGenericDataSchemas?.get(tName);
    if (genericArity !== undefined) {
      if (typeNode.typeArgs?.length !== genericArity)
        throw new FunScriptError(
          `Generic data schema '${tName}' requires ${genericArity} schema argument(s).`,
          typeNode.span,
        );
      return `${tName}(${typeNode.typeArgs.map((arg) => emitGenericSchemaArgument(ctx, arg, ctx.options.importedGenericDataSchemas?.has(tName) === true)).join(", ")})`;
    }
    if (ctx.runtimeSchemaNames.has(tName)) return tName;
    if (ctx.options.importedSchemas?.has(tName))
      return ctx.options.importedSchemas.get(tName)!;
    if (ctx.userImportBindings.has(tName)) {
      if (typeNode.typeArgs?.length)
        throw new FunScriptError(
          `Cannot derive a runtime schema for imported generic '${tName}' here. Instantiate its schema factory explicitly.`,
          typeNode.span,
        );
      return tName;
    }
    if (ctx.recordContracts.has(tName)) {
      const contract = ctx.recordContracts.get(tName)!;
      return emitSchemaTypeField(ctx, contract, rawRecordFields);
    }
    if (typeNode.typeArgs?.length)
      throw new FunScriptError(
        `Cannot derive a runtime schema for generic '${tName}' here. Provide a concrete runtime schema explicitly.`,
        typeNode.span,
      );
    return `(Schema.Unknown as unknown as Schema.Codec<${ctx.emitTypeNode(typeNode)}>)`;
  }
  return ctx.emitTypeNode(typeNode);
}

function emitGenericSchemaArgument(
  ctx: SchemaEmitterContext,
  type: TypeNode,
  verifyImports = false,
): string {
  if (type.kind === "ParenthesizedTypeNode")
    return emitGenericSchemaArgument(ctx, type.typeNode, verifyImports);
  if (type.kind === "LiteralTypeNode")
    return `Schema.Literal(${JSON.stringify(type.value)})`;
  if (type.kind === "RecordTypeNode" || type.kind === "UnionTypeNode") {
    return emitSchemaTypeField(ctx, type);
  }
  if (type.kind === "TypeReferenceNode") {
    const name = type.name.name;
    if (ctx.activeSchemaParameters?.has(name) && !type.typeArgs?.length)
      return name;
    if (
      ["String", "Number", "Boolean"].includes(name) &&
      !type.typeArgs?.length &&
      !ctx.declaredTypeNames.has(name)
    )
      return emitSchemaTypeField(ctx, type);
    if (name === "Option" && type.typeArgs?.length === 1)
      return `Schema.Option(${emitGenericSchemaArgument(ctx, type.typeArgs[0], verifyImports)})`;
    if (name === "Array" && type.typeArgs?.length === 1)
      return `Schema.Array(${emitGenericSchemaArgument(ctx, type.typeArgs[0], verifyImports)})`;
    if (name === "Record" && type.typeArgs?.length === 2)
      return `Schema.Record(${emitGenericSchemaArgument(ctx, type.typeArgs[0], verifyImports)}, ${emitGenericSchemaArgument(ctx, type.typeArgs[1], verifyImports)})`;
    const arity =
      ctx.genericDataSchemas.get(name) ??
      ctx.options.importedGenericDataSchemas?.get(name);
    if (arity !== undefined && type.typeArgs?.length === arity)
      return `${name}(${type.typeArgs.map((arg) => emitGenericSchemaArgument(ctx, arg, verifyImports || ctx.options.importedGenericDataSchemas?.has(name) === true)).join(", ")})`;
    if (
      !type.typeArgs?.length &&
      (ctx.runtimeSchemaNames.has(name) ||
        ctx.recordContracts.has(name) ||
        (ctx.userImportBindings.has(name) &&
          (!verifyImports || ctx.options.importedDataSchemas?.has(name))))
    )
      return emitSchemaTypeField(ctx, type);
  }
  throw new FunScriptError(
    "Generic data schema arguments must name a runtime data schema or supported primitive; compile-time contracts and unknown types cannot validate data.",
    type.span,
  );
}
