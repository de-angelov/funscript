import ts from "typescript";
import { Program, SchemaDeclaration, Span } from "../ast/types.js";
import { TypeScriptCompilationContext } from "./typescript-context.js";
import { FunScriptError } from "../errors.js";

export class ImportedSchemaError extends FunScriptError {
  readonly _tag = "ImportedSchemaError";
}

const UNSUPPORTED_BUILTINS = new Set([
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

function convertUnionMembers(
  types: readonly ts.Type[],
  checker: ts.TypeChecker,
  contextNode: ts.Node,
  span: Span,
  path: string[],
  visited: Set<ts.Type>,
): string {
  const hasNull = types.some((t) => Boolean(t.flags & ts.TypeFlags.Null));
  const hasUndefined = types.some((t) => Boolean(t.flags & ts.TypeFlags.Undefined));
  const nonNullish = types.filter((t) => !(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));

  // Merge boolean literals into boolean
  const hasTrue = nonNullish.some(
    (t) => (t.flags & ts.TypeFlags.BooleanLiteral) && (t as any).intrinsicName === "true",
  );
  const hasFalse = nonNullish.some(
    (t) => (t.flags & ts.TypeFlags.BooleanLiteral) && (t as any).intrinsicName === "false",
  );
  let filteredNonNullish = nonNullish;
  if (hasTrue && hasFalse) {
    filteredNonNullish = [
      checker.getBooleanType(),
      ...nonNullish.filter((t) => !(t.flags & ts.TypeFlags.BooleanLiteral)),
    ];
  }

  let inner: string;
  if (filteredNonNullish.length === 0) {
    if (hasNull && hasUndefined) return "Schema.Union([Schema.Null, Schema.Undefined])";
    if (hasNull) return "Schema.Null";
    if (hasUndefined) return "Schema.Undefined";
    throw new ImportedSchemaError(`Empty union at '${path.join(".")}'.`, span);
  } else if (filteredNonNullish.length === 1) {
    inner = convertType(filteredNonNullish[0], checker, contextNode, span, path, visited);
  } else {
    const parts = filteredNonNullish.map((t, i) =>
      convertType(t, checker, contextNode, span, [...path, `variant${i}`], visited),
    );
    inner = `Schema.Union([${parts.join(", ")}])`;
  }

  if (hasNull && hasUndefined) return `Schema.NullishOr(${inner})`;
  if (hasNull) return `Schema.NullOr(${inner})`;
  if (hasUndefined) return `Schema.UndefinedOr(${inner})`;
  return inner;
}

function convertType(
  type: ts.Type,
  checker: ts.TypeChecker,
  contextNode: ts.Node,
  span: Span,
  path: string[] = [],
  visited: Set<ts.Type> = new Set(),
): string {
  if (visited.has(type)) {
    const target = path.length > 0 ? path.join(".") : checker.typeToString(type);
    throw new ImportedSchemaError(
      `Recursive type '${checker.typeToString(type)}' at '${target}' is not supported for schema derivation.`,
      span,
    );
  }

  // 1. Rejected types
  if (type.flags & ts.TypeFlags.Any) {
    const target = path.length > 1 ? ` in '${path.join(".")}'` : "";
    throw new ImportedSchemaError(
      `Type 'any'${target} is not supported for schema derivation. FunScript does not allow silent widening to Schema.Unknown.`,
      span,
    );
  }

  if (type.flags & ts.TypeFlags.Unknown) {
    const target = path.length > 1 ? ` in '${path.join(".")}'` : "";
    throw new ImportedSchemaError(
      `Type 'unknown'${target} is not supported for schema derivation.`,
      span,
    );
  }

  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
    const target = path.length > 1 ? ` in '${path.join(".")}'` : "";
    throw new ImportedSchemaError(
      `Function type${target} is not supported for schema derivation.`,
      span,
    );
  }

  if (Boolean(type.symbol?.flags & ts.SymbolFlags.Class) || (type as any).isClass?.()) {
    const name = type.symbol?.name || checker.typeToString(type);
    const target = path.length > 1 ? ` in '${path.join(".")}'` : "";
    throw new ImportedSchemaError(
      `Class '${name}'${target} is not supported for schema derivation.`,
      span,
    );
  }

  if (type.symbol && UNSUPPORTED_BUILTINS.has(type.symbol.name)) {
    const target = path.length > 1 ? ` in '${path.join(".")}'` : "";
    throw new ImportedSchemaError(
      `Type '${type.symbol.name}'${target} is not supported for schema derivation.`,
      span,
    );
  }

  if (type.flags & ts.TypeFlags.Never) {
    const target = path.length > 1 ? ` in '${path.join(".")}'` : "";
    throw new ImportedSchemaError(
      `Type 'never'${target} is not supported for schema derivation.`,
      span,
    );
  }

  // 2. Primitives and literals
  if (type.flags & ts.TypeFlags.String) return "Schema.String";
  if (type.flags & ts.TypeFlags.Number) return "Schema.Number";
  if ((type.flags & ts.TypeFlags.Boolean) || (type.flags & ts.TypeFlags.BooleanLiteral)) return "Schema.Boolean";
  if (type.flags & ts.TypeFlags.Null) return "Schema.Null";
  if (type.flags & ts.TypeFlags.Undefined) return "Schema.Undefined";
  if (type.isStringLiteral()) return `Schema.Literal(${JSON.stringify(type.value)})`;
  if (type.isNumberLiteral()) return `Schema.Literal(${type.value})`;

  // 3. Arrays
  if (checker.isArrayType(type) || type.symbol?.name === "ReadonlyArray") {
    let elemType: ts.Type | undefined;
    if (checker.isArrayType(type)) {
      elemType = checker.getTypeArguments(type as ts.TypeReference)[0];
    } else {
      elemType = (checker.getTypeArguments(type as any) || (type as any).typeArguments)?.[0];
    }
    if (!elemType) {
      throw new ImportedSchemaError(`Could not determine element type for array '${path.join(".")}'.`, span);
    }
    const nextVisited = new Set(visited).add(type);
    const elemSchema = convertType(elemType, checker, contextNode, span, [...path, "[]"], nextVisited);
    return `Schema.Array(${elemSchema})`;
  }

  // 4. Unions
  if (type.isUnion()) {
    const nextVisited = new Set(visited).add(type);
    return convertUnionMembers(type.types, checker, contextNode, span, path, nextVisited);
  }

  // 5. Records with string index signatures
  const stringIndex = checker.getIndexInfoOfType(type, ts.IndexKind.String);
  if (stringIndex && type.getProperties().length === 0) {
    const nextVisited = new Set(visited).add(type);
    const valSchema = convertType(stringIndex.type, checker, contextNode, span, [...path, "[key: string]"], nextVisited);
    return `Schema.Record(Schema.String, ${valSchema})`;
  }

  // 6. Structs / Object Types
  if (type.flags & ts.TypeFlags.Object) {
    const nextVisited = new Set(visited).add(type);
    const props = type.getProperties();
    if (props.length === 0) {
      return "Schema.Struct({})";
    }
    const fields: string[] = [];
    for (const p of props) {
      const pName = p.name;
      const isOptional = Boolean(p.flags & ts.SymbolFlags.Optional);
      const propType = checker.getTypeOfSymbolAtLocation(p, contextNode);
      if (propType.getCallSignatures().length > 0) {
        throw new ImportedSchemaError(
          `Method '${path.concat(pName).join(".")}' is not supported for schema derivation.`,
          span,
        );
      }
      const propPath = [...path, pName];
      const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(pName) ? pName : JSON.stringify(pName);
      if (isOptional) {
        let innerSchema: string;
        if (propType.isUnion()) {
          const nonUndef = propType.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined));
          innerSchema = convertUnionMembers(nonUndef, checker, contextNode, span, propPath, nextVisited);
        } else {
          innerSchema = convertType(propType, checker, contextNode, span, propPath, nextVisited);
        }
        fields.push(`  ${key}: Schema.optional(${innerSchema})`);
      } else {
        const fieldSchema = convertType(propType, checker, contextNode, span, propPath, nextVisited);
        fields.push(`  ${key}: ${fieldSchema}`);
      }
    }
    return `Schema.Struct({\n${fields.join(",\n")}\n})`;
  }

  throw new ImportedSchemaError(
    `Unsupported type '${checker.typeToString(type)}' at '${path.join(".") || "root"}' for schema derivation.`,
    span,
  );
}

