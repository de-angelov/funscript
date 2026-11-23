import type {
  BindingTarget,
  EffectTypeNode,
  Expression,
  FunctionExpression,
  FunctionTypeNode,
  Identifier,
  Parameter,
  RecordPattern,
  ArrayPattern,
  Pattern,
  RecordTypeField,
  RecordTypeNode,
  Span,
  TypeNode,
  TypeParameter,
  UpperIdentifier,
} from "../ast/types.js";
import { ParseError } from "./errors.js";
import { TokenType, type Token } from "../lexer/tokens.js";
import type { Parser } from "./parser.js";

export type TypesParserContext = Parser;

export function parseTypeNode(ctx: TypesParserContext): TypeNode {
  return parseUnionType(ctx);
}

export function parseUnionType(ctx: TypesParserContext): TypeNode {
  const first = parseIntersectionType(ctx);
  if (!ctx.check(TokenType.BAR)) return first;

  const types: TypeNode[] = [first];
  while (ctx.match(TokenType.BAR)) {
    types.push(parseIntersectionType(ctx));
  }
  return {
    kind: "UnionTypeNode",
    types,
    span: { start: first.span.start, end: types[types.length - 1].span.end },
  };
}

export function parseIntersectionType(ctx: TypesParserContext): TypeNode {
  const first = parseFunctionTypeNode(ctx);
  if (!ctx.check(TokenType.AMP)) return first;

  const types: TypeNode[] = [first];
  while (ctx.match(TokenType.AMP)) {
    types.push(parseFunctionTypeNode(ctx));
  }
  return {
    kind: "IntersectionTypeNode",
    types,
    span: { start: first.span.start, end: types[types.length - 1].span.end },
  };
}

export function parseFunctionTypeNode(ctx: TypesParserContext): TypeNode {
  const start = ctx.peek().span.start;
  let typeParams: TypeParameter[] | undefined;
  if (ctx.check(TokenType.LT) && isGenericCallableStart(ctx)) {
    typeParams = parseTypeParameters(ctx);
  }
  if (ctx.check(TokenType.LPAREN)) {
    const isFunctionType =
      typeParams !== undefined ||
      (ctx.peekAhead(1).type === TokenType.RPAREN &&
        ctx.peekAhead(2).type === TokenType.ARROW) ||
      ctx.peekAhead(1).type === TokenType.DOTDOTDOT ||
      (ctx.peekAhead(1).type === TokenType.IDENTIFIER &&
        (ctx.peekAhead(2).type === TokenType.COLON ||
          (ctx.peekAhead(2).type === TokenType.QUESTION &&
            ctx.peekAhead(3).type === TokenType.COLON)));

    if (isFunctionType) {
      ctx.advance(); // consume '('
      const params: Parameter[] = [];
      if (!ctx.check(TokenType.RPAREN)) {
        do {
          let isRest = false;
          let dotSpan: Span | undefined;
          if (ctx.match(TokenType.DOTDOTDOT)) {
            isRest = true;
            dotSpan = ctx.previous().span;
          }
          let pTarget: BindingTarget;
          if (ctx.check(TokenType.LBRACE) || ctx.check(TokenType.LBRACKET)) {
            pTarget = ctx.parseBindingPattern();
          } else {
            pTarget = ctx.parseIdentifier();
          }
          const optional = ctx.match(TokenType.QUESTION);
          ctx.consume(TokenType.COLON, "Expected ':' after param name");
          const pType = parseTypeNode(ctx);
          params.push({
            kind: "Parameter",
            name: pTarget,
            typeAnnotation: pType,
            optional: optional ? true : undefined,
            isRest: isRest ? true : undefined,
            span: {
              start: dotSpan ? dotSpan.start : pTarget.span.start,
              end: pType.span.end,
            },
          });
        } while (ctx.match(TokenType.COMMA) && !ctx.check(TokenType.RPAREN));
      }
      ctx.consume(TokenType.RPAREN, "Expected ')'");
      ctx.validateValueParameters(params);
      if (!ctx.match(TokenType.ARROW)) {
        throw new ParseError("Expected '=>' in function type", ctx.peek().span);
      }
      const ret = parseTypeNode(ctx);
      return {
        kind: "FunctionTypeNode",
        typeParams,
        params,
        returnType: ret,
        span: { start, end: ret.span.end },
      };
    } else {
      const pStart = ctx.advance().span.start; // consume '('
      const inner = parseTypeNode(ctx);
      const pEnd = ctx.consume(TokenType.RPAREN, "Expected ')'").span.end;
      let resultType: TypeNode = {
        kind: "ParenthesizedTypeNode",
        typeNode: inner,
        span: { start: pStart, end: pEnd },
      };
      while (ctx.match(TokenType.LBRACKET)) {
        const indexType = parseTypeNode(ctx);
        const bracketEnd = ctx.consume(
          TokenType.RBRACKET,
          "Expected ']' after index type",
        ).span.end;
        resultType = {
          kind: "IndexedAccessTypeNode",
          objectType: resultType,
          indexType,
          span: { start: resultType.span.start, end: bracketEnd },
        };
      }
      return resultType;
    }
  }

  if (typeParams) {
    throw new ParseError(
      "Expected '(' after generic type parameters",
      ctx.peek().span,
    );
  }
  return parsePrimaryType(ctx);
}

