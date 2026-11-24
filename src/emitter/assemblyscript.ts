import ts from "typescript";
import type { AsDeclaration } from "../ast/types.js";
import { FunScriptError } from "../errors.js";

const cache = new Map<string, string>();
const prepared = new WeakMap<AsDeclaration, string>();

export const SCALAR_TYPES = new Set(["i32", "u32", "i64", "u64", "f32", "f64"]);
export const BOOLEAN_TYPES = new Set(["bool", "boolean"]);
export const BIGINT_SCALAR_TYPES = new Set(["i64", "u64"]);
export const TYPED_ARRAY_TYPES = new Set([
  "Float32Array",
  "Float64Array",
  "Int32Array",
  "Uint32Array",
  "Uint8Array",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint8ClampedArray",
  "BigInt64Array",
  "BigUint64Array",
  "Int64Array",
  "Uint64Array",
]);

export function parseArrayElementType(t: string): string | null {
  const trimmed = t.trim();
  if (trimmed.endsWith("[]")) return trimmed.slice(0, -2).trim();
  const match = /^Array<(.+)>$/.exec(trimmed);
  if (match) return match[1].trim();
  return null;
}

export function parseTupleElementTypeList(t: string): string[] | null {
  const trimmed = t.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return [];
  const elements: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "[" || c === "<" || c === "{" || c === "(") depth++;
    else if (c === "]" || c === ">" || c === "}" || c === ")") depth--;
    else if (c === "," && depth === 0) {
      elements.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  elements.push(inner.slice(start).trim());
  return elements;
}

export function tupleClassName(elements: string[]): string {
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_");
  return `__fs_tuple_${elements.length}_${elements.map(sanitize).join("_")}`;
}

export function transformKernelSource(code: string): {
  transformed: string;
  allTuples: Map<string, string[]>;
} {
  const source = ts.createSourceFile(
    "kernel.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
  );
  const replacements: { start: number; end: number; text: string }[] = [];
  const allTuples = new Map<string, string[]>();

  function recordTuple(elemTypes: string[]) {
    const name = tupleClassName(elemTypes);
    if (!allTuples.has(name)) {
      allTuples.set(name, elemTypes);
      for (const e of elemTypes) {
        const inner = parseTupleElementTypeList(e);
        if (inner) recordTuple(inner);
      }
    }
    return name;
  }

  const tupleVarTypes = new Map<string, string[]>();
  function preScan(node: ts.Node) {
    if (ts.isParameter(node) && node.type && ts.isTupleTypeNode(node.type)) {
      const elemTypes = node.type.elements.map((e) => e.getText(source).trim());
      tupleVarTypes.set(node.name.getText(source), elemTypes);
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.type &&
      ts.isTupleTypeNode(node.type)
    ) {
      const elemTypes = node.type.elements.map((e) => e.getText(source).trim());
      tupleVarTypes.set(node.name.getText(source), elemTypes);
    }
    ts.forEachChild(node, preScan);
  }
  preScan(source);

  function scan(node: ts.Node) {
    if (ts.isTupleTypeNode(node)) {
      const elemTypes = node.elements.map((e) => e.getText(source).trim());
      const clsName = recordTuple(elemTypes);
      replacements.push({
        start: node.getStart(source),
        end: node.getEnd(),
        text: clsName,
      });
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isNumericLiteral(node.argumentExpression)
    ) {
      const exprText = node.expression.getText(source);
      if (tupleVarTypes.has(exprText)) {
        const idx = node.argumentExpression.text;
        replacements.push({
          start: node.getStart(source),
          end: node.getEnd(),
          text: `${exprText}._${idx}`,
        });
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.type &&
      ts.isTupleTypeNode(node.type)
    ) {
      if (node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
        const elemTypes = node.type.elements.map((e) =>
          e.getText(source).trim(),
        );
        const clsName = recordTuple(elemTypes);
        replacements.push({
          start: node.initializer.getStart(source),
          end: node.initializer.getStart(source) + 1,
          text: `__fs_make_${clsName}(`,
        });
        replacements.push({
          start: node.initializer.getEnd() - 1,
          end: node.initializer.getEnd(),
          text: `)`,
        });
      }
    }
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      ts.isArrayLiteralExpression(node.expression)
    ) {
      let parent = node.parent;
      while (
        parent &&
        !ts.isFunctionDeclaration(parent) &&
        !ts.isArrowFunction(parent) &&
        !ts.isFunctionExpression(parent) &&
        !ts.isMethodDeclaration(parent)
      ) {
        parent = parent.parent;
      }
      if (parent && parent.type && ts.isTupleTypeNode(parent.type)) {
        const elemTypes = parent.type.elements.map((e) =>
          e.getText(source).trim(),
        );
        const clsName = recordTuple(elemTypes);
        replacements.push({
          start: node.expression.getStart(source),
          end: node.expression.getStart(source) + 1,
          text: `__fs_make_${clsName}(`,
        });
        replacements.push({
          start: node.expression.getEnd() - 1,
          end: node.expression.getEnd(),
          text: `)`,
        });
      }
    }
    if (
      ts.isArrowFunction(node) &&
      node.type &&
      ts.isTupleTypeNode(node.type) &&
      ts.isArrayLiteralExpression(node.body)
    ) {
      const elemTypes = node.type.elements.map((e) => e.getText(source).trim());
      const clsName = recordTuple(elemTypes);
      replacements.push({
        start: node.body.getStart(source),
        end: node.body.getStart(source) + 1,
        text: `__fs_make_${clsName}(`,
      });
      replacements.push({
        start: node.body.getEnd() - 1,
        end: node.body.getEnd(),
        text: `)`,
      });
    }
    ts.forEachChild(node, scan);
  }

  scan(source);

  replacements.sort((a, b) => b.start - a.start);
  let transformed = code;
  for (const r of replacements) {
    transformed =
      transformed.slice(0, r.start) + r.text + transformed.slice(r.end);
  }
  return { transformed, allTuples };
}

const toJsTypedArray = (t: string): string =>
  t === "Int64Array"
    ? "BigInt64Array"
    : t === "Uint64Array"
      ? "BigUint64Array"
      : t;