export function resolveImportedSchemas(
  ast: Program,
  source: string,
  context: TypeScriptCompilationContext,
): ReadonlyMap<string, string> {
  const tsSchemas: Array<{ decl: SchemaDeclaration; rhsName: string }> = [];

  for (const item of ast.body) {
    if (item.kind === "SchemaDeclaration") {
      if (item.isTs && item.body.kind === "TsDerivedSchema" && item.body.targetType.kind === "TypeReferenceNode") {
        tsSchemas.push({ decl: item, rhsName: item.body.targetType.name.name });
      } else if (item.body.kind === "ImportedTsSchema" && (item.body as any).typeNode?.kind === "TypeReferenceNode") {
        tsSchemas.push({ decl: item, rhsName: (item.body as any).typeNode.name.name });
      }
    } else if (
      item.kind === "ExportDeclaration" &&
      item.declaration.kind === "SchemaDeclaration"
    ) {
      const decl = item.declaration;
      if (decl.isTs && decl.body.kind === "TsDerivedSchema" && decl.body.targetType.kind === "TypeReferenceNode") {
        tsSchemas.push({ decl, rhsName: decl.body.targetType.name.name });
      } else if (decl.body.kind === "ImportedTsSchema" && (decl.body as any).typeNode?.kind === "TypeReferenceNode") {
        tsSchemas.push({ decl, rhsName: (decl.body as any).typeNode.name.name });
      }
    }
  }

  if (tsSchemas.length === 0) {
    return new Map();
  }

  // Construct TypeScript probe source:
  const lines: string[] = [];

  for (const item of ast.body) {
    if (item.kind === "ImportDeclaration") {
      const specs = item.specifiers
        .map((s) => {
          const typePrefix = s.isTypeOnly ? "type " : "";
          if (s.imported.name === s.local.name) {
            return `${typePrefix}${s.imported.name}`;
          }
          return `${typePrefix}${s.imported.name} as ${s.local.name}`;
        })
        .join(", ");
      let importSource = item.source.raw.slice(1, -1);
      if (importSource.startsWith(".") && !/\.[a-zA-Z0-9]+$/.test(importSource)) {
        importSource = `${importSource}.js`;
      }
      lines.push(`import ${item.isTypeOnly ? "type " : ""}{ ${specs} } from ${JSON.stringify(importSource)};`);
    } else if (item.kind === "TsEscapeDeclaration") {
      lines.push(item.code);
    }
  }

  tsSchemas.forEach((entry, idx) => {
    lines.push(`type __FunScript_Probe_${idx} = ${entry.rhsName};`);
  });

  const probeCode = lines.join("\n");
  const checked = context.check(probeCode);
  if (!checked) {
    throw new ImportedSchemaError(
      "Failed to initialize TypeScript context for schema derivation.",
      tsSchemas[0].decl.span,
    );
  }

  const { sourceFile, checker, program } = checked;
  const diags = program.getSemanticDiagnostics(sourceFile);

  if (diags.length > 0) {
    for (const d of diags) {
      const message = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
      for (let i = 0; i < tsSchemas.length; i++) {
        const probeName = `__FunScript_Probe_${i}`;
        if (d.start !== undefined) {
          const diagSlice = probeCode.slice(d.start, d.start + (d.length || 0));
          if (diagSlice.includes(probeName) || diagSlice.includes(tsSchemas[i].rhsName)) {
            throw new ImportedSchemaError(
              `Cannot resolve type '${tsSchemas[i].rhsName}': ${message}`,
              tsSchemas[i].decl.span,
            );
          }
        }
      }
      throw new ImportedSchemaError(`Cannot resolve imported schema types: ${message}`, tsSchemas[0].decl.span);
    }
  }

  const probeNodes = new Map<string, ts.TypeAliasDeclaration>();
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text.startsWith("__FunScript_Probe_")) {
      probeNodes.set(node.name.text, node);
    }
  });

  const result = new Map<string, string>();

  tsSchemas.forEach((entry, idx) => {
    const probeNode = probeNodes.get(`__FunScript_Probe_${idx}`);
    if (!probeNode) {
      throw new ImportedSchemaError(
        `Internal error: probe node not found for '${entry.rhsName}'.`,
        entry.decl.span,
      );
    }
    const type = checker.getTypeFromTypeNode(probeNode.type);
    const schemaExpr = convertType(type, checker, probeNode, entry.decl.span, [entry.rhsName], new Set());
    result.set(entry.decl.id.name, schemaExpr);
  });

  return result;
}
