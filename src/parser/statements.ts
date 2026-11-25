import type {
  BlockStatement,
  DotPathExpression,
  EffectBlockExpression,
  EffectStatement,
  Expression,
  FunctionBody,
  Identifier,
  IndexExpression,
  ParBlockExpression,
  Statement,
  UpperIdentifier,
  WhenStatement,
} from "../ast/types.js";
import { TokenType } from "../lexer/tokens.js";
import {
  EFFECT_BARE_EXPR_DIAGNOSTIC,
  EFFECT_RETURN_DIAGNOSTIC,
  FUNCTION_RETURN_DIAGNOSTIC,
  ParseError,
} from "./errors.js";
import type { Parser } from "./parser.js";

export type StatementParserContext = Parser;

export interface BlockOptions {
  isBraced: boolean;
  requireExplicitReturn?: boolean;
}

export function parseBlock(
  ctx: StatementParserContext,
  options: BlockOptions,
): BlockStatement {
  const { isBraced, requireExplicitReturn = false } = options;
  ctx.enterScope();
  try {
    const start = ctx.previous().span.start;
    const statements: Statement[] = [];
    let finalExpression: Expression | undefined;

    ctx.skipNewlines();
    const hasIndent = isBraced ? ctx.match(TokenType.INDENT) : false;

    const isAtEnd = () => {
      if (isBraced) {
        return (
          ctx.check(TokenType.RBRACE) ||
          ctx.check(TokenType.DEDENT) ||
          ctx.isAtEnd()
        );
      } else {
        return ctx.check(TokenType.DEDENT) || ctx.isAtEnd();
      }
    };

    while (!isAtEnd()) {
      ctx.skipNewlines();
      if (isAtEnd()) break;

      try {
        if (ctx.check(TokenType.WHEN)) {
          statements.push(ctx.parseWhenStatement());
          ctx.skipNewlines();
          continue;
        }

        if (ctx.match(TokenType.ARROW)) {
          const retStart = ctx.previous().span.start;
          let hasIndent = false;
          if (ctx.match(TokenType.NEWLINE)) {
            hasIndent = ctx.match(TokenType.INDENT);
          }
          const retExpr = ctx.parseExpression();
          if (hasIndent) {
            ctx.skipNewlines();
            ctx.match(TokenType.DEDENT);
          }
          ctx.consumeNewlineOrEof();
          statements.push({
            kind: "ReturnStatement",
            argument: retExpr,
            span: { start: retStart, end: retExpr.span.end },
          });
          ctx.skipNewlines();
          continue;
        }

        if (ctx.isAssignmentStart()) {
          const target = ctx.parseAssignmentTarget();
          ctx.consume(TokenType.EQ, "Expected '=' in assignment");
          let hasIndent = false;
          if (ctx.match(TokenType.NEWLINE)) {
            hasIndent = ctx.match(TokenType.INDENT);
          }
          const val = ctx.parseExpression();
          if (hasIndent) {
            ctx.skipNewlines();
            ctx.match(TokenType.DEDENT);
          }
          ctx.consumeNewlineOrEof();
          statements.push({
            kind: "AssignmentStatement",
            target,
            value: val,
            span: { start: target.span.start, end: val.span.end },
          });
          ctx.skipNewlines();
          continue;
        }

        if (
          ctx.check(TokenType.MUT) ||
          (ctx.check(TokenType.IDENTIFIER) &&
            (ctx.peekAhead(1).type === TokenType.EQ ||
              ctx.peekAhead(1).type === TokenType.COLON)) ||
          (ctx.check(TokenType.UNDERSCORE) &&
            ctx.peekAhead(1).type === TokenType.EQ) ||
          ctx.isDestructuringBindingStart()
        ) {
          if (ctx.check(TokenType.UNDERSCORE)) {
            const start = ctx.peek().span.start;
            ctx.advance(); // consume '_'
            ctx.advance(); // consume '='
            let hasIndent = false;
            if (ctx.match(TokenType.NEWLINE)) {
              hasIndent = ctx.match(TokenType.INDENT);
            }
            const discardExpr = ctx.parseExpression();
            if (hasIndent) {
              ctx.skipNewlines();
              ctx.match(TokenType.DEDENT);
            }
            ctx.consumeNewlineOrEof("Expected newline");
            statements.push({
              kind: "BindingDeclaration",
              isMut: false,
              id: {
                kind: "Identifier",
                name: "_",
                span: { start, end: discardExpr.span.end },
              },
              init: discardExpr,
              span: { start, end: discardExpr.span.end },
            });
          } else {
            const bind = ctx.parseBindingDeclaration();
            if (!isBraced) {
              ctx.skipNewlines();
              if (ctx.check(TokenType.DEDENT)) {
                if (requireExplicitReturn) {
                  throw new ParseError(FUNCTION_RETURN_DIAGNOSTIC, bind.span);
                }
                bind.isTrailingBinding = true;
                statements.push(bind);
                if (
                  bind.id.kind === "Identifier" ||
                  bind.id.kind === "UpperIdentifier"
                ) {
                  finalExpression = bind.id;
                }
                break;
              } else {
                statements.push(bind);
              }
            } else {
              statements.push(bind);
            }
          }
          ctx.skipNewlines();
          continue;
        }

        const expr = ctx.parseExpression();
        ctx.skipNewlines();

        if (isAtEnd()) {
          const isAllowedImplicitReturn = statements.length === 0;
          if (
            requireExplicitReturn &&
            !isAllowedImplicitReturn &&
            expr.kind !== "MatchExpression" &&
            expr.kind !== "EffectBlockExpression"
          ) {
            throw new ParseError(FUNCTION_RETURN_DIAGNOSTIC, expr.span);
          }
          finalExpression = expr;
          break;
        } else {
          statements.push({
            kind: "ExpressionStatement",
            expression: expr,
            span: expr.span,
          });
        }
      } catch (err: unknown) {
        if (err instanceof ParseError) {
          ctx.diagnostics.push(err);
          ctx.synchronize();
        } else {
          throw err;
        }
      }
    }

    if (
      requireExplicitReturn &&
      !finalExpression &&
      statements.at(-1)?.kind !== "ReturnStatement"
    ) {
      throw new ParseError(FUNCTION_RETURN_DIAGNOSTIC, {
        start,
        end: ctx.previous().span.end,
      });
    }

    if (isBraced) {
      if (hasIndent) {
        ctx.consume(TokenType.DEDENT, "Expected unindent after brace block");
      }
      ctx.skipNewlines();
      const end = ctx.consume(TokenType.RBRACE, "Expected '}' after block").span
        .end;
      return {
        kind: "BlockStatement",
        statements,
        finalExpression,
        span: { start, end },
      };
    } else {
      ctx.consume(TokenType.DEDENT, "Expected unindent after function body");
      const fallbackExpr: Expression = {
        kind: "Identifier",
        name: "_error",
        span: {
          start: ctx.previous().span.start,
          end: ctx.previous().span.end,
        },
      };
      return {
        kind: "BlockStatement",
        statements,
        finalExpression:
          finalExpression ??
          (statements.length === 0 ? fallbackExpr : undefined),
        span: {
          start:
            statements[0]?.span.start ||
            (finalExpression
              ? finalExpression.span.start
              : ctx.previous().span.start),
          end: (finalExpression ?? fallbackExpr).span.end,
        },
      };
    }
  } finally {
    ctx.exitScope();
  }
}

