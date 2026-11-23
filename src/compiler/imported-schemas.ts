import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import ts from "typescript";
import {
  type Program,
  type SchemaDeclaration,
  type Span,
} from "../ast/types.js";
import { renderImport } from "../emitter/imports.js";
import { FunScriptError } from "../errors.js";
import { type TypeScriptCompilationContext } from "./typescript-context.js";

export class ImportedSchemaError extends FunScriptError {
  readonly _tag = "ImportedSchemaError";
  readonly code = "FS_IMPORTED_SCHEMA";
  readonly explanation =
    "FunScript could not derive a runtime schema from the TypeScript type without guessing its validation behavior.";
  readonly suggestedAction: string;
  related?: {
    file: string;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
  };

  constructor(
    message: string,
    span: Span,
    suggestedAction = "Use an explicit runtime schema for this boundary, or change the TypeScript type to supported data shapes.",
  ) {
    super(`${message} ${suggestedAction}`, span);
    this.suggestedAction = suggestedAction;
  }

  attachDeclaration(declaration: ts.Declaration | undefined): void {
    if (this.related || !declaration) return;
    try {
      const source = declaration.getSourceFile();
      if (!isAbsolute(source.fileName) || !existsSync(source.fileName)) return;
      const name = (declaration as ts.NamedDeclaration).name ?? declaration;
      const start = source.getLineAndCharacterOfPosition(name.getStart(source));
      const end = source.getLineAndCharacterOfPosition(name.getEnd());
      this.related = {
        file: source.fileName,
        line: start.line,
        column: start.character,
        endLine: end.line,
        endColumn: end.character,
      };
    } catch {
      // Synthetic TypeScript declarations may not have a source location.
    }
  }
}