/** Compile a numeric, string, boolean, struct, tuple, or array kernel with SIMD enabled. */
export async function prepareAssemblyScript(
  decl: AsDeclaration,
): Promise<void> {
  const { transformed, allTuples } = transformKernelSource(decl.code);
  const source = ts.createSourceFile(
    "kernel.ts",
    decl.code,
    ts.ScriptTarget.Latest,
    true,
  );
  const signatures: { name: string; params: string[]; result: string }[] = [];
  const classes = new Map<
    string,
    { name: string; fields: { name: string; type: string }[] }
  >();

  for (const statement of source.statements) {
    if (ts.isClassDeclaration(statement) && statement.name) {
      const fields: { name: string; type: string }[] = [];
      for (const member of statement.members) {
        if (ts.isPropertyDeclaration(member) && member.name) {
          const fieldName = member.name.getText(source);
          const fieldType = member.type?.getText(source) ?? "";
          fields.push({ name: fieldName, type: fieldType });
        }
      }
      classes.set(statement.name.text, { name: statement.name.text, fields });
    }
  }

  const isValidFieldType = (t: string): boolean => {
    if (
      SCALAR_TYPES.has(t) ||
      BOOLEAN_TYPES.has(t) ||
      TYPED_ARRAY_TYPES.has(t) ||
      t === "string" ||
      classes.has(t)
    )
      return true;
    const elem = parseArrayElementType(t);
    if (elem) {
      return (
        SCALAR_TYPES.has(elem) ||
        BOOLEAN_TYPES.has(elem) ||
        elem === "string" ||
        classes.has(elem) ||
        (parseTupleElementTypeList(elem)?.every(isValidFieldType) ?? false)
      );
    }
    const tupleElems = parseTupleElementTypeList(t);
    if (tupleElems && tupleElems.length > 0) {
      return tupleElems.every(isValidFieldType);
    }
    return false;
  };

  const isValidParamType = (p: string) => isValidFieldType(p);
  const isValidReturnType = (r: string) => r === "void" || isValidFieldType(r);

  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isExportDeclaration(statement)
    ) {
      throw new FunScriptError(
        "AssemblyScript blocks cannot import or re-export modules",
        decl.span,
      );
    }
    if (ts.isClassDeclaration(statement)) {
      const cls = classes.get(statement.name?.text ?? "");
      if (cls) {
        for (const f of cls.fields) {
          if (!isValidFieldType(f.type)) {
            throw new FunScriptError(
              `AssemblyScript struct '${cls.name}' has unsupported field type '${f.type}'`,
              decl.span,
            );
          }
        }
      }
      continue;
    }
    if (
      !ts.canHaveModifiers(statement) ||
      !ts
        .getModifiers(statement)
        ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue;
    if (
      !ts.isFunctionDeclaration(statement) ||
      !statement.name ||
      statement.typeParameters?.length ||
      !statement.body
    ) {
      throw new FunScriptError(
        "AssemblyScript blocks may only export numeric functions or struct classes",
        decl.span,
      );
    }
    const result = statement.type?.getText(source) ?? "";
    const params = statement.parameters.map(
      (p) => p.type?.getText(source) ?? "",
    );
    if (
      !isValidReturnType(result) ||
      params.some((p) => !isValidParamType(p)) ||
      statement.parameters.some(
        (p) => p.dotDotDotToken || p.questionToken || p.initializer,
      )
    ) {
      throw new FunScriptError(
        "AssemblyScript exports require explicit i32, u32, f32, or f64, or TypedArray parameter and return types",
        decl.span,
      );
    }
    signatures.push({ name: statement.name.text, params, result });
  }
  if (!signatures.length)
    throw new FunScriptError(
      "AssemblyScript block must export at least one numeric function",
      decl.span,
    );
  let binary = cache.get(decl.code);
  if (!binary) {
    try {
      const asc: {
        compileString(
          source: string,
          options: object,
        ): Promise<{
          error: unknown;
          binary: Uint8Array | null;
          stderr: { toString(): string };
        }>;
      } = await import("assemblyscript/" + "asc");
      let compileSource =
        transformed +
        "\nclass BigInt64Array extends Int64Array {}\nclass BigUint64Array extends Uint64Array {}\nexport function __funscript_reset_heap(): void { __reset(); }\n";

      for (const [clsName, elemTypes] of allTuples) {
        const fieldsDef = elemTypes
          .map(
            (t, fi) =>
              `  _${fi}: ${BOOLEAN_TYPES.has(t) ? "bool" : parseTupleElementTypeList(t) ? tupleClassName(parseTupleElementTypeList(t)!) : t};`,
          )
          .join("\n");
        let opDef = "";
        const firstType = elemTypes[0];
        if (elemTypes.every((t) => t === firstType)) {
          const asElem = BOOLEAN_TYPES.has(firstType)
            ? "bool"
            : parseTupleElementTypeList(firstType)
              ? tupleClassName(parseTupleElementTypeList(firstType)!)
              : firstType;
          const branches = elemTypes
            .map((_, fi) => `if (index == ${fi}) return this._${fi};`)
            .join(" ");
          opDef = `\n  @operator("[]")\n  __get(index: i32): ${asElem} { ${branches} return this._0; }`;
        }
        compileSource += `class ${clsName} {\n${fieldsDef}${opDef}\n}\n`;

        const ctorParams = elemTypes
          .map(
            (t, fi) =>
              `_${fi}: ${BOOLEAN_TYPES.has(t) ? "bool" : parseTupleElementTypeList(t) ? tupleClassName(parseTupleElementTypeList(t)!) : t}`,
          )
          .join(", ");
        const ctorBody = elemTypes
          .map((_, fi) => `o._${fi} = _${fi};`)
          .join(" ");
        compileSource += `export function __fs_make_${clsName}(${ctorParams}): ${clsName} { const o = changetype<${clsName}>(__new(offsetof<${clsName}>(), idof<${clsName}>())); ${ctorBody} return o; }\n`;

        for (let fi = 0; fi < elemTypes.length; fi++) {
          const t = elemTypes[fi];
          const asType = BOOLEAN_TYPES.has(t)
            ? "bool"
            : parseTupleElementTypeList(t)
              ? tupleClassName(parseTupleElementTypeList(t)!)
              : t;
          compileSource += `export function __fs_get_${clsName}_${fi}(o: ${clsName}): ${asType} { return o._${fi}; }\n`;
        }
      }

      for (const cls of classes.values()) {
        for (const field of cls.fields) {
          const tupleElems = parseTupleElementTypeList(field.type);
          const asFieldType = BOOLEAN_TYPES.has(field.type)
            ? "bool"
            : tupleElems
              ? tupleClassName(tupleElems)
              : field.type;
          compileSource += `export function __fs_get_${cls.name}_${field.name}(obj: ${cls.name}): ${asFieldType} { return obj.${field.name}; }\n`;
        }
        const ctorParams = cls.fields
          .map((f) => {
            const tupleElems = parseTupleElementTypeList(f.type);
            const asType = BOOLEAN_TYPES.has(f.type)
              ? "bool"
              : tupleElems
                ? tupleClassName(tupleElems)
                : f.type;
            return `${f.name}: ${asType}`;
          })
          .join(", ");
        const ctorBody = cls.fields
          .map((f) => `o.${f.name} = ${f.name};`)
          .join(" ");
        compileSource += `export function __fs_make_${cls.name}(${ctorParams}): ${cls.name} { const o = changetype<${cls.name}>(__new(offsetof<${cls.name}>(), idof<${cls.name}>())); ${ctorBody} return o; }\n`;
      }

      const arrayElemTypes = new Set<string>();
      const registerArray = (t: string) => {
        const elem = parseArrayElementType(t);
        if (elem) arrayElemTypes.add(elem);
        const tupleElems = parseTupleElementTypeList(t);
        if (tupleElems) {
          for (const te of tupleElems) registerArray(te);
        }
      };
      for (const cls of classes.values()) {
        for (const f of cls.fields) registerArray(f.type);
      }
      for (const sig of signatures) {
        registerArray(sig.result);
        for (const p of sig.params) registerArray(p);
      }
      for (const [, elemTypes] of allTuples) {
        for (const t of elemTypes) registerArray(t);
      }

      for (const elem of arrayElemTypes) {
        const tupleElems = parseTupleElementTypeList(elem);
        const asElem = BOOLEAN_TYPES.has(elem)
          ? "bool"
          : tupleElems
            ? tupleClassName(tupleElems)
            : elem;
        const safeElem =
          elem === "boolean"
            ? "bool"
            : tupleElems
              ? tupleClassName(tupleElems)
              : elem;
        compileSource += `export function __fs_arr_len_${safeElem}(arr: ${asElem}[]): i32 { return arr.length; }\n`;
        compileSource += `export function __fs_arr_get_${safeElem}(arr: ${asElem}[], i: i32): ${asElem} { return arr[i]; }\n`;
        compileSource += `export function __fs_arr_make_${safeElem}(len: i32): ${asElem}[] { return new Array<${asElem}>(len); }\n`;
        compileSource += `export function __fs_arr_set_${safeElem}(arr: ${asElem}[], i: i32, val: ${asElem}): void { arr[i] = val; }\n`;
      }
      const result = await asc.compileString(compileSource, {
        optimizeLevel: 3,
        runtime: "stub",
        exportRuntime: true,
        enable: ["simd"],
      });
      if (result.error || !result.binary) {
        const detail = result.stderr.toString();
        const location = /(?:input|stdin)\.ts\((\d+),(\d+)\)/.exec(detail);
        if (location && decl.codeStart) {
          const line = Number(location[1]);
          const column = Number(location[2]);
          const lines = decl.code.split("\n");
          if (
            line >= 1 &&
            line <= lines.length &&
            column >= 1 &&
            column <= lines[line - 1].length + 1
          ) {
            const preceding = lines
              .slice(0, line - 1)
              .reduce((sum, part) => sum + part.length + 1, 0);
            const start = {
              offset: decl.codeStart.offset + preceding + column - 1,
              line: decl.codeStart.line + line - 1,
              column: line === 1 ? decl.codeStart.column + column - 1 : column,
            };
            throw new FunScriptError(
              `AssemblyScript compilation failed: ${detail}`,
              {
                start,
                end: {
                  ...start,
                  offset: start.offset + 1,
                  column: start.column + 1,
                },
              },
            );
          }
        }
        throw new Error(detail);
      }
      const wasm = (
        globalThis as unknown as { WebAssembly?: typeof WebAssembly }
      ).WebAssembly;
      if (!wasm) {
        throw new Error(
          "WebAssembly is not supported in the current environment",
        );
      }
      const imports: { module: string; name: string; kind: string }[] =
        wasm.Module.imports(new wasm.Module(result.binary));
      if (
        imports.some(
          (i) =>
            i.module !== "env" || i.name !== "abort" || i.kind !== "function",
        )
      )
        throw new Error("AssemblyScript kernel has unsupported imports");
      binary = Buffer.from(result.binary).toString("base64");
      if (cache.size >= 64) cache.delete(cache.keys().next().value!);
      cache.set(decl.code, binary);
    } catch (cause) {
      if (cause instanceof FunScriptError) throw cause;
      throw new FunScriptError(
        `AssemblyScript compilation failed: ${String(cause)}`,
        decl.span,
      );
    }
  }
  prepared.set(decl, binary);
}