export function parseBraceBlock(
  ctx: StatementParserContext,
  requireExplicitReturn = false,
): BlockStatement {
  return parseBlock(ctx, { isBraced: true, requireExplicitReturn });
}

export function parseIndentedBlock(
  ctx: StatementParserContext,
  requireExplicitReturn = false,
): BlockStatement {
  return parseBlock(ctx, { isBraced: false, requireExplicitReturn });
}

export function parseFunctionBody(
  ctx: StatementParserContext,
  requireExplicitReturn = false,
): FunctionBody {
  ctx.functionDepth++;
  try {
    if (ctx.isBraceBlock()) {
      ctx.consume(TokenType.LBRACE, "Expected '{'");
      return parseBraceBlock(ctx, requireExplicitReturn);
    }
    if (ctx.match(TokenType.NEWLINE)) {
      // A multiline `match` or `effect` is still one expression-bodied
      // lambda. Its enclosing arrow supplies the return, rather than making
      // the match/effect's final expression an implicit function return.
      if (ctx.check(TokenType.MATCH) || ctx.check(TokenType.EFFECT)) {
        return ctx.parseExpression();
      }
      ctx.consume(TokenType.INDENT, "Expected indent for function body block");
      return parseIndentedBlock(ctx, requireExplicitReturn);
    }
    return ctx.parseExpression();
  } finally {
    ctx.functionDepth--;
  }
}

