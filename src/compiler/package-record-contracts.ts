import ts from "typescript";
import type {
  Program,
  RecordTypeNode,
  Span,
  TypeNode,
  TypeReferenceNode,
} from "../ast/types.js";
import { walkAst } from "../ast/walk.js";
import { renderImport } from "../emitter/imports.js";
import {
  emitTypeNode,
  emitTypeParameters,
  type TypeEmitterContext,
} from "../emitter/types.js";
import { FunScriptError } from "../errors.js";
import { RECORD_CONTRACT_BRAND } from "./record-contracts.js";
import { type TypeScriptCompilationContext } from "./typescript-context.js";

/** Recover branded contracts from TypeScript declarations without changing JS props. */
export function resolvePackageRecordContracts(
  ast: Program,
  context: TypeScriptCompilationContext,
  known: ReadonlyMap<string, RecordTypeNode>,
): Map<string, RecordTypeNode> {
  const candidates = new Map<string, Span>();
  const usedTypeRefs = new Map<string, TypeReferenceNode>();
  walkAst(ast, (node) => {
    if (node.kind === "TypeReferenceNode") {
      const ref = node as unknown as TypeReferenceNode;
      if (!usedTypeRefs.has(ref.name.name) || ref.typeArgs?.length) {
        usedTypeRefs.set(ref.name.name, ref);
      }
    }
  });
  const imports: string[] = [];
  const importedLocals = new Set<string>();
  for (const item of ast.body) {
    if (item.kind !== "ImportDeclaration" || item.isSideEffect) continue;
    imports.push(renderImport(item));
    for (const spec of item.specifiers) {
      importedLocals.add(spec.local.name);
      if (usedTypeRefs.has(spec.local.name) && !known.has(spec.local.name))
        candidates.set(spec.local.name, spec.local.span);
    }
    if (item.defaultBinding) {
      importedLocals.add(item.defaultBinding.name);
      if (
        usedTypeRefs.has(item.defaultBinding.name) &&
        !known.has(item.defaultBinding.name)
      )
        candidates.set(item.defaultBinding.name, item.defaultBinding.span);
    }
    if (item.namespaceBinding) {
      importedLocals.add(item.namespaceBinding.name);
    }
  }
  if (!candidates.size) return new Map();
  const effectImports = new Set<string>();
  const typeCtx: TypeEmitterContext = {
    emitExpression: () => "unknown",
    emitBindingTarget: () => "_",
    emitTypeNode: (n) => emitTypeNode(typeCtx, n),
    emitTypeParameters: (tp, f) => emitTypeParameters(typeCtx, tp, f),
    declaredTypeNames: new Set(),
    recordContracts: { has: () => false },
    isUserBinding: (name) => importedLocals.has(name),
    options: {},
    addEffectImport: (name) => effectImports.add(name),
  };
  const entries = [...candidates.entries()];
  const probes = entries.map(([name], index) => {
    const ref = usedTypeRefs.get(name);
    const rhs = ref?.typeArgs?.length ? emitTypeNode(typeCtx, ref) : name;
    return `type $funscriptContractProbe${index} = ${rhs};`;
  });
  const effectImportLines =
    effectImports.size > 0
      ? [`import { ${[...effectImports].sort().join(", ")} } from "effect";`]
      : [];
  const source = [...effectImportLines, ...imports, ...probes].join("\n");
  const checked = context.check(source);
  if (!checked) return new Map();
  const { checker, sourceFile } = checked;
  const result = new Map<string, RecordTypeNode>();
  for (const statement of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(statement)) continue;
    const match = /^\$funscriptContractProbe(\d+)$/.exec(statement.name.text);
    if (!match) continue;
    const [name, span] = entries[Number(match[1])];
    const type = checker.getTypeAtLocation(statement.type);
    const brand = checker
      .getPropertiesOfType(type)
      .find((property) => property.getName().includes(RECORD_CONTRACT_BRAND));
    if (!brand) continue;
    const shape = (
      value: ts.Type,
      seen: Set<ts.Type>,
      root = false,
    ): RecordTypeNode | undefined => {
      value = checker.getNonNullableType(value);
      if (
        seen.has(value) ||
        (!(value.flags & ts.TypeFlags.Object) && !value.isIntersection()) ||
        checker.isArrayType(value) ||
        checker.isTupleType(value) ||
        checker.getSignaturesOfType(value, ts.SignatureKind.Call).length
      )
        return undefined;
      const next = new Set(seen).add(value);
      const fields = checker
        .getPropertiesOfType(value)
        .filter(
          (property) => !property.getName().includes(RECORD_CONTRACT_BRAND),
        )
        .map((property) => {
          const propertyType = checker.getTypeOfSymbolAtLocation(
            property,
            statement,
          );
          const nested = shape(propertyType, next);
          const leaf: TypeNode = {
            kind: "TypeReferenceNode",
            name: { kind: "UpperIdentifier", name: "Unknown", span },
            span,
          };
          return {
            kind: "RecordTypeField" as const,
            name: {
              kind: "Identifier" as const,
              name: property.getName(),
              span,
            },
            typeAnnotation: nested ?? leaf,
            optional: Boolean(property.flags & ts.SymbolFlags.Optional),
            span,
          };
        });
      return root ||
        fields.some(
          (field) =>
            field.optional || field.typeAnnotation.kind === "RecordTypeNode",
        )
        ? { kind: "RecordTypeNode", fields, span }
        : undefined;
    };
    const record = shape(type, new Set(), true);
    if (!record)
      throw new FunScriptError(
        `Could not recover the optional fields of imported contract ${name}`,
        span,
      );
    result.set(name, record);
  }
  return result;
}
