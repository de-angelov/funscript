import type {
  ArrayPattern,
  BindingTarget,
  Pattern,
  Position,
  RecordPattern,
  RecordPatternField,
  UpperIdentifier,
} from "../ast/types.js";
import { TokenType } from "../lexer/tokens.js";
import { ParseError } from "./errors.js";
import type { Parser } from "./parser.js";

export type PatternParserContext = Parser;

export function parsePattern(ctx: PatternParserContext): Pattern {
  const pat = parsePrimaryPattern(ctx);
  if (ctx.match(TokenType.BAR)) {
    const patterns: Pattern[] = [pat];
    do {
      patterns.push(parsePrimaryPattern(ctx));
    } while (ctx.match(TokenType.BAR));
    return {
      kind: "OrPattern",
      patterns,
      span: {
        start: pat.span.start,
        end: patterns[patterns.length - 1].span.end,
      },
    };
  }
  return pat;
}

function parsePrimaryPattern(ctx: PatternParserContext): Pattern {
  if (ctx.match(TokenType.UNDERSCORE)) {
    return { kind: "WildcardPattern", span: ctx.previous().span };
  }
  if (ctx.match(TokenType.NUMBER)) {
    return {
      kind: "LiteralPattern",
      literal: {
        kind: "NumberLiteral",
        value: parseFloat(ctx.previous().value.replaceAll("_", "")),
        raw: ctx.previous().value,
        span: ctx.previous().span,
      },
      span: ctx.previous().span,
    };
  }
  if (ctx.check(TokenType.STRING)) {
    const lit = ctx.parseStringLiteral();
    return {
      kind: "LiteralPattern",
      literal: lit,
      span: lit.span,
    };
  }
  if (ctx.match(TokenType.TRUE, TokenType.FALSE)) {
    return {
      kind: "LiteralPattern",
      literal: {
        kind: "BooleanLiteral",
        value: ctx.previous().value === "true",
        span: ctx.previous().span,
      },
      span: ctx.previous().span,
    };
  }
  if (ctx.match(TokenType.UPPER_IDENTIFIER)) {
    const start = ctx.previous().span.start;
    const constructorName: UpperIdentifier = {
      kind: "UpperIdentifier",
      name: ctx.previous().value,
      span: ctx.previous().span,
    };
    const args: Pattern[] = [];

    if (ctx.match(TokenType.LPAREN)) {
      if (!ctx.check(TokenType.RPAREN)) {
        do {
          args.push(parsePattern(ctx));
        } while (ctx.match(TokenType.COMMA) && !ctx.check(TokenType.RPAREN));
      }
      ctx.consume(
        TokenType.RPAREN,
        "Expected ')' after constructor pattern args",
      );
    }

    return {
      kind: "ConstructorPattern",
      constructorName,
      args,
      span: { start, end: ctx.previous().span.end },
    };
  }
  if (ctx.match(TokenType.IDENTIFIER)) {
    return {
      kind: "VariablePattern",
      name: {
        kind: "Identifier",
        name: ctx.previous().value,
        span: ctx.previous().span,
      },
      span: ctx.previous().span,
    };
  }
  if (ctx.match(TokenType.LBRACE)) {
    const start = ctx.previous().span.start;
    const fields: RecordPatternField[] = [];
    ctx.skipNewlines();
    const hasIndent = ctx.match(TokenType.INDENT);

    while (
      !ctx.check(TokenType.RBRACE) &&
      !ctx.check(TokenType.DEDENT) &&
      !ctx.isAtEnd()
    ) {
      ctx.skipNewlines();
      if (ctx.check(TokenType.RBRACE) || ctx.check(TokenType.DEDENT)) break;

      const isRest = ctx.match(TokenType.DOTDOTDOT);
      const key = ctx.parseIdentifier();
      let pattern: Pattern | undefined;
      if (!isRest && ctx.match(TokenType.COLON)) {
        pattern = parsePattern(ctx);
      }
      fields.push({
        kind: "RecordPatternField",
        key,
        pattern,
        isRest: isRest || undefined,
        span: {
          start: isRest ? ctx.previous().span.start : key.span.start,
          end: pattern ? pattern.span.end : key.span.end,
        },
      });

      ctx.match(TokenType.COMMA);
      ctx.skipNewlines();
    }

    if (hasIndent) {
      ctx.consume(TokenType.DEDENT, "Expected unindent in record pattern");
    }
    ctx.skipNewlines();
    const end = ctx.consume(
      TokenType.RBRACE,
      "Expected '}' after record pattern",
    ).span.end;
    return {
      kind: "RecordPattern",
      fields,
      span: { start, end },
    };
  }
  if (ctx.match(TokenType.LBRACKET)) {
    const start = ctx.previous().span.start;
    const { elements, end } = parseDelimitedPatternElements(
      ctx,
      TokenType.RBRACKET,
      "Expected ']' after array pattern",
    );
    return {
      kind: "ArrayPattern",
      elements,
      span: { start, end },
    };
  }
  if (ctx.match(TokenType.LPAREN)) {
    const start = ctx.previous().span.start;
    const { elements, sawComma, end } = parseDelimitedPatternElements(
      ctx,
      TokenType.RPAREN,
      "Expected ')' after tuple pattern",
    );
    if (!sawComma && elements.length === 1) {
      return elements[0];
    }
    return {
      kind: "ArrayPattern",
      elements,
      span: { start, end },
    };
  }

  throw new ParseError(
    `Unexpected pattern token '${ctx.peek().value}'`,
    ctx.peek().span,
  );
}

