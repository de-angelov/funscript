import type { Span } from "./ast/types.js";

/**
 * Base error class for all FunScript compiler, lexer, and parser errors.
 */
export class FunScriptError extends Error {
  public span?: Span;

  constructor(message: string, span?: Span) {
    const formatted = span
      ? `${message} at line ${span.start.line}, col ${span.start.column}`
      : message;
    super(formatted);
    this.name = "FunScriptError";
    this.span = span;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Safely extracts an error message from an unknown thrown value.
 */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