export function parsePrimaryType(ctx: TypesParserContext): TypeNode {
  if (
    ctx.match(
      TokenType.STRING,
      TokenType.NUMBER,
      TokenType.TRUE,
      TokenType.FALSE,
    )
  ) {
    const token = ctx.previous();
    const value =
      token.type === TokenType.STRING
        ? token.value
        : token.type === TokenType.NUMBER
          ? Number(token.value)
          : token.type === TokenType.TRUE;
    return { kind: "LiteralTypeNode", value, span: token.span };
  }
  if (ctx.match(TokenType.LBRACE)) {
    const start = ctx.previous().span.start;
    const fields: RecordTypeField[] = [];
    ctx.recordTypeDepth++;
    try {
      ctx.skipNewlines();
      const hasIndent = ctx.match(TokenType.INDENT);
      while (
        !ctx.check(TokenType.RBRACE) &&
        !ctx.check(TokenType.DEDENT) &&
        !ctx.isAtEnd()
      ) {
        ctx.skipNewlines();
        if (ctx.check(TokenType.RBRACE) || ctx.check(TokenType.DEDENT)) {
          break;
        }
        const fName: Identifier = ctx.parseRecordKeyIdentifier();
        const optional = ctx.match(TokenType.QUESTION);
        ctx.consume(TokenType.COLON, "Expected ':' after field name");
        const fType = parseTypeNode(ctx);
        const defaultValue = ctx.match(TokenType.EQ)
          ? ctx.parseExpression()
          : undefined;
        if (
          defaultValue &&
          (!ctx.allowOptionalRecordFields || ctx.recordTypeDepth !== 1)
        ) {
          throw new ParseError(
            "Defaulted record fields are supported only on direct function parameters",
            fName.span,
          );
        }
        if (optional && defaultValue) {
          throw new ParseError(
            "A record field cannot be both optional and defaulted",
            fName.span,
          );
        }
        fields.push({
          kind: "RecordTypeField",
          name: fName,
          typeAnnotation: fType,
          optional,
          defaultValue,
          span: {
            start: fName.span.start,
            end: (defaultValue ?? fType).span.end,
          },
        });
        ctx.match(TokenType.COMMA);
        ctx.skipNewlines();
      }
      if (hasIndent) {
        ctx.consume(TokenType.DEDENT, "Expected unindent in record type");
      }
      ctx.skipNewlines();
      const end = ctx.consume(TokenType.RBRACE, "Expected '}'").span.end;
      return { kind: "RecordTypeNode", fields, span: { start, end } };
    } finally {
      ctx.recordTypeDepth--;
    }
  }

  // TS escape hatch for types: ts { Record<string, unknown> }
  if (ctx.match(TokenType.TS)) {
    const start = ctx.previous().span.start;
    const code = ctx.consumeTsCode();
    return {
      kind: "TsEscapeTypeNode",
      code: code.value,
      span: { start, end: code.span.end },
    };
  }

  if (
    ctx.check(TokenType.UPPER_IDENTIFIER) &&
    ctx.peek().value === "Effect" &&
    ctx.peekAhead(1).type === TokenType.LT
  ) {
    return parseEffectTypeNode(ctx);
  }

  if (ctx.check(TokenType.IDENTIFIER) && ctx.peek().value === "typeof") {
    const start = ctx.advance().span.start;
    let expr: Expression = ctx.parsePrimary();
    while (ctx.match(TokenType.DOT)) {
      const prop = ctx.parsePropertyIdentifier();
      expr = {
        kind: "MemberExpression",
        object: expr,
        property: prop,
        span: { start: expr.span.start, end: prop.span.end },
      };
    }
    let resultType: TypeNode = {
      kind: "TypeQueryNode",
      expr,
      span: { start, end: expr.span.end },
    };
    while (ctx.match(TokenType.LBRACKET)) {
      const indexType = parseTypeNode(ctx);
      const bracketEnd = ctx.consume(
        TokenType.RBRACKET,
        "Expected ']' after index type",
      ).span.end;
      resultType = {
        kind: "IndexedAccessTypeNode",
        objectType: resultType,
        indexType,
        span: { start: resultType.span.start, end: bracketEnd },
      };
    }
    return resultType;
  }

  if (!ctx.check(TokenType.UPPER_IDENTIFIER)) {
    throw new ParseError(
      "Type names must begin with an uppercase letter (for example String or Number); use ts for TypeScript types",
      ctx.peek().span,
    );
  }
  const typeId = ctx.parseUpperIdentifier();
  const parts: (Identifier | UpperIdentifier)[] = [typeId];
  while (ctx.match(TokenType.DOT)) {
    parts.push(ctx.parsePropertyIdentifier());
  }
  let typeArgs: TypeNode[] | undefined;

  if (ctx.match(TokenType.LT)) {
    typeArgs = [];
    do {
      typeArgs.push(parseTypeNode(ctx));
    } while (ctx.match(TokenType.COMMA) && !ctx.check(TokenType.GT));
    ctx.consume(TokenType.GT, "Expected '>' after type arguments");
  }

  let resultType: TypeNode =
    parts.length > 1
      ? {
          kind: "QualifiedTypeReferenceNode",
          parts,
          typeArgs,
          span: { start: typeId.span.start, end: ctx.previous().span.end },
        }
      : {
          kind: "TypeReferenceNode",
          name: typeId,
          typeArgs,
          span: { start: typeId.span.start, end: ctx.previous().span.end },
        };

  while (ctx.match(TokenType.LBRACKET)) {
    const indexType = parseTypeNode(ctx);
    const bracketEnd = ctx.consume(
      TokenType.RBRACKET,
      "Expected ']' after index type",
    ).span.end;
    resultType = {
      kind: "IndexedAccessTypeNode",
      objectType: resultType,
      indexType,
      span: { start: resultType.span.start, end: bracketEnd },
    };
  }
  return resultType;
}