function parseDelimitedPatternElements(
  ctx: PatternParserContext,
  closeToken: TokenType,
  closeMessage: string,
): { elements: Pattern[]; sawComma: boolean; end: Position } {
  const elements: Pattern[] = [];
  let sawComma = false;
  ctx.skipNewlines();
  while (!ctx.check(closeToken) && !ctx.isAtEnd()) {
    ctx.skipNewlines();
    if (ctx.check(closeToken)) break;
    if (ctx.match(TokenType.COMMA)) {
      sawComma = true;
      elements.push({
        kind: "WildcardPattern",
        span: ctx.previous().span,
      });
      continue;
    }
    if (ctx.match(TokenType.DOTDOTDOT)) {
      const restStart = ctx.previous().span.start;
      const arg = parsePattern(ctx);
      elements.push({
        kind: "RestPattern",
        argument: arg,
        span: { start: restStart, end: arg.span.end },
      });
    } else {
      elements.push(parsePattern(ctx));
    }
    if (ctx.match(TokenType.COMMA)) {
      sawComma = true;
    }
    ctx.skipNewlines();
  }
  const end = ctx.consume(closeToken, closeMessage).span.end;
  return { elements, sawComma, end };
}

export function parseBindingPattern(
  ctx: PatternParserContext,
): RecordPattern | ArrayPattern {
  const pat = parsePattern(ctx);
  if (pat.kind === "RecordPattern" || pat.kind === "ArrayPattern") {
    return pat;
  }
  throw new ParseError("Expected object or array pattern", pat.span);
}

export function collectPatternVariables(
  pat: Pattern | BindingTarget,
): string[] {
  if (pat.kind === "Identifier" || pat.kind === "UpperIdentifier") {
    return [pat.name];
  }
  if (pat.kind === "VariablePattern") {
    return [pat.name.name];
  }
  if (pat.kind === "RecordPattern") {
    const vars: string[] = [];
    for (const f of pat.fields) {
      if (!f.pattern) {
        vars.push(f.key.name);
      } else {
        vars.push(...collectPatternVariables(f.pattern));
      }
    }
    return vars;
  }
  if (pat.kind === "ArrayPattern") {
    const vars: string[] = [];
    for (const el of pat.elements) {
      vars.push(...collectPatternVariables(el));
    }
    return vars;
  }
  if (pat.kind === "RestPattern") {
    return collectPatternVariables(pat.argument);
  }
  return [];
}

export function isDestructuringBindingStart(
  ctx: PatternParserContext,
): boolean {
  if (!ctx.check(TokenType.LBRACE) && !ctx.check(TokenType.LBRACKET))
    return false;
  const stack: TokenType[] = [];
  for (let i = 0; i < 512; i++) {
    const tok = ctx.peekAhead(i);
    if (tok.type === TokenType.EOF) return false;
    if (tok.type === TokenType.LBRACE) {
      stack.push(TokenType.RBRACE);
    } else if (tok.type === TokenType.LBRACKET) {
      stack.push(TokenType.RBRACKET);
    } else if (
      tok.type === TokenType.RBRACE ||
      tok.type === TokenType.RBRACKET
    ) {
      if (stack.length === 0 || stack[stack.length - 1] !== tok.type) {
        return false;
      }
      stack.pop();
      if (stack.length === 0) {
        let nextIdx = i + 1;
        while (ctx.peekAhead(nextIdx).type === TokenType.NEWLINE) {
          nextIdx++;
        }
        const next = ctx.peekAhead(nextIdx).type;
        return next === TokenType.EQ || next === TokenType.COLON;
      }
    }
  }
  return false;
}

export function isDestructuringEffectBindStart(
  ctx: PatternParserContext,
): boolean {
  if (!ctx.check(TokenType.LBRACE) && !ctx.check(TokenType.LBRACKET))
    return false;
  const stack: TokenType[] = [];
  for (let i = 0; i < 512; i++) {
    const tok = ctx.peekAhead(i);
    if (tok.type === TokenType.EOF) return false;
    if (tok.type === TokenType.LBRACE) {
      stack.push(TokenType.RBRACE);
    } else if (tok.type === TokenType.LBRACKET) {
      stack.push(TokenType.RBRACKET);
    } else if (
      tok.type === TokenType.RBRACE ||
      tok.type === TokenType.RBRACKET
    ) {
      if (stack.length === 0 || stack[stack.length - 1] !== tok.type) {
        return false;
      }
      stack.pop();
      if (stack.length === 0) {
        let nextIdx = i + 1;
        while (ctx.peekAhead(nextIdx).type === TokenType.NEWLINE) {
          nextIdx++;
        }
        return ctx.peekAhead(nextIdx).type === TokenType.LARROW;
      }
    }
  }
  return false;
}
