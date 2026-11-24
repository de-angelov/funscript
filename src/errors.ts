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
    try {
      const frame = codeFrameColumns(
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
      return `${this.name}: ${this.rawMessage} at line ${this.span.start.line}, col ${this.span.start.column}\n\n${frame}`;
    } catch {
      return this.message;
    }
  }
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