export function emitAssemblyScript(decl: AsDeclaration): string {
  const binary = prepared.get(decl) ?? cache.get(decl.code);
  if (!binary)
    throw new FunScriptError(
      "AssemblyScript block has not been compiled",
      decl.span,
    );
  const source = ts.createSourceFile(
    "kernel.ts",
    decl.code,
    ts.ScriptTarget.Latest,
    true,
  );

  const classes = new Map<
    string,
    { name: string; fields: { name: string; type: string }[] }
  >();
  for (const statement of source.statements) {
    if (ts.isClassDeclaration(statement) && statement.name) {
      const fields: { name: string; type: string }[] = [];
      for (const member of statement.members) {
        if (ts.isPropertyDeclaration(member) && member.name) {
          const fieldName = member.name.getText(source);
          const fieldType = member.type?.getText(source) ?? "";
          fields.push({ name: fieldName, type: fieldType });
        }
      }
      classes.set(statement.name.text, { name: statement.name.text, fields });
    }
  }

  const signatures = source.statements
    .filter(ts.isFunctionDeclaration)
    .filter((s) =>
      ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
    )
    .map((s) => ({
      name: s.name!.text,
      params: s.parameters.map((p) => ({
        type: p.type?.getText(source) ?? "",
        name: p.name.getText(source),
      })),
      result: s.type?.getText(source) ?? "void",
    }));

  const prefix = `__funWasm${decl.span.start.offset}`;
  const lines = [
    `let ${prefix}Instance: Record<string, unknown> | undefined;`,
    `const ${prefix}Get = (): Record<string, unknown> => {`,
    `  if (${prefix}Instance !== undefined) return ${prefix}Instance;`,
    `  const bytes = Uint8Array.from(atob(${JSON.stringify(binary)}), c => c.charCodeAt(0));`,
    `  const runtime = (globalThis as unknown as { WebAssembly: { Module: new (bytes: Uint8Array) => object; Instance: new (module: object, imports: { env: { abort: () => never } }) => { exports: Record<string, unknown> } } }).WebAssembly;`,
    `  return ${prefix}Instance = new runtime.Instance(new runtime.Module(bytes), { env: { abort: () => { throw new Error("AssemblyScript abort"); } } }).exports;`,
    `};`,
    `class ${prefix}WasmHandle<T = unknown> {`,
    `  readonly _tag = "WasmHandle" as const;`,
    `  constructor(readonly ptr: number, readonly read: () => T) {}`,
    `};`,
    `const ${prefix}Alloc = (exports: Record<string, unknown>, arr: ArrayBufferView, Ctor: { new (buffer: ArrayBuffer, byteOffset: number, length: number): { set(source: any): void }; BYTES_PER_ELEMENT: number }): { viewPtr: number; bufPtr: number; arr: ArrayBufferView; Ctor: { new (buffer: ArrayBuffer, byteOffset: number, length: number): { set(source: any): void }; BYTES_PER_ELEMENT: number } } => {`,
    `  const byteLength = arr.byteLength;`,
    `  const newFn = exports.__new as (size: number, id: number) => number;`,
    `  const bufPtr = newFn(byteLength, 0);`,
    `  const viewPtr = newFn(12, 0);`,
    `  const mem = (exports.memory as { buffer: ArrayBuffer }).buffer;`,
    `  const mem32 = new Uint32Array(mem);`,
    `  mem32[viewPtr >> 2] = bufPtr;`,
    `  mem32[(viewPtr + 4) >> 2] = bufPtr;`,
    `  mem32[(viewPtr + 8) >> 2] = byteLength;`,
    `  new Ctor(mem, bufPtr, (arr as unknown as { length: number }).length).set(arr as any);`,
    `  return { viewPtr, bufPtr, arr, Ctor };`,
    `};`,
    `const ${prefix}Read = <T extends { slice(): T }>(exports: Record<string, unknown>, ptr: number, Ctor: { new (buffer: ArrayBuffer, byteOffset: number, length: number): T; BYTES_PER_ELEMENT: number }): T => {`,
    `  const mem = (exports.memory as { buffer: ArrayBuffer }).buffer;`,
    `  const mem32 = new Uint32Array(mem);`,
    `  const dataStart = mem32[(ptr + 4) >> 2];`,
    `  const byteLength = mem32[(ptr + 8) >> 2];`,
    `  const len = byteLength / Ctor.BYTES_PER_ELEMENT;`,
    `  return new Ctor(mem, dataStart, len).slice();`,
    `};`,
    `const ${prefix}Sync = (exports: Record<string, unknown>, handle: { viewPtr: number; bufPtr: number; arr: ArrayBufferView; Ctor: { new (buffer: ArrayBuffer, byteOffset: number, length: number): { set(source: any): void }; BYTES_PER_ELEMENT: number } }): void => {`,
    `  const mem = (exports.memory as { buffer: ArrayBuffer }).buffer;`,
    `  (handle.arr as unknown as { set(source: unknown): void }).set(new handle.Ctor(mem, handle.bufPtr, (handle.arr as unknown as { length: number }).length));`,
    `};`,
    `const ${prefix}AllocString = (exports: Record<string, unknown>, str: string): number => {`,
    `  const buf = new Uint16Array(str.length);`,
    `  for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i);`,
    `  const byteLength = buf.byteLength;`,
    `  const newFn = exports.__new as (size: number, id: number) => number;`,
    `  const ptr = newFn(byteLength, 2);`,
    `  const mem = (exports.memory as { buffer: ArrayBuffer }).buffer;`,
    `  new Uint8Array(mem, ptr, byteLength).set(new Uint8Array(buf.buffer));`,
    `  return ptr;`,
    `};`,
    `const ${prefix}ReadString = (exports: Record<string, unknown>, ptr: number): string => {`,
    `  if (!ptr) return "";`,
    `  const mem = (exports.memory as { buffer: ArrayBuffer }).buffer;`,
    `  const len = new Uint32Array(mem, ptr - 4, 1)[0];`,
    `  return new TextDecoder("utf-16le").decode(new Uint8Array(mem, ptr, len));`,
    `};`,
  ];

  const toTsType = (t: string): string => {
    if (t === "void") return "void";
    if (BOOLEAN_TYPES.has(t)) return "boolean";
    if (t === "string") return "string";
    if (TYPED_ARRAY_TYPES.has(t)) return toJsTypedArray(t);
    if (BIGINT_SCALAR_TYPES.has(t)) return "bigint";
    if (SCALAR_TYPES.has(t)) return "number";
    const elem = parseArrayElementType(t);
    if (elem) return `readonly ${toTsType(elem)}[]`;
    const tupleElems = parseTupleElementTypeList(t);
    if (tupleElems) return `readonly [${tupleElems.map(toTsType).join(", ")}]`;
    return t;
  };

  const isHandleEligible = (t: string): boolean =>
    TYPED_ARRAY_TYPES.has(t) ||
    classes.has(t) ||
    parseTupleElementTypeList(t) !== null ||
    parseArrayElementType(t) !== null;

  const toTsParamType = (t: string): string => {
    const base = toTsType(t);
    return isHandleEligible(t)
      ? `${base} | ${prefix}WasmHandle<${base}>`
      : base;
  };

  const { allTuples } = transformKernelSource(decl.code);
  const registerTuple = (t: string) => {
    const tupleElems = parseTupleElementTypeList(t);
    if (tupleElems) {
      const name = tupleClassName(tupleElems);
      if (!allTuples.has(name)) {
        allTuples.set(name, tupleElems);
        for (const te of tupleElems) registerTuple(te);
      }
    }
  };
  for (const cls of classes.values()) {
    for (const f of cls.fields) registerTuple(f.type);
  }
  for (const sig of signatures) {
    registerTuple(sig.result);
    for (const p of sig.params) registerTuple(p.type);
  }

  const arrayElemTypes = new Set<string>();
  const registerArray = (t: string) => {
    const elem = parseArrayElementType(t);
    if (elem) arrayElemTypes.add(elem);
    const tupleElems = parseTupleElementTypeList(t);
    if (tupleElems) {
      for (const te of tupleElems) registerArray(te);
    }
  };
  for (const cls of classes.values()) {
    for (const f of cls.fields) registerArray(f.type);
  }
  for (const sig of signatures) {
    registerArray(sig.result);
    for (const p of sig.params) registerArray(p.type);
  }
  for (const [, elemTypes] of allTuples) {
    for (const t of elemTypes) registerArray(t);
  }

  for (const [clsName, elemTypes] of allTuples) {
    lines.push(
      `function ${prefix}Read_${clsName}(exports: Record<string, unknown>, ptr: number): readonly [${elemTypes.map(toTsType).join(", ")}] {`,
      `  return [`,
      ...elemTypes.map((t, fi) => {
        const getter = `(exports.__fs_get_${clsName}_${fi} as (p: number) => any)(ptr)`;
        if (BOOLEAN_TYPES.has(t)) return `    Boolean(${getter}),`;
        if (t === "string")
          return `    ${prefix}ReadString(exports, ${getter}),`;
        if (TYPED_ARRAY_TYPES.has(t))
          return `    ${prefix}Read(exports, ${getter}, ${toJsTypedArray(t)}),`;
        if (classes.has(t))
          return `    ${prefix}Read_${t}(exports, ${getter}),`;
        const innerTuple = parseTupleElementTypeList(t);
        if (innerTuple)
          return `    ${prefix}Read_${tupleClassName(innerTuple)}(exports, ${getter}),`;
        const elem = parseArrayElementType(t);
        if (elem) {
          const tupleInner = parseTupleElementTypeList(elem);
          const safeElem =
            elem === "boolean"
              ? "bool"
              : tupleInner
                ? tupleClassName(tupleInner)
                : elem;
          return `    ${prefix}Read_Array_${safeElem}(exports, ${getter}),`;
        }
        if (t === "i64") return `    BigInt.asIntN(64, ${getter}),`;
        if (t === "u64") return `    BigInt.asUintN(64, ${getter}),`;
        if (t === "u32") return `    ((${getter}) >>> 0),`;
        return `    ${getter},`;
      }),
      `  ] as const;`,
      `}`,
      `function ${prefix}Alloc_${clsName}(exports: Record<string, unknown>, tup: readonly [${elemTypes.map(toTsType).join(", ")}]): number {`,
      ...elemTypes.map((t, fi) => {
        if (BOOLEAN_TYPES.has(t))
          return `  const __f${fi} = tup[${fi}] ? 1 : 0;`;
        if (t === "string")
          return `  const __f${fi} = ${prefix}AllocString(exports, tup[${fi}]);`;
        if (TYPED_ARRAY_TYPES.has(t))
          return `  const __h${fi} = ${prefix}Alloc(exports, tup[${fi}], ${toJsTypedArray(t)});\n  const __f${fi} = __h${fi}.viewPtr;`;
        if (classes.has(t))
          return `  const __f${fi} = ${prefix}Alloc_${t}(exports, tup[${fi}]);`;
        const innerTuple = parseTupleElementTypeList(t);
        if (innerTuple)
          return `  const __f${fi} = ${prefix}Alloc_${tupleClassName(innerTuple)}(exports, tup[${fi}]);`;
        const elem = parseArrayElementType(t);
        if (elem) {
          const tupleInner = parseTupleElementTypeList(elem);
          const safeElem =
            elem === "boolean"
              ? "bool"
              : tupleInner
                ? tupleClassName(tupleInner)
                : elem;
          return `  const __f${fi} = ${prefix}Alloc_Array_${safeElem}(exports, tup[${fi}]);`;
        }
        return `  const __f${fi} = tup[${fi}];`;
      }),
      `  return (exports.__fs_make_${clsName} as (...args: any[]) => number)(${elemTypes.map((_, fi) => `__f${fi}`).join(", ")});`,
      `}`,
    );
  }

  for (const elem of arrayElemTypes) {
    const tupleElems = parseTupleElementTypeList(elem);
    const safeElem =
      elem === "boolean"
        ? "bool"
        : tupleElems
          ? tupleClassName(tupleElems)
          : elem;
    const tsElem = toTsType(elem);
    const elemReadExpr = BOOLEAN_TYPES.has(elem)
      ? "Boolean(raw)"
      : elem === "string"
        ? `${prefix}ReadString(exports, raw)`
        : classes.has(elem)
          ? `${prefix}Read_${elem}(exports, raw)`
          : tupleElems
            ? `${prefix}Read_${tupleClassName(tupleElems)}(exports, raw)`
            : elem === "i64"
              ? "BigInt.asIntN(64, raw)"
              : elem === "u64"
                ? "BigInt.asUintN(64, raw)"
                : elem === "u32"
                  ? "(raw >>> 0)"
                  : "raw";

    const itemAllocExpr = BOOLEAN_TYPES.has(elem)
      ? ""
      : elem === "string"
        ? `const __v = ${prefix}AllocString(exports, item);`
        : classes.has(elem)
          ? `const __v = ${prefix}Alloc_${elem}(exports, item);`
          : tupleElems
            ? `const __v = ${prefix}Alloc_${tupleClassName(tupleElems)}(exports, item);`
            : "";
    const itemVal = BOOLEAN_TYPES.has(elem)
      ? "item ? 1 : 0"
      : elem === "string" || classes.has(elem) || tupleElems
        ? "__v"
        : elem === "u32"
          ? "(item >>> 0)"
          : "item";

    lines.push(
      `function ${prefix}Read_Array_${safeElem}(exports: Record<string, unknown>, ptr: number): ${tsElem}[] {`,
      `  if (!ptr) return [];`,
      `  const len = (exports.__fs_arr_len_${safeElem} as (p: number) => number)(ptr);`,
      `  const res: ${tsElem}[] = new Array(len);`,
      `  for (let i = 0; i < len; i++) {`,
      `    const raw = (exports.__fs_arr_get_${safeElem} as (p: number, i: number) => any)(ptr, i);`,
      `    res[i] = ${elemReadExpr};`,
      `  }`,
      `  return res;`,
      `}`,
      `function ${prefix}Alloc_Array_${safeElem}(exports: Record<string, unknown>, arr: readonly ${tsElem}[]): number {`,
      `  const len = arr.length;`,
      `  const arrPtr = (exports.__fs_arr_make_${safeElem} as (n: number) => number)(len);`,
      `  for (let i = 0; i < len; i++) {`,
      `    const item = arr[i];`,
      `    ${itemAllocExpr}`,
      `    (exports.__fs_arr_set_${safeElem} as (a: number, i: number, v: any) => void)(arrPtr, i, ${itemVal});`,
      `  }`,
      `  return arrPtr;`,
      `}`,
    );
  }

  for (const cls of classes.values()) {
    lines.push(
      `export type ${cls.name} = {`,
      ...cls.fields.map((f) => `  readonly ${f.name}: ${toTsType(f.type)};`),
      `};`,
      `function ${prefix}Read_${cls.name}(exports: Record<string, unknown>, ptr: number): ${cls.name} {`,
      `  return {`,
      ...cls.fields.map((f) => {
        const getter = `(exports.__fs_get_${cls.name}_${f.name} as (p: number) => any)(ptr)`;
        if (BOOLEAN_TYPES.has(f.type)) {
          return `    ${f.name}: Boolean(${getter}),`;
        }
        if (f.type === "string") {
          return `    ${f.name}: ${prefix}ReadString(exports, ${getter}),`;
        }
        if (TYPED_ARRAY_TYPES.has(f.type)) {
          return `    ${f.name}: ${prefix}Read(exports, ${getter}, ${toJsTypedArray(f.type)}),`;
        }
        if (classes.has(f.type)) {
          return `    ${f.name}: ${prefix}Read_${f.type}(exports, ${getter}),`;
        }
        const tupleElems = parseTupleElementTypeList(f.type);
        if (tupleElems) {
          return `    ${f.name}: ${prefix}Read_${tupleClassName(tupleElems)}(exports, ${getter}),`;
        }
        const elem = parseArrayElementType(f.type);
        if (elem) {
          const tupleInner = parseTupleElementTypeList(elem);
          const safeElem =
            elem === "boolean"
              ? "bool"
              : tupleInner
                ? tupleClassName(tupleInner)
                : elem;
          return `    ${f.name}: ${prefix}Read_Array_${safeElem}(exports, ${getter}),`;
        }
        if (f.type === "i64") {
          return `    ${f.name}: BigInt.asIntN(64, ${getter}),`;
        }
        if (f.type === "u64") {
          return `    ${f.name}: BigInt.asUintN(64, ${getter}),`;
        }
        if (f.type === "u32") {
          return `    ${f.name}: ((${getter}) >>> 0),`;
        }
        return `    ${f.name}: ${getter},`;
      }),
      `  };`,
      `}`,
      `function ${prefix}Alloc_${cls.name}(exports: Record<string, unknown>, obj: ${cls.name}): number {`,
      ...cls.fields.map((f, fi) => {
        if (BOOLEAN_TYPES.has(f.type)) {
          return `  const __f${fi} = obj.${f.name} ? 1 : 0;`;
        }
        if (f.type === "string") {
          return `  const __f${fi} = ${prefix}AllocString(exports, obj.${f.name});`;
        }
        if (TYPED_ARRAY_TYPES.has(f.type)) {
          return `  const __h${fi} = ${prefix}Alloc(exports, obj.${f.name}, ${toJsTypedArray(f.type)});\n  const __f${fi} = __h${fi}.viewPtr;`;
        }
        if (classes.has(f.type)) {
          return `  const __f${fi} = ${prefix}Alloc_${f.type}(exports, obj.${f.name});`;
        }
        const tupleElems = parseTupleElementTypeList(f.type);
        if (tupleElems) {
          return `  const __f${fi} = ${prefix}Alloc_${tupleClassName(tupleElems)}(exports, obj.${f.name});`;
        }
        const elem = parseArrayElementType(f.type);
        if (elem) {
          const tupleInner = parseTupleElementTypeList(elem);
          const safeElem =
            elem === "boolean"
              ? "bool"
              : tupleInner
                ? tupleClassName(tupleInner)
                : elem;
          return `  const __f${fi} = ${prefix}Alloc_Array_${safeElem}(exports, obj.${f.name});`;
        }
        return `  const __f${fi} = obj.${f.name};`;
      }),
      `  return (exports.__fs_make_${cls.name} as (...args: any[]) => number)(${cls.fields.map((_, fi) => `__f${fi}`).join(", ")});`,
      `}`,
    );
  }

  const generateValidation = (
    valExpr: string,
    type: string,
    fnName: string,
    paramName: string,
  ): string => {
    const handlePrefix = isHandleEligible(type)
      ? `if (typeof ${valExpr} === "object" && ${valExpr} !== null && (((${valExpr} as any)._tag === "WasmHandle") || (${valExpr} as any) instanceof ${prefix}WasmHandle)) {} else `
      : "";
    if (BOOLEAN_TYPES.has(type)) {
      return `if (typeof ${valExpr} !== "boolean") return Effect.fail({ _tag: "WasmInputError" as const, function: ${JSON.stringify(fnName)}, parameter: ${JSON.stringify(paramName)}, expected: "boolean", value: ${valExpr} });`;
    }
    if (TYPED_ARRAY_TYPES.has(type)) {
      const jsType = toJsTypedArray(type);
      return `${handlePrefix}if (!(${valExpr} instanceof ${jsType})) return Effect.fail({ _tag: "WasmInputError" as const, function: ${JSON.stringify(fnName)}, parameter: ${JSON.stringify(paramName)}, expected: ${JSON.stringify(jsType)}, value: ${valExpr} });`;
    }
    if (type === "string") {
      return `${handlePrefix}if (typeof ${valExpr} !== "string") return Effect.fail({ _tag: "WasmInputError" as const, function: ${JSON.stringify(fnName)}, parameter: ${JSON.stringify(paramName)}, expected: "string", value: ${valExpr} });`;
    }
    if (classes.has(type)) {
      return `${handlePrefix}if (typeof ${valExpr} !== "object" || ${valExpr} === null) return Effect.fail({ _tag: "WasmInputError" as const, function: ${JSON.stringify(fnName)}, parameter: ${JSON.stringify(paramName)}, expected: ${JSON.stringify(type)}, value: ${valExpr} });`;
    }
    const elem = parseArrayElementType(type);
    if (elem) {
      return `${handlePrefix}if (!Array.isArray(${valExpr})) return Effect.fail({ _tag: "WasmInputError" as const, function: ${JSON.stringify(fnName)}, parameter: ${JSON.stringify(paramName)}, expected: "Array", value: ${valExpr} });`;
    }
    const tupleElems = parseTupleElementTypeList(type);
    if (tupleElems) {
      const head = `${handlePrefix}if (!Array.isArray(${valExpr}) || ${valExpr}.length !== ${tupleElems.length}) return Effect.fail({ _tag: "WasmInputError" as const, function: ${JSON.stringify(fnName)}, parameter: ${JSON.stringify(paramName)}, expected: ${JSON.stringify(type)}, value: ${valExpr} });`;
      const checks = tupleElems
        .map((te, idx) =>
          generateValidation(
            `${valExpr}[${idx}]`,
            te,
            fnName,
            `${paramName}[${idx}]`,
          ),
        )
        .join(" ");
      return `${head} ${checks}`;
    }
    const invalid =
      type === "i64"
        ? `typeof ${valExpr} !== "bigint" || ${valExpr} < -9223372036854775808n || ${valExpr} > 9223372036854775807n`
        : type === "u64"
          ? `typeof ${valExpr} !== "bigint" || ${valExpr} < 0n || ${valExpr} > 18446744073709551615n`
          : type === "i32"
            ? `!Number.isInteger(${valExpr}) || ${valExpr} < -2147483648 || ${valExpr} > 2147483647`
            : type === "u32"
              ? `!Number.isInteger(${valExpr}) || ${valExpr} < 0 || ${valExpr} > 4294967295`
              : type === "f32"
                ? `!Number.isFinite(${valExpr}) || Math.abs(${valExpr}) > 3.4028234663852886e38`
                : `!Number.isFinite(${valExpr})`;
    return `if (${invalid}) return Effect.fail({ _tag: "WasmInputError" as const, function: ${JSON.stringify(fnName)}, parameter: ${JSON.stringify(paramName)}, expected: ${JSON.stringify(type)}, value: ${valExpr} });`;
  };

  for (const fn of signatures) {
    const isBufferResult = TYPED_ARRAY_TYPES.has(fn.result);
    const isStringResult = fn.result === "string";
    const isClassResult = classes.has(fn.result);
    const isArrayResult = parseArrayElementType(fn.result) !== null;
    const isTupleResult = parseTupleElementTypeList(fn.result) !== null;
    const isBooleanResult = BOOLEAN_TYPES.has(fn.result);
    const isHandleResult =
      isBufferResult ||
      isStringResult ||
      isClassResult ||
      isArrayResult ||
      isTupleResult;
    const tsReturnType = toTsType(fn.result);
    const rawReturnType = isHandleResult
      ? `${prefix}WasmHandle<${tsReturnType}>`
      : tsReturnType;

    const args = fn.params
      .map((p, i) => `arg${i}: ${toTsParamType(p.type)}`)
      .join(", ");
    const passedArgs = fn.params.map((_, i) => `arg${i}`).join(", ");

    const hasBuffers =
      fn.params.some(
        (p) =>
          TYPED_ARRAY_TYPES.has(p.type) ||
          p.type === "string" ||
          classes.has(p.type) ||
          parseArrayElementType(p.type) !== null ||
          parseTupleElementTypeList(p.type) !== null,
      ) ||
      isBufferResult ||
      isStringResult ||
      isClassResult ||
      isArrayResult ||
      isTupleResult ||
      decl.code.includes("Array") ||
      decl.code.includes("new ") ||
      decl.code.includes("v128");
    const wasmFnType =
      fn.result === "void"
        ? "(...args: (number | bigint)[]) => void"
        : isBufferResult ||
            isStringResult ||
            isClassResult ||
            isArrayResult ||
            isTupleResult
          ? "(...args: (number | bigint)[]) => number"
          : isBooleanResult
            ? "(...args: (number | bigint)[]) => number"
            : BIGINT_SCALAR_TYPES.has(fn.result)
              ? "(...args: (number | bigint)[]) => bigint"
              : `(...args: (number | bigint)[]) => number`;

    const errorType = `{ readonly _tag: "WasmInputError"; readonly function: string; readonly parameter: string; readonly expected: string; readonly value: unknown } | { readonly _tag: "WasmTrapError"; readonly function: string; readonly cause: unknown } | { readonly _tag: "WasmInitializationError"; readonly function: string; readonly cause: unknown }`;

    const validations = fn.params
      .map((param, i) =>
        generateValidation(`arg${i}`, param.type, fn.name, param.name),
      )
      .join(" ");

    let syncBody: string;
    let effectTryBody: string;
    let rawBody: string;

    const readExpr =
      fn.result === "void"
        ? ""
        : isBooleanResult
          ? `Boolean(__res)`
          : isBufferResult
            ? `${prefix}Read(exports, __res, ${toJsTypedArray(fn.result)})`
            : isStringResult
              ? `${prefix}ReadString(exports, __res)`
              : isClassResult
                ? `${prefix}Read_${fn.result}(exports, __res)`
                : isTupleResult
                  ? `${prefix}Read_${tupleClassName(parseTupleElementTypeList(fn.result)!)}(exports, __res)`
                  : isArrayResult
                    ? (() => {
                        const elem = parseArrayElementType(fn.result)!;
                        const tupleElems = parseTupleElementTypeList(elem);
                        const safeElem =
                          elem === "boolean"
                            ? "bool"
                            : tupleElems
                              ? tupleClassName(tupleElems)
                              : elem;
                        return `${prefix}Read_Array_${safeElem}(exports, __res)`;
                      })()
                    : fn.result === "u32"
                      ? `((__res) >>> 0)`
                      : fn.result === "u64"
                        ? `BigInt.asUintN(64, __res as bigint)`
                        : fn.result === "i64"
                          ? `BigInt.asIntN(64, __res as bigint)`
                          : `__res`;

    if (!hasBuffers) {
      const passed = fn.params
        .map((p, i) =>
          BOOLEAN_TYPES.has(p.type) ? `(arg${i} ? 1 : 0)` : `arg${i}`,
        )
        .join(", ");
      const call = `(${prefix}Get()[${JSON.stringify(fn.name)}] as ${wasmFnType})(${passed})`;
      const effectCall = `(exports[${JSON.stringify(fn.name)}] as ${wasmFnType})(${passed})`;
      const raw =
        fn.result === "void"
          ? `${call};`
          : isBooleanResult
            ? `Boolean(${call})`
            : fn.result === "u32"
              ? `(${call} as number >>> 0)`
              : fn.result === "u64"
                ? `BigInt.asUintN(64, ${call} as bigint)`
                : fn.result === "i64"
                  ? `BigInt.asIntN(64, ${call} as bigint)`
                  : call;
      const effectRaw =
        fn.result === "void"
          ? `${effectCall};`
          : isBooleanResult
            ? `Boolean(${effectCall})`
            : fn.result === "u32"
              ? `(${effectCall} as number >>> 0)`
              : fn.result === "u64"
                ? `BigInt.asUintN(64, ${effectCall} as bigint)`
                : fn.result === "i64"
                  ? `BigInt.asIntN(64, ${effectCall} as bigint)`
                  : effectCall;
      syncBody = fn.result === "void" ? raw : `return ${raw};`;
      effectTryBody = fn.result === "void" ? effectRaw : `return ${effectRaw};`;
      rawBody = syncBody;
    } else {
      const allocs: string[] = [];
      const passedVars: string[] = [];
      const syncs: string[] = [];

      fn.params.forEach((p, i) => {
        if (BOOLEAN_TYPES.has(p.type)) {
          passedVars.push(`(arg${i} ? 1 : 0)`);
        } else if (TYPED_ARRAY_TYPES.has(p.type)) {
          const jsType = toJsTypedArray(p.type);
          allocs.push(
            `const __isH${i} = Boolean(arg${i} && (arg${i} as any)._tag === "WasmHandle");`,
            `const __h${i} = __isH${i} ? { viewPtr: (arg${i} as any).ptr } : ${prefix}Alloc(exports, arg${i} as any, ${jsType});`,
          );
          passedVars.push(`__h${i}.viewPtr`);
          syncs.push(`if (!__isH${i}) ${prefix}Sync(exports, __h${i} as any);`);
        } else if (p.type === "string") {
          allocs.push(
            `const __h${i} = (arg${i} && (arg${i} as any)._tag === "WasmHandle") ? (arg${i} as any).ptr : ${prefix}AllocString(exports, arg${i} as any);`,
          );
          passedVars.push(`__h${i}`);
        } else if (classes.has(p.type)) {
          allocs.push(
            `const __h${i} = (arg${i} && (arg${i} as any)._tag === "WasmHandle") ? (arg${i} as any).ptr : ${prefix}Alloc_${p.type}(exports, arg${i} as any);`,
          );
          passedVars.push(`__h${i}`);
        } else if (parseTupleElementTypeList(p.type)) {
          const tupleElems = parseTupleElementTypeList(p.type)!;
          const clsName = tupleClassName(tupleElems);
          allocs.push(
            `const __h${i} = (arg${i} && (arg${i} as any)._tag === "WasmHandle") ? (arg${i} as any).ptr : ${prefix}Alloc_${clsName}(exports, arg${i} as any);`,
          );
          passedVars.push(`__h${i}`);
        } else if (parseArrayElementType(p.type)) {
          const elem = parseArrayElementType(p.type)!;
          const tupleElems = parseTupleElementTypeList(elem);
          const safeElem =
            elem === "boolean"
              ? "bool"
              : tupleElems
                ? tupleClassName(tupleElems)
                : elem;
          allocs.push(
            `const __h${i} = (arg${i} && (arg${i} as any)._tag === "WasmHandle") ? (arg${i} as any).ptr : ${prefix}Alloc_Array_${safeElem}(exports, arg${i} as any);`,
          );
          passedVars.push(`__h${i}`);
        } else {
          passedVars.push(`arg${i}`);
        }
      });

      const callExpr = `(exports[${JSON.stringify(fn.name)}] as ${wasmFnType})(${passedVars.join(", ")})`;
      const returnExpr =
        fn.result === "void"
          ? `try { ${callExpr}; ${syncs.join(" ")} } finally { (exports.__funscript_reset_heap as () => void)(); } return;`
          : `try { const __res = ${callExpr} as any; ${syncs.join(" ")} return ${readExpr}; } finally { (exports.__funscript_reset_heap as () => void)(); }`;

      const rawReturnExpr =
        fn.result === "void"
          ? `${callExpr}; ${syncs.join(" ")} return;`
          : isHandleResult
            ? `const __res = ${callExpr} as number; ${syncs.join(" ")} return new ${prefix}WasmHandle(__res, () => ${readExpr});`
            : `const __res = ${callExpr} as any; ${syncs.join(" ")} return ${readExpr};`;

      syncBody = `const exports = ${prefix}Get(); ${allocs.join(" ")} ${returnExpr}`;
      effectTryBody = `${allocs.join(" ")} ${returnExpr}`;
      rawBody = `const exports = ${prefix}Get(); ${allocs.join(" ")} ${rawReturnExpr}`;
    }

    lines.push(
      `const ${fn.name} = Object.assign(`,
      `  (${args}): ${tsReturnType} => { ${syncBody} },`,
      `  {`,
      `    raw: (${args}): ${rawReturnType} => { ${rawBody} },`,
      `    reset: (): void => { ((${prefix}Get()).__funscript_reset_heap as () => void)(); },`,
      `    scoped: (${args}): Effect.Effect<${rawReturnType}, ${errorType}, Scope.Scope> =>`,
      `      Effect.acquireRelease(`,
      `        Effect.sync((): ${rawReturnType} => ${fn.name}.raw(${passedArgs})),`,
      `        () => Effect.sync((): void => { ((${prefix}Get()).__funscript_reset_heap as () => void)(); })`,
      `      ),`,
      `    effect: (${args}): Effect.Effect<${tsReturnType}, ${errorType}> =>`,
      `      Effect.suspend((): Effect.Effect<${tsReturnType}, ${errorType}> => {`,
      `        ${validations}`,
      `        return Effect.flatMap(`,
      `          Effect.try({ try: ${prefix}Get, catch: (cause) => ({ _tag: "WasmInitializationError" as const, function: ${JSON.stringify(fn.name)}, cause }) }),`,
      `          (exports) => Effect.try({`,
      `            try: () => { ${effectTryBody} },`,
      `            catch: (cause) => ({ _tag: "WasmTrapError" as const, function: ${JSON.stringify(fn.name)}, cause })`,
      `          })`,
      `        );`,
      `      })`,
      `  }`,
      `);`,
    );
  }
  return lines.join("\n");
}
