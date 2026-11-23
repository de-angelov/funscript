import type {
  BindingTarget,
  Expression,
  Pattern,
  TypeNode,
  TypeParameter,
} from "../ast/types.js";
import { FunScriptError } from "../errors.js";

export const PRIMITIVE_TYPES: Readonly<Record<string, string>> = {
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

export const EFFECT_TYPE_MODULES = new Set([
  "Option",
  "Duration",
  "Result",
  "Effect",
  "Config",
  "Queue",
  "Ref",
  "Fiber",
  "Scope",
  "Stream",
  "Chunk",
  "HashMap",
  "HashSet",
  "Cause",
  "Exit",
  "Brand",
]);

export function emitPropertyKey(name: string): string {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

export interface TypeEmitterContext {
  emitExpression(expr: Expression): string;
  emitBindingTarget(target: BindingTarget | Pattern): string;
  emitTypeNode(node: TypeNode): string;
  emitTypeParameters(
    typeParams?: TypeParameter[],
    forArrowExpression?: boolean,
  ): string;
  declaredTypeNames: Set<string>;
  recordContracts: { has(name: string): boolean };
  isUserBinding(name: string): boolean;
  options: {
    isJsx?: boolean;
  };
  addEffectImport(name: string): void;
}

export function emitTypeParameters(
  ctx: TypeEmitterContext,
  typeParams: TypeParameter[] | undefined,
  forArrowExpression = false,
): string {
  if (!typeParams || typeParams.length === 0) return "";
  const params = typeParams.map((param) =>
    param.constraint
      ? `${param.name.name} extends ${ctx.emitTypeNode(param.constraint)}`
      : param.name.name,
  );
  const needsTsxComma =
    forArrowExpression &&
    (ctx.options.isJsx || typeParams.length === 1) &&
    typeParams.every((param) => !param.constraint);
  return `<${params.join(", ")}${needsTsxComma ? "," : ""}>`;
}

export function emitTypeNode(ctx: TypeEmitterContext, node: TypeNode): string {
  switch (node.kind) {
    case "QualifiedTypeReferenceNode": {
      const name = node.parts.map((part) => part.name).join(".");
      return node.typeArgs?.length
        ? `${name}<${node.typeArgs.map((arg) => ctx.emitTypeNode(arg)).join(", ")}>`
        : name;
    }
    case "TypeReferenceNode": {
      let name = node.name.name;
      if (name === "SchemaInput" && !ctx.declaredTypeNames.has(name)) {
        const arg = node.typeArgs?.[0];
        if (
          node.typeArgs?.length !== 1 ||
          arg?.kind !== "TypeReferenceNode" ||
          arg.typeArgs?.length
        ) {
          throw new Error(
            "SchemaInput requires one named schema, for example SchemaInput<User>",
          );
        }
        if (ctx.recordContracts.has(arg.name.name)) {
          throw new FunScriptError(
            `${arg.name.name} is a compile-time record contract and has no encoded schema input type. Use the contract type directly or validate data with a separate runtime schema.`,
            node.span,
          );
        }
        return `typeof ${arg.name.name}.Encoded`;
      }
      if (name === "HtmlProps") {
        const tag = node.typeArgs?.[0]
          ? ctx.emitTypeNode(node.typeArgs[0])
          : '"div"';
        return `React.ComponentPropsWithoutRef<${tag}>`;
      }
      if (PRIMITIVE_TYPES[name]) return PRIMITIVE_TYPES[name];
      if (name === "Array" && !ctx.declaredTypeNames.has(name))
        name = "ReadonlyArray";
      else if (name === "Map" && !ctx.declaredTypeNames.has(name))
        name = "ReadonlyMap";
      else if (name === "Set" && !ctx.declaredTypeNames.has(name))
        name = "ReadonlySet";
      else if (name === "Record" && !ctx.declaredTypeNames.has(name)) {
        if (!ctx.isUserBinding(name)) ctx.addEffectImport("Record");
        name = "Record.ReadonlyRecord";
      } else if (
        EFFECT_TYPE_MODULES.has(name) &&
        !ctx.declaredTypeNames.has(name)
      ) {
        if (!ctx.isUserBinding(name)) ctx.addEffectImport(name);
        name = `${name}.${name}`;
      }
      if (node.typeArgs && node.typeArgs.length > 0) {
        return `${name}<${node.typeArgs.map((t) => ctx.emitTypeNode(t)).join(", ")}>`;
      }
      return name;
    }
    case "FunctionTypeNode": {
      const params = node.params
        .map((p) => {
          const rest = p.isRest ? "..." : "";
          const name = p.name ? ctx.emitBindingTarget(p.name) : "_";
          const opt = p.optional ? "?" : "";
          return p.typeAnnotation
            ? `${rest}${name}${opt}: ${ctx.emitTypeNode(p.typeAnnotation)}`
            : `${rest}${name}${opt}`;
        })
        .join(", ");
      return `${ctx.emitTypeParameters(node.typeParams)}(${params}) => ${ctx.emitTypeNode(node.returnType)}`;
    }
    case "EffectTypeNode": {
      ctx.addEffectImport("Effect");
      const succ = ctx.emitTypeNode(node.success);
      const err = node.error ? ctx.emitTypeNode(node.error) : "never";
      const req = node.requirements
        ? ctx.emitTypeNode(node.requirements)
        : "never";
      return `Effect.Effect<${succ}, ${err}, ${req}>`;
    }
    case "RecordTypeNode": {
      const fields = node.fields
        .map(
          (f) =>
            `readonly ${emitPropertyKey(f.name.name)}${f.optional || f.defaultValue ? "?" : ""}: ${ctx.emitTypeNode(f.typeAnnotation)}`,
        )
        .join("; ");
      return `{ ${fields} }`;
    }
    case "ArrayTypeNode":
      return `ReadonlyArray<${ctx.emitTypeNode(node.elementType)}>`;
    case "UnionTypeNode":
      return node.types.map((t) => ctx.emitTypeNode(t)).join(" | ");
    case "IntersectionTypeNode":
      return node.types.map((t) => ctx.emitTypeNode(t)).join(" & ");
    case "LiteralTypeNode":
      return JSON.stringify(node.value);
    case "TypeQueryNode":
      return `typeof ${ctx.emitExpression(node.expr)}`;
    case "IndexedAccessTypeNode":
      return `${ctx.emitTypeNode(node.objectType)}[${ctx.emitTypeNode(node.indexType)}]`;
    case "ParenthesizedTypeNode":
      return `(${ctx.emitTypeNode(node.typeNode)})`;
    case "TsEscapeTypeNode":
      return node.code;
  }
}