function formatPath(path: string[]): string {
  return path.reduce(
    (result, part) =>
      result + (result && !part.startsWith("[") ? "." : "") + part,
    "",
  );
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

type Recursion = { root: ts.Type; referenced: boolean };

function convertUnionMembers(
  types: readonly ts.Type[],
  checker: ts.TypeChecker,
  contextNode: ts.Node,
  span: Span,
  path: string[],
  visited: Set<ts.Type>,
  recursion: Recursion,
): string {
  const hasNull = types.some((t) => Boolean(t.flags & ts.TypeFlags.Null));
  const hasUndefined = types.some((t) =>
    Boolean(t.flags & ts.TypeFlags.Undefined),
  );
  const nonNullish = types.filter(
    (t) => !(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)),
  );

  // Merge boolean literals into boolean
  const hasTrue = nonNullish.some(
    (t) =>
      Boolean(t.flags & ts.TypeFlags.BooleanLiteral) &&
      (t as ts.Type & { intrinsicName?: string }).intrinsicName === "true",
  );
  const hasFalse = nonNullish.some(
    (t) =>
      Boolean(t.flags & ts.TypeFlags.BooleanLiteral) &&
      (t as ts.Type & { intrinsicName?: string }).intrinsicName === "false",
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
    if (hasNull && hasUndefined)
      return "Schema.Union([Schema.Null, Schema.Undefined])";
    if (hasNull) return "Schema.Null";
    if (hasUndefined) return "Schema.Undefined";
    throw new ImportedSchemaError(
      `Empty union at '${formatPath(path)}'.`,
      span,
    );
  } else if (filteredNonNullish.length === 1) {
    inner = convertType(
      filteredNonNullish[0],
      checker,
      contextNode,
      span,
      path,
      visited,
      recursion,
    );
  } else {
    const parts = filteredNonNullish.map((t, i) =>
      convertType(
        t,
        checker,
        contextNode,
        span,
        [...path, `variant${i}`],
        visited,
        recursion,
      ),
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
  recursion: Recursion,
): string {
  if (visited.has(type)) {
    if (
      type === recursion.root &&
      Boolean(type.flags & ts.TypeFlags.Object) &&
      !checker.isArrayType(type) &&
      !checker.isTupleType(type)
    ) {
      recursion.referenced = true;
      return "Schema.suspend((): Schema.Codec<__FunScript_RecursiveType> => __FunScript_RecursiveSchema)";
    }
    const target =
      path.length > 0 ? formatPath(path) : checker.typeToString(type);
    throw new ImportedSchemaError(
      `Recursive type '${checker.typeToString(type)}' at '${target}' is not supported for schema derivation.`,
      span,
      "For a nested recursive record, derive that record as the schema root, or use an explicit recursive Effect schema.",
    );
  }

  // 1. Rejected types
  if (type.flags & ts.TypeFlags.Any) {
    const target = path.length > 1 ? ` in '${formatPath(path)}'` : "";
    throw new ImportedSchemaError(
      `Type 'any'${target} is not supported for schema derivation. FunScript does not allow silent widening to Schema.Unknown.`,
      span,
      "Replace 'any' with a concrete data type, or validate that field with an explicit runtime schema.",
    );
  }

  if (type.flags & ts.TypeFlags.Unknown) {
    const target = path.length > 1 ? ` in '${formatPath(path)}'` : "";
    throw new ImportedSchemaError(
      `Type 'unknown'${target} is not supported for schema derivation.`,
      span,
      "Specify the expected data shape, or validate that field with an explicit runtime schema.",
    );
  }

  if (
    type.getCallSignatures().length > 0 ||
    type.getConstructSignatures().length > 0
  ) {
    const target = path.length > 1 ? ` in '${formatPath(path)}'` : "";
    throw new ImportedSchemaError(
      `Function type${target} is not supported for schema derivation.`,
      span,
      "Separate callable contracts from data, and validate callback arguments and results at the boundary.",
    );
  }

  if (
    Boolean(type.symbol?.flags & ts.SymbolFlags.Class) ||
    Boolean((type as ts.Type & { isClass?: () => boolean }).isClass?.())
  ) {
    const name = type.symbol?.name || checker.typeToString(type);
    const target = path.length > 1 ? ` in '${formatPath(path)}'` : "";
    throw new ImportedSchemaError(
      `Class '${name}'${target} is not supported for schema derivation.`,
      span,
      "Define a plain data type for the boundary, or provide an explicit schema for this class.",
    );
  }

  if (type.symbol && UNSUPPORTED_BUILTINS.has(type.symbol.name)) {
    const target = path.length > 1 ? ` in '${formatPath(path)}'` : "";
    throw new ImportedSchemaError(
      `Type '${type.symbol.name}'${target} is not supported for schema derivation.`,
      span,
      "Provide an explicit runtime schema that defines how this value is validated or decoded.",
    );
  }

  if (type.flags & ts.TypeFlags.Never) {
    const target = path.length > 1 ? ` in '${formatPath(path)}'` : "";
    throw new ImportedSchemaError(
      `Type 'never'${target} is not supported for schema derivation.`,
      span,
    );
  }

  // 2. Primitives and literals
  if (type.flags & ts.TypeFlags.String) return "Schema.String";
  if (type.flags & ts.TypeFlags.Number) return "Schema.Number";
  if (type.flags & ts.TypeFlags.Boolean) return "Schema.Boolean";
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return `Schema.Literal(${
      (type as ts.Type & { intrinsicName?: string }).intrinsicName === "true"
        ? "true"
        : "false"
    })`;
  }
  if (type.flags & ts.TypeFlags.Null) return "Schema.Null";
  if (type.flags & ts.TypeFlags.Undefined) return "Schema.Undefined";
  if (type.isStringLiteral())
    return `Schema.Literal(${JSON.stringify(type.value)})`;
  if (type.isNumberLiteral()) return `Schema.Literal(${type.value})`;

  // 3. Tuples (must precede arrays: TypeScript models tuples as array references).
  if (checker.isTupleType(type)) {
    const reference = type as ts.TypeReference;
    const target = reference.target as ts.TupleType;
    const args = checker.getTypeArguments(reference);
    const flags = target.elementFlags;
    const restIndex = flags.findIndex((flag) =>
      Boolean(flag & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic)),
    );
    if (restIndex >= 0) {
      throw new ImportedSchemaError(
        `Tuple rest or variadic element at '${formatPath(path) || "root"}' is not supported for schema derivation.`,
        span,
      );
    }
    const nextVisited = new Set(visited).add(type);
    const elements = args.map((element, index) => {
      const elementPath = [...path, `[${index}]`];
      if (flags[index] & ts.ElementFlags.Optional) {
        const inner = element.isUnion()
          ? convertUnionMembers(
              element.types.filter(
                (member) => !(member.flags & ts.TypeFlags.Undefined),
              ),
              checker,
              contextNode,
              span,
              elementPath,
              nextVisited,
              recursion,
            )
          : convertType(
              element,
              checker,
              contextNode,
              span,
              elementPath,
              nextVisited,
              recursion,
            );
        return `Schema.optional(${inner})`;
      }
      return convertType(
        element,
        checker,
        contextNode,
        span,
        elementPath,
        nextVisited,
        recursion,
      );
    });
    return `Schema.Tuple([${elements.join(", ")}])`;
  }

  // 4. Arrays
  if (checker.isArrayType(type) || type.symbol?.name === "ReadonlyArray") {
    let elemType: ts.Type | undefined;
    if (checker.isArrayType(type)) {
      elemType = checker.getTypeArguments(type as ts.TypeReference)[0];
    } else {
      elemType = (checker.getTypeArguments(type as ts.TypeReference) ||
        (type as ts.Type & { typeArguments?: readonly ts.Type[] })
          .typeArguments)?.[0];
    }
    if (!elemType) {
      throw new ImportedSchemaError(
        `Could not determine element type for array '${formatPath(path)}'.`,
        span,
      );
    }
    const nextVisited = new Set(visited).add(type);
    const elemSchema = convertType(
      elemType,
      checker,
      contextNode,
      span,
      [...path, "[]"],
      nextVisited,
      recursion,
    );
    return `Schema.Array(${elemSchema})`;
  }

  // 5. Unions
  if (type.isUnion()) {
    const nextVisited = new Set(visited).add(type);
    return convertUnionMembers(
      type.types,
      checker,
      contextNode,
      span,
      path,
      nextVisited,
      recursion,
    );
  }

  // 6. Records with string index signatures
  const stringIndex = checker.getIndexInfoOfType(type, ts.IndexKind.String);
  if (stringIndex && type.getProperties().length === 0) {
    const nextVisited = new Set(visited).add(type);
    const valSchema = convertType(
      stringIndex.type,
      checker,
      contextNode,
      span,
      [...path, "[key: string]"],
      nextVisited,
      recursion,
    );
    return `Schema.Record(Schema.String, ${valSchema})`;
  }

  // 7. Structs / Object Types
  if (type.flags & ts.TypeFlags.Object) {
    const nextVisited = new Set(visited).add(type);
    const props = type.getProperties();
    if (props.length === 0) {
      return "Schema.Struct({})";
    }
    const fields: string[] = [];
    for (const p of props) {
      try {
        const pName = p.name;
        const isOptional = Boolean(p.flags & ts.SymbolFlags.Optional);
        const propType = checker.getTypeOfSymbolAtLocation(p, contextNode);
        if (propType.getCallSignatures().length > 0) {
          throw new ImportedSchemaError(
            `Method '${formatPath([...path, pName])}' is not supported for schema derivation.`,
            span,
            "Separate callable contracts from data, and validate callback arguments and results at the boundary.",
          );
        }
        const propPath = [...path, pName];
        const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(pName)
          ? pName
          : JSON.stringify(pName);
        if (isOptional) {
          let innerSchema: string;
          if (propType.isUnion()) {
            const nonUndef = propType.types.filter(
              (t) => !(t.flags & ts.TypeFlags.Undefined),
            );
            innerSchema = convertUnionMembers(
              nonUndef,
              checker,
              contextNode,
              span,
              propPath,
              nextVisited,
              recursion,
            );
          } else {
            innerSchema = convertType(
              propType,
              checker,
              contextNode,
              span,
              propPath,
              nextVisited,
              recursion,
            );
          }
          fields.push(`  ${key}: Schema.optional(${innerSchema})`);
        } else {
          const fieldSchema = convertType(
            propType,
            checker,
            contextNode,
            span,
            propPath,
            nextVisited,
            recursion,
          );
          fields.push(`  ${key}: ${fieldSchema}`);
        }
      } catch (error) {
        if (error instanceof ImportedSchemaError)
          error.attachDeclaration(p.valueDeclaration ?? p.declarations?.[0]);
        throw error;
      }
    }
    return `Schema.Struct({\n${fields.join(",\n")}\n})`;
  }

  throw new ImportedSchemaError(
    `Unsupported type '${checker.typeToString(type)}' at '${formatPath(path) || "root"}' for schema derivation.`,
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
      if (
        item.isTs &&
        item.body.kind === "TsDerivedSchema" &&
        item.body.targetType.kind === "TypeReferenceNode"
      ) {
        tsSchemas.push({ decl: item, rhsName: item.body.targetType.name.name });
      } else if (
        item.body.kind === "ImportedTsSchema" &&
        item.body.typeNode.kind === "TypeReferenceNode"
      ) {
        tsSchemas.push({
          decl: item,
          rhsName: item.body.typeNode.name.name,
        });
      }
    } else if (
      item.kind === "ExportDeclaration" &&
      item.declaration.kind === "SchemaDeclaration"
    ) {
      const decl = item.declaration;
      if (
        decl.isTs &&
        decl.body.kind === "TsDerivedSchema" &&
        decl.body.targetType.kind === "TypeReferenceNode"
      ) {
        tsSchemas.push({ decl, rhsName: decl.body.targetType.name.name });
      } else if (
        decl.body.kind === "ImportedTsSchema" &&
        decl.body.typeNode.kind === "TypeReferenceNode"
      ) {
        tsSchemas.push({
          decl,
          rhsName: decl.body.typeNode.name.name,
        });
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
      let importSource = item.source.raw.slice(1, -1);
      if (
        importSource.startsWith(".") &&
        !/\.[a-zA-Z0-9]+$/.test(importSource)
      ) {
        importSource = `${importSource}.js`;
      }
      lines.push(renderImport(item, JSON.stringify(importSource)));
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
      const message =
        typeof d.messageText === "string"
          ? d.messageText
          : d.messageText.messageText;
      for (let i = 0; i < tsSchemas.length; i++) {
        const probeName = `__FunScript_Probe_${i}`;
        if (d.start !== undefined) {
          const diagSlice = probeCode.slice(d.start, d.start + (d.length || 0));
          if (
            diagSlice.includes(probeName) ||
            diagSlice.includes(tsSchemas[i].rhsName)
          ) {
            throw new ImportedSchemaError(
              `Cannot resolve type '${tsSchemas[i].rhsName}': ${message}`,
              tsSchemas[i].decl.span,
              "Check the type name, its import path, and the source module's type exports.",
            );
          }
        }
      }
      throw new ImportedSchemaError(
        `Cannot resolve imported schema types: ${message}`,
        tsSchemas[0].decl.span,
        "Check the type name, its import path, and the source module's type exports.",
      );
    }
  }

  const probeNodes = new Map<string, ts.TypeAliasDeclaration>();
  ts.forEachChild(sourceFile, (node) => {
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text.startsWith("__FunScript_Probe_")
    ) {
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
    const recursion: Recursion = { root: type, referenced: false };
    const schemaExpr = convertType(
      type,
      checker,
      probeNode,
      entry.decl.span,
      [entry.rhsName],
      new Set(),
      recursion,
    );
    result.set(
      entry.decl.id.name,
      recursion.referenced
        ? `(() => {\n  type __FunScript_DeepReadonly<T> = T extends readonly unknown[] ? { readonly [K in keyof T]: __FunScript_DeepReadonly<T[K]> } : T extends object ? { readonly [K in keyof T]: __FunScript_DeepReadonly<T[K]> | ({} extends Pick<T, K> ? undefined : never) } : T;\n  type __FunScript_RecursiveType = __FunScript_DeepReadonly<${entry.rhsName}>;\n  const __FunScript_RecursiveSchema: Schema.Codec<__FunScript_RecursiveType> = ${schemaExpr};\n  return __FunScript_RecursiveSchema;\n})()`
        : schemaExpr,
    );
  });

  return result;
}