export function parseEffectTypeNode(ctx: TypesParserContext): EffectTypeNode {
  const start = ctx.advance().span.start; // consume 'Effect'
  ctx.consume(TokenType.LT, "Expected '<' after Effect");
  const success = parseTypeNode(ctx);
  let error: TypeNode | undefined;
  let requirements: TypeNode | undefined;

  if (ctx.match(TokenType.COMMA)) {
    error = parseTypeNode(ctx);
    if (ctx.match(TokenType.COMMA)) {
      requirements = parseTypeNode(ctx);
    }
  }

  ctx.consume(TokenType.GT, "Expected '>' after Effect type args");

  return {
    kind: "EffectTypeNode",
    success,
    error,
    requirements,
    span: { start, end: ctx.previous().span.end },
  };
}

export function parseGenericFunctionExpression(
  ctx: TypesParserContext,
): FunctionExpression {
  const start = ctx.peek().span.start;
  const typeParams = parseTypeParameters(ctx);
  const expression = ctx.parsePrimary();
  if (expression.kind !== "FunctionExpression") {
    throw new ParseError(
      "Expected a function after generic type parameters",
      expression.span,
    );
  }
  if (expression.typeParams?.length) {
    throw new ParseError(
      "Generic type parameters may be declared only once",
      typeParams[0].span,
    );
  }
  expression.typeParams = typeParams;
  expression.span = { start, end: expression.span.end };
  return expression;
}

export function isGenericCallableStart(ctx: TypesParserContext): boolean {
  if (!ctx.check(TokenType.LT)) return false;

  let angleDepth = 1;
  for (let i = 1; i < 512; i++) {
    const token = ctx.peekAhead(i);
    if (token.type === TokenType.EOF || token.type === TokenType.NEWLINE) {
      return false;
    }
    if (token.type === TokenType.LT) {
      angleDepth++;
    } else if (token.type === TokenType.GT) {
      angleDepth--;
      if (angleDepth === 0) {
        if (ctx.peekAhead(i + 1).type !== TokenType.LPAREN) return false;
        let parenDepth = 1;
        for (let j = i + 2; j < 1024; j++) {
          const param = ctx.peekAhead(j);
          if (
            param.type === TokenType.EOF ||
            param.type === TokenType.NEWLINE
          ) {
            return false;
          }
          if (param.type === TokenType.LPAREN) {
            parenDepth++;
          } else if (param.type === TokenType.RPAREN) {
            parenDepth--;
            if (parenDepth === 0) {
              return (
                ctx.peekAhead(j + 1).type === TokenType.ARROW ||
                ctx.peekAhead(j + 1).type === TokenType.COLON
              );
            }
          }
        }
        return false;
      }
    }
  }
  return false;
}

export function parseTypeParameters(ctx: TypesParserContext): TypeParameter[] {
  ctx.consume(TokenType.LT, "Expected '<'");
  const params: TypeParameter[] = [];
  do {
    const id = ctx.parseUpperIdentifier();
    let constraint: TypeNode | undefined;
    if (ctx.check(TokenType.IDENTIFIER) && ctx.peek().value === "extends") {
      ctx.advance();
      constraint = parseTypeNode(ctx);
    }
    params.push({
      kind: "TypeParameter",
      name: id,
      constraint,
      span: {
        start: id.span.start,
        end: constraint?.span.end ?? id.span.end,
      },
    });
  } while (ctx.match(TokenType.COMMA) && !ctx.check(TokenType.GT));
  ctx.consume(TokenType.GT, "Expected '>'");
  return params;
}
