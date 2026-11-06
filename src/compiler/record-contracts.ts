import type { RecordSchema, RecordTypeNode, TypeNode } from "../ast/types.js";

export const RECORD_CONTRACT_BRAND = "$funscriptRecordContract";

/** A record containing callable or Effect types is a static contract, not a codec. */
export function isRecordContract(schema: RecordSchema): boolean {
  const isStatic = (type: TypeNode): boolean => {
    if (type.kind === "FunctionTypeNode" || type.kind === "EffectTypeNode") return true;
    if (type.kind === "RecordTypeNode") return type.fields.some((field) => isStatic(field.typeAnnotation));
    if (type.kind === "ArrayTypeNode") return isStatic(type.elementType);
    if (type.kind === "UnionTypeNode") return type.types.some(isStatic);
    if (type.kind === "TypeReferenceNode") return type.typeArgs?.some(isStatic) ?? false;
    return false;
  };
  return schema.fields.some((field) => isStatic(field.typeAnnotation));
}

export function recordContractType(schema: RecordSchema): RecordTypeNode {
  return {
    kind: "RecordTypeNode",
    fields: schema.fields.map((field) => ({
      kind: "RecordTypeField", name: field.name, typeAnnotation: field.typeAnnotation,
      optional: field.optional, defaultValue: field.defaultValue, span: field.span,
    })),
    span: schema.span,
  };
}
