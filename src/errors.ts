import { codeFrameColumns } from "@babel/code-frame";
import type { Span } from "./ast/types.js";

/**
 * Base error class for all FunScript compiler, lexer, and parser errors.
 */
export class FunScriptError extends Error {
  public span?: Span;
  public source?: string;
  public rawMessage: string;

  constructor(message: string, span?: Span, source?: string) {
    const formatted = span
      ? `${message} at line ${span.start.line}, col ${span.start.column}`
      : message;
    super(formatted);
    this.name = "FunScriptError";
    this.rawMessage = message;
    this.span = span;
    this.source = source;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public format(
    source: string = this.source ?? "",
    options?: { highlightCode?: boolean },
  ): string {
    if (!this.span || !source) return this.message;
    const frame = safeCodeFrame(
      source,
      {
        start: { line: this.span.start.line, column: this.span.start.column },
        end: this.span.end
          ? { line: this.span.end.line, column: this.span.end.column }
          : undefined,
      },
      {
        highlightCode: options?.highlightCode ?? false,
        message: this.rawMessage,
      },
    );
    if (!frame) return this.message;
    return `${this.name}: ${this.rawMessage} at line ${this.span.start.line}, col ${this.span.start.column}\n\n${frame}`;
  }
}

/**
 * Formats a `@babel/code-frame` snippet, returning `undefined` if the span is out of bounds.
 */
export function safeCodeFrame(
  source: string,
  location: Parameters<typeof codeFrameColumns>[1],
  options?: Parameters<typeof codeFrameColumns>[2],
): string | undefined {
  try {
    return codeFrameColumns(source, location, options);
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      return undefined;
    }
    return undefined;
  }
}

/**
 * Returns true for filesystem errors indicating a missing path (`ENOENT` / `ENOTDIR`).
 */
export function isFileNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Returns true for expected URI conversion errors on non-file URIs.
 */
export function isExpectedUriError(error: unknown): boolean {
  return error instanceof URIError || error instanceof TypeError;
}

/**
 * Returns true for expected FunScript syntax/compiler errors or URI errors on incomplete buffers.
 */
export function isExpectedSyntaxError(error: unknown): boolean {
  return error instanceof FunScriptError || isExpectedUriError(error);
}

/**
 * Returns true for Node module resolution errors (`MODULE_NOT_FOUND`, `ERR_PACKAGE_PATH_NOT_EXPORTED`, `ENOENT`, `ENOTDIR`).
 */
export function isModuleNotFoundError(error: unknown): boolean {
  if (isFileNotFoundError(error)) return true;
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return (
    code === "MODULE_NOT_FOUND" ||
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
  );
}

/**
 * Safely extracts an error message from an unknown thrown value.
 */
export function toErrorMessage(error: unknown, source?: string): string {
  if (error instanceof FunScriptError && (source || error.source)) {
    return error.format(source);
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
