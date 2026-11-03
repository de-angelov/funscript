import { expect } from "vitest";
import { Effect, Schema, Data, Context, pipe, Array as EffectArray, Option, Either, Equal, Order, Record as EffectRecord } from "effect";
import { match, P } from "ts-pattern";
import { create as mutativeCreate } from "mutative";
import ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  compileString,
  CompilerError,
  type CompileOptions,
  type CompileResult,
} from "../../src/compiler.js";
import {
  typeCheckSource,
  type TypeCheckResult,
  type TypeCheckDiagnostic,
  type CheckOptions,
  type DiagnosticCategory,
} from "../../src/compiler/check.js";
import { format, checkFormat } from "../../src/formatter/index.js";

// ============================================================================
// 1. Compilation Helpers
// ============================================================================

/**
 * Compiles FunScript source code directly to TypeScript.
 * Eliminates the repetitive `await Effect.runPromise(compileString(code))` boilerplate.
 */
export async function compile(
  source: string,
  filename: string = "test.fun",
  options?: CompileOptions,
): Promise<CompileResult> {
  return Effect.runPromise(compileString(source, filename, options));
}

/**
 * Compiles FunScript source code expecting a failure, returning the resulting CompilerError.
 * Eliminates `await Effect.runPromise(Effect.flip(compileString(code)))`.
 */
export async function compileFailure(
  source: string,
  filename: string = "test.fun",
  options?: CompileOptions,
): Promise<CompilerError> {
  return Effect.runPromise(Effect.flip(compileString(source, filename, options)));
}

export interface ExpectedCompileErrorOptions {
  message?: string | RegExp;
  line?: number;
  column?: number;
}

/**
 * Asserts that compiling the source code fails with a CompilerError matching the given expectations.
 */
export async function expectCompileError(
  source: string,
  expected?: string | RegExp | ExpectedCompileErrorOptions,
  filename: string = "test.fun",
  options?: CompileOptions,
): Promise<CompilerError> {
  let failure: CompilerError;
  try {
    await Effect.runPromise(compileString(source, filename, options));
    throw new Error("Expected compilation to fail, but it succeeded");
  } catch (err) {
    if (err instanceof CompilerError) {
      failure = err;
    } else if (err instanceof Error && err.message === "Expected compilation to fail, but it succeeded") {
      throw err;
    } else {
      // In case it's wrapped or another error type
      failure = err as CompilerError;
    }
  }

  if (typeof expected === "string") {
    expect(failure.message).toContain(expected);
  } else if (expected instanceof RegExp) {
    expect(failure.message).toMatch(expected);
  } else if (expected && typeof expected === "object") {
    if (expected.message) {
      if (typeof expected.message === "string") {
        expect(failure.message).toContain(expected.message);
      } else {
        expect(failure.message).toMatch(expected.message);
      }
    }
    if (expected.line !== undefined) {
      expect((failure as any).span?.start?.line).toBe(expected.line);
    }
    if (expected.column !== undefined) {
      expect((failure as any).span?.start?.column).toBe(expected.column);
    }
  }

  return failure;
}

// ============================================================================
// 2. Execution / Compile-and-Run Helpers
// ============================================================================

export interface EvalOptions {
  scope?: Record<string, any>;
  exports?: string[];
  expression?: string;
}

export interface EvalResult {
  exports: Record<string, any>;
  result?: any;
}

export interface CompileAndRunOptions extends EvalOptions {
  filename?: string;
  compileOptions?: CompileOptions;
}

export interface CompileAndRunResult extends EvalResult {
  typescript: string;
  sourceMap?: string;
}

/**
 * Proxy for Array that supports both standard JS Array methods/constructors
 * and Effect Array utility methods (Array.map, Array.filter, Array.isArray, etc.).
 */
export const ArrayCompat = new Proxy(Array, {
  get(target, prop, receiver) {
    if (prop in EffectArray) {
      return (EffectArray as any)[prop];
    }
    return Reflect.get(target, prop, receiver);
  },
});

/**
 * Default runtime scope injected into evaluated modules.
 */
export function getDefaultRuntimeScope(): Record<string, any> {
  return {
    Effect,
    Schema,
    Data,
    Context,
    pipe,
    Array: ArrayCompat,
    Option,
    Either,
    Equal,
    Order,
    Record: EffectRecord,
    match,
    P,
    create: mutativeCreate,
  };
}

/**
 * Extracts exported identifier names from TypeScript source code.
 */