export function parseWhenStatement(ctx: StatementParserContext): WhenStatement {
  const start = ctx.consume(TokenType.WHEN, "Expected 'when'").span.start;
  let condition: Expression;
  if (ctx.match(TokenType.LPAREN)) {
    condition = ctx.parseExpression();
    ctx.consume(TokenType.RPAREN, "Expected ')' after when condition");
  } else {
    condition = ctx.parseExpression();
  }

  if (ctx.match(TokenType.ARROW)) {
    if (ctx.functionDepth === 0) {
      throw new ParseError(
        "Early return 'when (...) =>' is rejected outside function context",
        ctx.previous().span,
      );
    }
    let hasIndent = false;
    if (ctx.match(TokenType.NEWLINE)) {
      hasIndent = ctx.match(TokenType.INDENT);
    }
    const earlyExpr = ctx.parseExpression();
    if (hasIndent) {
      ctx.skipNewlines();
      ctx.match(TokenType.DEDENT);
    }
    ctx.consumeNewlineOrEof();
    return {
      kind: "WhenStatement",
      condition,
      consequent: earlyExpr,
      isEarlyReturn: true,
      span: { start, end: earlyExpr.span.end },
    };
  }

  if (ctx.check(TokenType.LBRACE)) {
    ctx.consume(TokenType.LBRACE, "Expected '{'");
    const blockBody = ctx.parseBraceBlock();
    return {
      kind: "WhenStatement",
      condition,
      consequent: blockBody,
      isEarlyReturn: false,
      span: { start, end: blockBody.span.end },
    };
  }

  if (ctx.match(TokenType.NEWLINE)) {
    ctx.consume(TokenType.INDENT, "Expected indent for when block");
    const blockBody = ctx.parseIndentedBlock();
    return {
      kind: "WhenStatement",
      condition,
      consequent: blockBody,
      isEarlyReturn: false,
      span: { start, end: blockBody.span.end },
    };
  }

  throw new ParseError(
    "Expected '=>' or conditional block '{ ... }' after when condition",
    ctx.peek().span,
  );
}

