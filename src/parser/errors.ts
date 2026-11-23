import type { Span } from "../ast/types.js";
import { FunScriptError } from "../errors.js";

export class ParseError extends FunScriptError {
  constructor(message: string, span: Span) {
    super(message, span);
    this.name = "ParseError";
  }
}

export const FUNCTION_RETURN_DIAGNOSTIC =
  "Function block must end with an explicit '=> returnValue'. Multi-statement functions require an explicit return arrow to distinguish returned values from side effects. Use '=> value' or rewrite as an inline single-expression lambda '(args) => expr'. See docs/syntax.md#311-explicit-returns-and-conditional-execution.";

export const EFFECT_RETURN_DIAGNOSTIC =
  "Effect block must end with an explicit '=> returnValue'. Effect blocks require an explicit return arrow to ensure values are yielded and returned properly. Use '=> value' to return, or '_ <- effect' followed by '=> Unit' to discard. See docs/syntax.md#93-the-non-final-expression-rule-and-control-flow-lowering.";

export const EFFECT_BARE_EXPR_DIAGNOSTIC =
  "Non-final bare expression in effect block is not executed. Use '<-' to run an effect or '_ <-' to discard its value. See docs/syntax.md#93-the-non-final-expression-rule-and-control-flow-lowering.";