export function extractExportedNames(typescript: string): string[] {
  const exportedNames: string[] = [];
  const declRegex = /\bexport\s+(?:const|let|var|function\*?|class)\s+([A-Za-z0-9_$]+)/g;
  let matchDecl: RegExpExecArray | null;
  while ((matchDecl = declRegex.exec(typescript)) !== null) {
    if (matchDecl[1] && !exportedNames.includes(matchDecl[1])) {
      exportedNames.push(matchDecl[1]);
    }
  }

  const namedExportRegex = /\bexport\s*\{([^}]+)\}/g;
  let matchNamed: RegExpExecArray | null;
  while ((matchNamed = namedExportRegex.exec(typescript)) !== null) {
    for (const part of matchNamed[1].split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const asMatch = trimmed.match(/(?:^|\s+)as\s+([A-Za-z0-9_$]+)/);
      const id = asMatch ? asMatch[1] : trimmed.split(/\s+/)[0];
      if (id && !exportedNames.includes(id)) {
        exportedNames.push(id);
      }
    }
  }

  return exportedNames;
}

/**
 * Evaluates emitted TypeScript in a sandboxed Function with Effect ecosystem globals and custom scope.
 */
export function evalTypescript(typescript: string, options?: EvalOptions): EvalResult {
  // Transpile TypeScript to modern JavaScript, removing types and interfaces cleanly
  const jsTranspiled = ts.transpile(typescript, {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  });

  // Strip imports (provided via runtime scope) and convert exports to local bindings
  const jsCleaned = jsTranspiled
    .replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g, "")
    .replace(/^\s*import\s+.*$/gm, "")
    .replace(/\bexport\s+default\s+/g, "const defaultExport = ")
    .replace(/\bexport\s+(const|let|var|function\*?|class)\b/g, "$1 ")
    .replace(/\bexport\s*\{[^}]*\};?/g, "")
    .replace(/\bexport\s+/g, "");

  const exportNames = options?.exports ?? extractExportedNames(typescript);

  const scope = {
    ...getDefaultRuntimeScope(),
    ...(options?.scope ?? {}),
  };

  const scopeKeys = Object.keys(scope);
  const scopeValues = Object.values(scope);

  const returnExports = exportNames.length > 0 ? `{ ${exportNames.join(", ")} }` : "{}";
  const returnResult = options?.expression ? `(${options.expression})` : "undefined";

  const functionBody = `
${jsCleaned}

return {
  exports: ${returnExports},
  result: ${returnResult}
};
`;

  const fn = new Function(...scopeKeys, functionBody);
  const evaluated = fn(...scopeValues);

  return {
    exports: evaluated.exports,
    result: evaluated.result,
  };
}

/**
 * Compiles FunScript source and executes it immediately, returning exported bindings and evaluation result.
 */
export async function compileAndRun(
  source: string,
  options?: CompileAndRunOptions,
): Promise<CompileAndRunResult> {
  const filename = options?.filename ?? "test.fun";
  const compileRes = await compile(source, filename, options?.compileOptions);
  const evalRes = evalTypescript(compileRes.typescript, options);

  return {
    typescript: compileRes.typescript,
    sourceMap: compileRes.sourceMap,
    exports: evalRes.exports,
    result: evalRes.result,
  };
}

/**
 * High-level shortcut: compiles FunScript source and returns the exported bindings directly.
 */
export async function execute(
  source: string,
  options?: CompileAndRunOptions,
): Promise<Record<string, any>> {
  const result = await compileAndRun(source, options);
  return result.exports;
}

/**
 * High-level shortcut: compiles FunScript source and evaluates an expression within its scope.
 */
export async function evalExpression<T = any>(
  source: string,
  expression: string,
  options?: CompileAndRunOptions,
): Promise<T> {
  const result = await compileAndRun(source, { ...options, expression });
  return result.result as T;
}

// ============================================================================
// 3. Diagnostics & Type Check Helpers
// ============================================================================

export interface DiagnosticExpectation {
  message?: string | RegExp;
  category?: DiagnosticCategory;
  code?: number | string;
  line?: number;
  column?: number;
  file?: string;
}

/**
 * Runs FunScript type checking on source code, resolving the Effect to a Promise.
 */
export async function typeCheck(
  source: string,
  filename: string = "test.fun",
  options?: CheckOptions,
): Promise<TypeCheckResult> {
  return Effect.runPromise(typeCheckSource(source, filename, options));
}

/**
 * Asserts that the given source code (or TypeCheckResult) produces zero diagnostics.
 */