export function parseEffectBlock(
  ctx: StatementParserContext,
): EffectBlockExpression {
  const start = ctx.previous().span.start;
  let unscoped = false;
  if (ctx.match(TokenType.LPAREN)) {
    if (ctx.check(TokenType.IDENTIFIER) && ctx.peek().value === "unscoped") {
      ctx.advance();
      unscoped = true;
    }
    ctx.consume(TokenType.RPAREN, "Expected ')' after effect options");
  }
  ctx.consume(
    TokenType.LBRACE,
    "Expected '{' after 'effect' (effect blocks require braces)",
  );
  ctx.parsingBraceEffect = true;
  ctx.enterScope();

  try {
    const body: EffectStatement[] = [];
    let finalExpression: Expression | undefined;

    const atEnd = () => ctx.check(TokenType.RBRACE);
    while (!atEnd() && !ctx.isAtEnd()) {
      ctx.skipNewlines();
      while (ctx.match(TokenType.INDENT) || ctx.match(TokenType.DEDENT)) {
        /* skip */
      }
      if (atEnd()) break;

      if (ctx.match(TokenType.ARROW)) {
        let hasIndent = false;
        if (ctx.match(TokenType.NEWLINE)) {
          hasIndent = ctx.match(TokenType.INDENT);
        }
        finalExpression = ctx.parseExpression();
        if (hasIndent) {
          ctx.skipNewlines();
          ctx.match(TokenType.DEDENT);
        }
        ctx.skipNewlines();
        while (ctx.match(TokenType.INDENT) || ctx.match(TokenType.DEDENT)) {
          /* skip */
        }
        if (!atEnd() && !ctx.isAtEnd()) {
          throw new ParseError(
            "Effect block return must be the final statement",
            finalExpression.span,
          );
        }
        break;
      } else if (ctx.check(TokenType.WHEN)) {
        body.push(ctx.parseWhenStatement());
      } else if (
        ctx.check(TokenType.UNDERSCORE) &&
        ctx.peekAhead(1).type === TokenType.LARROW
      ) {
        ctx.advance(); // consume '_'
        ctx.advance(); // consume '<-'
        let hasIndent = false;
        if (ctx.match(TokenType.NEWLINE)) {
          hasIndent = ctx.match(TokenType.INDENT);
        }
        const eff = ctx.parseExpression();
        if (hasIndent) {
          ctx.skipNewlines();
          ctx.match(TokenType.DEDENT);
        }
        ctx.consumeNewlineOrEof("Expected newline after discard bind");
        body.push({
          kind: "EffectDiscardStatement",
          effect: eff,
          span: { start: eff.span.start, end: eff.span.end },
        });
      } else if (
        (ctx.check(TokenType.IDENTIFIER) &&
          ctx.peekAhead(1).type === TokenType.LARROW) ||
        ctx.isDestructuringEffectBindStart()
      ) {
        const id =
          ctx.check(TokenType.LBRACE) || ctx.check(TokenType.LBRACKET)
            ? ctx.parseBindingPattern()
            : ctx.parseIdentifier();
        ctx.consume(TokenType.LARROW, "Expected '<-' in effect bind");
        let hasIndent = false;
        if (ctx.match(TokenType.NEWLINE)) {
          hasIndent = ctx.match(TokenType.INDENT);
        }
        const eff = ctx.parseExpression();
        if (hasIndent) {
          ctx.skipNewlines();
          ctx.match(TokenType.DEDENT);
        }
        ctx.consumeNewlineOrEof("Expected newline after effect bind");
        body.push({
          kind: "EffectBindStatement",
          id,
          effect: eff,
          span: { start: id.span.start, end: eff.span.end },
        });
      } else if (
        ctx.check(TokenType.IDENTIFIER) &&
        ctx.peekAhead(1).type === TokenType.EQ &&
        ctx.isMutableVariable(ctx.peek().value)
      ) {
        const target = ctx.parseIdentifier();
        ctx.consume(TokenType.EQ, "Expected '=' in assignment");
        let hasIndent = false;
        if (ctx.match(TokenType.NEWLINE)) {
          hasIndent = ctx.match(TokenType.INDENT);
        }
        const val = ctx.parseExpression();
        if (hasIndent) {
          ctx.skipNewlines();
          ctx.match(TokenType.DEDENT);
        }
        ctx.consumeNewlineOrEof();
        body.push({
          kind: "AssignmentStatement",
          target,
          value: val,
          span: { start: target.span.start, end: val.span.end },
        });
        ctx.skipNewlines();
        continue;
      } else if (
        ctx.check(TokenType.MUT) ||
        (ctx.check(TokenType.IDENTIFIER) &&
          (ctx.peekAhead(1).type === TokenType.EQ ||
            ctx.peekAhead(1).type === TokenType.COLON)) ||
        (ctx.check(TokenType.UNDERSCORE) &&
          ctx.peekAhead(1).type === TokenType.EQ) ||
        ctx.isDestructuringBindingStart()
      ) {
        if (ctx.check(TokenType.UNDERSCORE)) {
          const start = ctx.peek().span.start;
          ctx.advance(); // consume '_'
          ctx.advance(); // consume '='
          let hasIndent = false;
          if (ctx.match(TokenType.NEWLINE)) {
            hasIndent = ctx.match(TokenType.INDENT);
          }
          const discardExpr = ctx.parseExpression();
          if (hasIndent) {
            ctx.skipNewlines();
            ctx.match(TokenType.DEDENT);
          }
          ctx.consumeNewlineOrEof("Expected newline");
          body.push({
            kind: "BindingDeclaration",
            isMut: false,
            id: {
              kind: "Identifier",
              name: "_",
              span: { start, end: discardExpr.span.end },
            },
            init: discardExpr,
            span: { start, end: discardExpr.span.end },
          });
        } else {
          const bind = ctx.parseBindingDeclaration();
          body.push(bind);
        }
      } else {
        // Expression - must be the final line or control flow
        const expr = ctx.parseExpression();
        ctx.skipNewlines();
        while (ctx.match(TokenType.INDENT) || ctx.match(TokenType.DEDENT)) {
          /* skip */
        }
        if (atEnd()) {
          throw new ParseError(EFFECT_RETURN_DIAGNOSTIC, expr.span);
        } else {
          throw new ParseError(EFFECT_BARE_EXPR_DIAGNOSTIC, expr.span);
        }
      }
    }

    ctx.consume(TokenType.RBRACE, "Expected '}' to close effect block");
    ctx.parsingBraceEffect = false;

    if (!finalExpression) {
      throw new ParseError(EFFECT_RETURN_DIAGNOSTIC, {
        start,
        end: ctx.previous().span.end,
      });
    }

    return {
      kind: "EffectBlockExpression",
      body,
      finalExpression,
      unscoped,
      span: { start, end: finalExpression.span.end },
    };
  } finally {
    ctx.exitScope();
  }
}

