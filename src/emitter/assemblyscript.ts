import ts from "typescript";
import type { AsDeclaration } from "../ast/types.js";
import { FunScriptError } from "../errors.js";

const cache = new Map<string, string>();
const prepared = new WeakMap<AsDeclaration, string>();

/** Compile a numeric-only kernel while keeping the existing synchronous compiler API. */
export async function prepareAssemblyScript(decl: AsDeclaration): Promise<void> {
  const source = ts.createSourceFile("kernel.ts", decl.code, ts.ScriptTarget.Latest, true);
  const signatures: { name: string; params: string[]; result: string }[] = [];
  const supported = new Set(["i32", "u32", "f32", "f64"]);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      throw new FunScriptError("AssemblyScript blocks cannot import or re-export modules", decl.span);
    }
    if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (!ts.isFunctionDeclaration(statement) || !statement.name || statement.typeParameters?.length || !statement.body) {
      throw new FunScriptError("AssemblyScript blocks may only export numeric functions", decl.span);
    }
    const result = statement.type?.getText(source) ?? "";
    const params = statement.parameters.map(p => p.type?.getText(source) ?? "");
    if (!supported.has(result) || params.some(p => !supported.has(p)) || statement.parameters.some(p => p.dotDotDotToken || p.questionToken || p.initializer)) {
      throw new FunScriptError("AssemblyScript exports require explicit i32, u32, f32, or f64 parameter and return types", decl.span);
    }
    signatures.push({ name: statement.name.text, params, result });
  }
  if (!signatures.length) throw new FunScriptError("AssemblyScript block must export at least one numeric function", decl.span);
  let binary = cache.get(decl.code);
  if (!binary) {
    try {
      const asc: { compileString(source: string, options: object): Promise<{ error: unknown; binary: Uint8Array | null; stderr: { toString(): string } }> } = await import("assemblyscript/" + "asc");
      const result = await asc.compileString(decl.code, { optimizeLevel: 3 });
      if (result.error || !result.binary) {
        const detail = result.stderr.toString();
        const location = /(?:input|stdin)\.ts\((\d+),(\d+)\)/.exec(detail);
        if (location && decl.codeStart) {
          const line = Number(location[1]);
          const column = Number(location[2]);
          const lines = decl.code.split("\n");
          if (line >= 1 && line <= lines.length && column >= 1 && column <= lines[line - 1].length + 1) {
            const preceding = lines.slice(0, line - 1).reduce((sum, part) => sum + part.length + 1, 0);
            const start = {
              offset: decl.codeStart.offset + preceding + column - 1,
              line: decl.codeStart.line + line - 1,
              column: line === 1 ? decl.codeStart.column + column - 1 : column,
            };
            throw new FunScriptError(`AssemblyScript compilation failed: ${detail}`, { start, end: { ...start, offset: start.offset + 1, column: start.column + 1 } });
          }
        }
        throw new Error(detail);
      }
      const wasm = (globalThis as any).WebAssembly;
      const imports: { module: string; name: string; kind: string }[] = wasm.Module.imports(new wasm.Module(result.binary));
      if (imports.some(i => i.module !== "env" || i.name !== "abort" || i.kind !== "function")) throw new Error("AssemblyScript kernel has unsupported imports");
      binary = Buffer.from(result.binary).toString("base64");
      if (cache.size >= 64) cache.delete(cache.keys().next().value!);
      cache.set(decl.code, binary);
    } catch (cause) {
      if (cause instanceof FunScriptError) throw cause;
      throw new FunScriptError(`AssemblyScript compilation failed: ${String(cause)}`, decl.span);
    }
  }
  prepared.set(decl, binary);
}

export function emitAssemblyScript(decl: AsDeclaration): string {
  const binary = prepared.get(decl) ?? cache.get(decl.code);
  if (!binary) throw new FunScriptError("AssemblyScript block has not been compiled", decl.span);
  const source = ts.createSourceFile("kernel.ts", decl.code, ts.ScriptTarget.Latest, true);
  const signatures = source.statements.filter(ts.isFunctionDeclaration).filter(s => ts.getModifiers(s)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)).map(s => ({ name: s.name!.text, params: s.parameters.map(p => ({ type: p.type!.getText(source), name: p.name.getText(source) })), result: s.type!.getText(source) }));

  const prefix = `__funWasm${decl.span.start.offset}`;
  const lines = [
    `let ${prefix}Instance: Record<string, unknown> | undefined;`,
    `const ${prefix}Get = (): Record<string, unknown> => {`,
    `  if (${prefix}Instance !== undefined) return ${prefix}Instance;`,
    `  const bytes = Uint8Array.from(atob(${JSON.stringify(binary)}), c => c.charCodeAt(0));`,
    `  const runtime = (globalThis as unknown as { WebAssembly: { Module: new (bytes: Uint8Array) => object; Instance: new (module: object, imports: { env: { abort: () => never } }) => { exports: Record<string, unknown> } } }).WebAssembly;`,
    `  return ${prefix}Instance = new runtime.Instance(new runtime.Module(bytes), { env: { abort: () => { throw new Error("AssemblyScript abort"); } } }).exports;`,
    `};`,
  ];
  for (const fn of signatures) {
    const args = fn.params.map((_, i) => `arg${i}: number`).join(", ");
    const passed = fn.params.map((_, i) => `arg${i}`).join(", ");
    const call = `(${prefix}Get()[${JSON.stringify(fn.name)}] as (${args}) => number)(${passed})`;
    const effectCall = `(exports[${JSON.stringify(fn.name)}] as (${args}) => number)(${passed})`;
    const effectRaw = fn.result === "u32" ? `(${effectCall} >>> 0)` : effectCall;
    const raw = fn.result === "u32" ? `(${call} >>> 0)` : call;
    const errorType = `{ readonly _tag: "WasmInputError"; readonly function: string; readonly parameter: string; readonly expected: string; readonly value: number } | { readonly _tag: "WasmTrapError"; readonly function: string; readonly cause: unknown } | { readonly _tag: "WasmInitializationError"; readonly function: string; readonly cause: unknown }`;
    const validations = fn.params.map((param, i) => {
      const arg = `arg${i}`;
      const invalid = param.type === "i32" ? `!Number.isInteger(${arg}) || ${arg} < -2147483648 || ${arg} > 2147483647`
        : param.type === "u32" ? `!Number.isInteger(${arg}) || ${arg} < 0 || ${arg} > 4294967295`
        : param.type === "f32" ? `!Number.isFinite(${arg}) || Math.abs(${arg}) > 3.4028234663852886e38`
        : `!Number.isFinite(${arg})`;
      return `if (${invalid}) return Effect.fail({ _tag: "WasmInputError" as const, function: ${JSON.stringify(fn.name)}, parameter: ${JSON.stringify(param.name)}, expected: ${JSON.stringify(param.type)}, value: ${arg} });`;
    }).join(" ");
    lines.push(`const ${fn.name} = Object.assign((${args}): number => ${raw}, { effect: (${args}): Effect.Effect<number, ${errorType}> => Effect.suspend((): Effect.Effect<number, ${errorType}> => { ${validations} return Effect.flatMap(Effect.try({ try: ${prefix}Get, catch: (cause) => ({ _tag: "WasmInitializationError" as const, function: ${JSON.stringify(fn.name)}, cause }) }), exports => Effect.try({ try: () => ${effectRaw}, catch: (cause) => ({ _tag: "WasmTrapError" as const, function: ${JSON.stringify(fn.name)}, cause }) })); }) });`);
  }
  return lines.join("\n");
}