export async function expectNoDiagnostics(
  sourceOrResult: string | TypeCheckResult,
  filename: string = "test.fun",
  options?: CheckOptions,
): Promise<TypeCheckResult> {
  const result =
    typeof sourceOrResult === "string"
      ? await typeCheck(sourceOrResult, filename, options)
      : sourceOrResult;

  expect(
    result.diagnostics,
    `Expected zero diagnostics, but received ${result.diagnostics.length}: ${result.formattedOutput}`,
  ).toHaveLength(0);
  expect(result.success).toBe(true);

  return result;
}

function matchesDiagnostic(diag: TypeCheckDiagnostic, expected: string | RegExp | DiagnosticExpectation): boolean {
  if (typeof expected === "string") {
    return diag.message.includes(expected);
  }
  if (expected instanceof RegExp) {
    return expected.test(diag.message);
  }
  if (expected.message) {
    const matchesMsg =
      typeof expected.message === "string"
        ? diag.message.includes(expected.message)
        : expected.message.test(diag.message);
    if (!matchesMsg) return false;
  }
  if (expected.category && diag.category !== expected.category) return false;
  if (expected.code !== undefined && String(diag.code) !== String(expected.code)) return false;
  if (expected.line !== undefined && diag.line !== expected.line) return false;
  if (expected.column !== undefined && diag.column !== expected.column) return false;
  if (expected.file !== undefined && diag.file !== expected.file) return false;
  return true;
}

/**
 * Asserts that type checking produces at least one diagnostic matching the expectation,
 * and returns the matched diagnostic.
 */
export async function expectDiagnostic(
  sourceOrResult: string | TypeCheckResult,
  expected: string | RegExp | DiagnosticExpectation,
  filename: string = "test.fun",
  options?: CheckOptions,
): Promise<TypeCheckDiagnostic> {
  const result =
    typeof sourceOrResult === "string"
      ? await typeCheck(sourceOrResult, filename, options)
      : sourceOrResult;

  const found = result.diagnostics.find((d) => matchesDiagnostic(d, expected));
  expect(
    found,
    `Expected diagnostic matching ${JSON.stringify(expected)} not found. Available diagnostics:\n${result.formattedOutput || "(none)"}`,
  ).toBeDefined();

  return found!;
}

/**
 * Asserts that type checking produces all the specified expected diagnostics.
 */
export async function expectDiagnostics(
  sourceOrResult: string | TypeCheckResult,
  expectations: Array<string | RegExp | DiagnosticExpectation>,
  filename: string = "test.fun",
  options?: CheckOptions,
): Promise<TypeCheckDiagnostic[]> {
  const result =
    typeof sourceOrResult === "string"
      ? await typeCheck(sourceOrResult, filename, options)
      : sourceOrResult;

  const matched: TypeCheckDiagnostic[] = [];
  for (const expected of expectations) {
    const found = result.diagnostics.find((d) => matchesDiagnostic(d, expected));
    expect(
      found,
      `Expected diagnostic matching ${JSON.stringify(expected)} not found among ${result.diagnostics.length} diagnostics:\n${result.formattedOutput}`,
    ).toBeDefined();
    matched.push(found!);
  }

  return matched;
}

// ============================================================================
// 4. Formatter Idempotence Helpers
// ============================================================================

/**
 * Asserts that formatting the given FunScript source code is idempotent:
 * formatting once, then formatting that result a second time, produces the identical output.
 *
 * @param source FunScript source code to format.
 * @param message Optional custom assertion message.
 * @returns The formatted output string from the first pass for further assertions.
 */
export function assertFormattingIdempotent(source: string, message?: string): string {
  const firstPass = format(source);
  const secondPass = format(firstPass);
  expect(
    secondPass,
    message ?? "Formatting must be idempotent across multiple passes",
  ).toBe(firstPass);
  return firstPass;
}

/**
 * Asserts that formatting matches the expected output AND that formatting is idempotent.
 */
export function assertFormat(source: string, expectedFormatted: string, message?: string): string {
  const firstPass = format(source);
  expect(firstPass, message).toBe(expectedFormatted);
  const secondPass = format(firstPass);
  expect(secondPass, "Formatting must be idempotent across multiple passes").toBe(firstPass);
  return firstPass;
}

/**
 * Reads a FunScript file from disk and asserts that formatting is idempotent.
 */
export function assertFormattingIdempotentFile(filePath: string): string {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  const content = fs.readFileSync(fullPath, "utf-8");
  return assertFormattingIdempotent(content, `Formatting must be idempotent for file: ${filePath}`);
}