export function parseParBlock(ctx: StatementParserContext): ParBlockExpression {
  ctx.enterScope();
  try {
    const start = ctx.previous().span.start;
    let concurrency: Expression | undefined;
    if (ctx.match(TokenType.LPAREN)) {
      if (
        ctx.check(TokenType.IDENTIFIER) &&
        ctx.peek().value === "concurrency" &&
        ctx.peekAhead(1).type === TokenType.EQ
      ) {
        ctx.advance(); // consume 'concurrency'
        ctx.advance(); // consume '='
        concurrency = ctx.parseExpression();
      } else if (!ctx.check(TokenType.RPAREN)) {
        concurrency = ctx.parseExpression();
      }
      ctx.consume(TokenType.RPAREN, "Expected ')' after par options");
    }

    const braced = ctx.match(TokenType.LBRACE);
    if (!braced) {
      ctx.consume(TokenType.NEWLINE, "Expected newline or '{' after 'par'");
      ctx.consume(TokenType.INDENT, "Expected indent after 'par'");
    }

    const body: EffectStatement[] = [];
    let finalExpression: Expression | undefined;
    let hasExplicitReturn = false;

    const atEnd = () =>
      braced ? ctx.check(TokenType.RBRACE) : ctx.check(TokenType.DEDENT);
    while (!atEnd() && !ctx.isAtEnd()) {
      ctx.skipNewlines();
      if (braced) {
        while (ctx.match(TokenType.INDENT) || ctx.match(TokenType.DEDENT)) {
          /* skip */
        }
      }
      if (atEnd()) break;

      if (ctx.match(TokenType.ARROW)) {
        finalExpression = ctx.parseExpression();
        hasExplicitReturn = true;
        ctx.skipNewlines();
        if (braced) {
          while (ctx.match(TokenType.INDENT) || ctx.match(TokenType.DEDENT)) {
            /* skip */
          }
        }
        if (!atEnd()) {
          throw new ParseError(
            "Par block return must be the final statement",
            finalExpression.span,
          );
        }
        break;
      } else if (ctx.check(TokenType.WHEN)) {
        const whenToken = ctx.advance();
        throw new ParseError(
          "Early return 'when (...) =>' is rejected inside 'par' blocks because it leaves sibling fibers in an ambiguous state",
          whenToken.span,
        );
      } else if (
        ctx.check(TokenType.UNDERSCORE) &&
        ctx.peekAhead(1).type === TokenType.LARROW
      ) {
        ctx.advance(); // consume '_'
        ctx.advance(); // consume '<-'
        const eff = ctx.parseExpression();
        ctx.consumeNewlineOrEof("Expected newline after discard bind");
        body.push({
          kind: "EffectDiscardStatement",
          effect: eff,
          span: { start: eff.span.start, end: eff.span.end },
        });
      } else if (
        (ctx.check(TokenType.IDENTIFIER) &&
          ctx.peekAhead(1).type === TokenType.LARROW) ||
        ctx.isDestructuringEffectBindStart()
      ) {
        const id =
          ctx.check(TokenType.LBRACE) || ctx.check(TokenType.LBRACKET)
            ? ctx.parseBindingPattern()
            : ctx.parseIdentifier();
        ctx.consume(TokenType.LARROW, "Expected '<-' in effect bind");
        const eff = ctx.parseExpression();
        ctx.consumeNewlineOrEof("Expected newline after effect bind");
        body.push({
          kind: "EffectBindStatement",
          id,
          effect: eff,
          span: { start: id.span.start, end: eff.span.end },
        });
      } else if (
        ctx.check(TokenType.IDENTIFIER) &&
        ctx.peekAhead(1).type === TokenType.EQ
      ) {
        const id = ctx.parseIdentifier();
        ctx.consume(TokenType.EQ, "Expected '=' in assignment");
        const value = ctx.parseExpression();
        ctx.consumeNewlineOrEof("Expected newline after assignment");
        body.push({
          kind: "BindingDeclaration",
          isMut: false,
          id,
          init: value,
          span: { start: id.span.start, end: value.span.end },
        });
      } else {
        const eff = ctx.parseExpression();
        ctx.consumeNewlineOrEof("Expected newline after effect statement");
        body.push({
          kind: "EffectDiscardStatement",
          effect: eff,
          span: { start: eff.span.start, end: eff.span.end },
        });
      }
    }

    if (braced) {
      ctx.consume(TokenType.RBRACE, "Expected '}' to close par block");
    } else {
      ctx.consume(TokenType.DEDENT, "Expected dedent to close par block");
    }

    const resolvedFinalExpression: Expression = finalExpression ?? {
      kind: "RecordExpression",
      entries: body.flatMap((s) => {
        if (s.kind !== "EffectBindStatement") return [];
        return ctx.collectPatternVariables(s.id).map((name) => ({
          kind: "ShorthandEntry" as const,
          key: { kind: "Identifier" as const, name, span: s.id.span },
          span: s.id.span,
        }));
      }),
      span: { start, end: ctx.previous().span.end },
    };

    return {
      kind: "ParBlockExpression",
      concurrency,
      body,
      finalExpression: resolvedFinalExpression,
      hasExplicitReturn,
      span: { start, end: resolvedFinalExpression.span.end },
    };
  } finally {
    ctx.exitScope();
  }
}

