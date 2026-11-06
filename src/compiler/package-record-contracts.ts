import ts from "typescript";
import type { Program, RecordTypeNode, Span, TypeNode } from "../ast/types.js";
import { renderImport } from "../emitter/imports.js";
import { FunScriptError } from "../errors.js";
import { RECORD_CONTRACT_BRAND } from "./record-contracts.js";
import { TypeScriptCompilationContext } from "./typescript-context.js";

/** Recover branded contracts from TypeScript declarations without changing JS props. */
export function resolvePackageRecordContracts(ast: Program, context: TypeScriptCompilationContext, known: ReadonlyMap<string, RecordTypeNode>): Map<string, RecordTypeNode> {
  const candidates = new Map<string, Span>();
  const usedTypes = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as Record<string, any>;
    if (node.kind === "TypeReferenceNode") usedTypes.add(node.name.name);
    for (const [key, child] of Object.entries(node)) if (key !== "span") visit(child);
  };
  visit(ast);
  const imports: string[] = [];
  for (const item of ast.body) {
    if (item.kind !== "ImportDeclaration" || item.isSideEffect) continue;
    imports.push(renderImport(item));
    for (const spec of item.specifiers) if (usedTypes.has(spec.local.name) && !known.has(spec.local.name)) candidates.set(spec.local.name, spec.local.span);
    if (item.defaultBinding && usedTypes.has(item.defaultBinding.name) && !known.has(item.defaultBinding.name)) candidates.set(item.defaultBinding.name, item.defaultBinding.span);
  }
  if (!candidates.size) return new Map();
  const entries = [...candidates.entries()];
  const source = [...imports, ...entries.map(([name], index) => `type $funscriptContractProbe${index} = ${name};`)].join("\n");
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
    const brand = checker.getPropertiesOfType(type).find((property) => property.getName().includes(RECORD_CONTRACT_BRAND));
    if (!brand) continue;
    const hasNestedOptional = (value: ts.Type, seen: Set<ts.Type>): boolean => {
      value = checker.getNonNullableType(value);
      if (seen.has(value)) return false;
      const next = new Set(seen).add(value);
      if (value.isUnionOrIntersection()) return value.types.some((part) => hasNestedOptional(part, next));
      if (!(value.flags & ts.TypeFlags.Object)) return false;
      if (checker.isArrayType(value) || checker.isTupleType(value)) return checker.getTypeArguments(value as ts.TypeReference).some((part) => hasNestedOptional(part, next));
      if (checker.getSignaturesOfType(value, ts.SignatureKind.Call).length) return false;
      return checker.getPropertiesOfType(value).some((property) => Boolean(property.flags & ts.SymbolFlags.Optional) || hasNestedOptional(checker.getTypeOfSymbolAtLocation(property, statement), next));
    };
    const shape = (value: ts.Type, seen: Set<ts.Type>, root = false): RecordTypeNode | undefined => {
      value = checker.getNonNullableType(value);
      if (seen.has(value) || (!(value.flags & ts.TypeFlags.Object) && !value.isIntersection()) || checker.isArrayType(value) || checker.isTupleType(value) || checker.getSignaturesOfType(value, ts.SignatureKind.Call).length) return undefined;
      const next = new Set(seen).add(value);
      const fields = checker.getPropertiesOfType(value).filter((property) => !property.getName().includes(RECORD_CONTRACT_BRAND)).map((property) => {
        const propertyType = checker.getTypeOfSymbolAtLocation(property, statement);
        const nonNullable = checker.getNonNullableType(propertyType);
        if (nonNullable.isUnion() && nonNullable.types.some((part) => hasNestedOptional(part, new Set()))) {
          throw new FunScriptError(`Optional records inside unions are not supported in imported contract ${name}`, span);
        }
        if ((checker.isArrayType(nonNullable) || checker.isTupleType(nonNullable)) && checker.getTypeArguments(nonNullable as ts.TypeReference).some((part) => hasNestedOptional(part, new Set()))) {
          throw new FunScriptError(`Optional records inside containers are not supported in imported contract ${name}`, span);
        }
        for (const signature of checker.getSignaturesOfType(nonNullable, ts.SignatureKind.Call)) {
          if (signature.parameters.some((parameter) => hasNestedOptional(checker.getTypeOfSymbolAtLocation(parameter, statement), new Set()))) {
            throw new FunScriptError(`Optional records inside callbacks are not supported in imported contract ${name}`, span);
          }
        }
        const nested = shape(propertyType, next);
        const leaf: TypeNode = { kind: "TypeReferenceNode", name: { kind: "UpperIdentifier", name: "Unknown", span }, span };
        return { kind: "RecordTypeField" as const, name: { kind: "Identifier" as const, name: property.getName(), span }, typeAnnotation: nested ?? leaf, optional: Boolean(property.flags & ts.SymbolFlags.Optional), span };
      });
      return root || fields.some((field) => field.optional || field.typeAnnotation.kind === "RecordTypeNode") ? { kind: "RecordTypeNode", fields, span } : undefined;
    };
    const record = shape(type, new Set(), true);
    if (!record) throw new FunScriptError(`Could not recover the optional fields of imported contract ${name}`, span);
    result.set(name, record);
  }
  return result;
}
