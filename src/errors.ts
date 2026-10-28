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