export function isBraceBlock(ctx: StatementParserContext): boolean {
  if (!ctx.check(TokenType.LBRACE)) return false;
  let i = 1;
  while (ctx.current + i < ctx.tokens.length) {
    const t = ctx.tokens[ctx.current + i].type;
    if (t === TokenType.NEWLINE || t === TokenType.INDENT) {
      i++;
    } else {
      break;
    }
  }
  if (ctx.current + i >= ctx.tokens.length) return false;
  const firstTok = ctx.tokens[ctx.current + i];
  if (firstTok.type === TokenType.DOTDOTDOT) return false;
  if (firstTok.type === TokenType.RBRACE) return false;
  if (
    firstTok.type === TokenType.WHEN ||
    firstTok.type === TokenType.MUT ||
    firstTok.type === TokenType.ARROW
  )
    return true;
  if (
    ctx.current + i + 1 < ctx.tokens.length &&
    ctx.tokens[ctx.current + i + 1].type === TokenType.EQ
  )
    return true;

  while (ctx.current + i < ctx.tokens.length) {
    const tok = ctx.tokens[ctx.current + i];
    if (tok.type === TokenType.RBRACE || tok.type === TokenType.DEDENT) break;
    if (tok.type === TokenType.ARROW) return true;
    if (tok.type === TokenType.WHEN || tok.type === TokenType.MUT) return true;
    if (tok.type === TokenType.DOTDOTDOT) return false;
    if (tok.type === TokenType.COLON) {
      let j = i + 1;
      let hasEq = false;
      while (ctx.current + j < ctx.tokens.length) {
        const t = ctx.tokens[ctx.current + j];
        if (
          t.type === TokenType.NEWLINE ||
          t.type === TokenType.COMMA ||
          t.type === TokenType.RBRACE ||
          t.type === TokenType.DEDENT
        )
          break;
        if (t.type === TokenType.EQ) {
          hasEq = true;
          break;
        }
        j++;
      }
      if (!hasEq) return false;
    }
    if (tok.type === TokenType.NEWLINE) break;
    i++;
  }
  return true;
}

export function isAssignmentStart(ctx: StatementParserContext): boolean {
  if (!ctx.check(TokenType.IDENTIFIER)) return false;
  let i = 1;
  let member = false;
  while (true) {
    const type = ctx.peekAhead(i).type;
    if (type === TokenType.DOT) {
      member = true;
      i += 2;
      continue;
    }
    if (type === TokenType.LBRACKET) {
      member = true;
      i++;
      let depth = 1;
      while (depth > 0 && ctx.peekAhead(i).type !== TokenType.EOF) {
        if (ctx.peekAhead(i).type === TokenType.LBRACKET) depth++;
        if (ctx.peekAhead(i).type === TokenType.RBRACKET) depth--;
        i++;
      }
      continue;
    }
    break;
  }
  return (
    ctx.peekAhead(i).type === TokenType.EQ &&
    (ctx.isMutableVariable(ctx.peek().value) ||
      (member && ctx.isMutDraftVariable(ctx.peek().value)))
  );
}

export function parseAssignmentTarget(
  ctx: StatementParserContext,
): Identifier | DotPathExpression | IndexExpression {
  const expr = ctx.parsePostfix();
  if (expr.kind === "Identifier") return expr;
  if (expr.kind === "IndexExpression") return expr;
  if (expr.kind === "MemberExpression") {
    const path: (Identifier | UpperIdentifier)[] = [];
    let current: Expression = expr;
    while (current.kind === "MemberExpression") {
      path.unshift(current.property);
      current = current.object;
    }
    if (current.kind === "Identifier" || current.kind === "UpperIdentifier") {
      path.unshift(current);
    }
    return { kind: "DotPathExpression", path, span: expr.span };
  }
  throw new ParseError("Invalid assignment target", expr.span);
}
