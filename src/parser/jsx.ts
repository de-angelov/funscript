import type {
  Expression,
  Identifier,
  JSXAttribute,
  JSXAttributeValue,
  JSXChild,
  JSXClosingElement,
  JSXElement,
  JSXExpressionContainer,
  JSXOpeningElement,
  JSXSelfClosingElement,
  JSXTagName,
  UpperIdentifier,
} from "../ast/types.js";
import { TokenType, type Token } from "../lexer/tokens.js";
import { ParseError } from "./errors.js";
import type { Parser } from "./parser.js";

export type JsxParserContext = Parser;

export function parseJsxElement(
  ctx: JsxParserContext,
): JSXElement | JSXSelfClosingElement {
  const start = ctx.consume(TokenType.JSX_TAG_OPEN, "Expected '<'").span.start;
  const tagName = parseJsxTagName(ctx);

  const attributes: JSXAttribute[] = [];
  while (
    !ctx.check(TokenType.JSX_TAG_CLOSE) &&
    !ctx.check(TokenType.JSX_SLASH_CLOSE) &&
    !ctx.isAtEnd()
  ) {
    ctx.skipNewlines();
    if (
      ctx.check(TokenType.JSX_TAG_CLOSE) ||
      ctx.check(TokenType.JSX_SLASH_CLOSE)
    ) {
      break;
    }
    attributes.push(parseJsxAttribute(ctx));
    ctx.skipNewlines();
  }

  if (ctx.match(TokenType.JSX_SLASH_CLOSE)) {
    const slashClose = ctx.previous();
    return {
      kind: "JSXSelfClosingElement",
      name: tagName,
      attributes,
      span: { start, end: slashClose.span.end },
    };
  }

  const tagClose = ctx.consume(
    TokenType.JSX_TAG_CLOSE,
    "Expected '>' or '/>' after JSX attributes",
  );
  const openingElement: JSXOpeningElement = {
    kind: "JSXOpeningElement",
    name: tagName,
    attributes,
    span: { start, end: tagClose.span.end },
  };

  const children: JSXChild[] = [];
  while (!ctx.check(TokenType.JSX_CLOSING_TAG_OPEN) && !ctx.isAtEnd()) {
    if (ctx.check(TokenType.JSX_TAG_OPEN)) {
      children.push(parseJsxElement(ctx));
    } else if (ctx.check(TokenType.LBRACE)) {
      children.push(parseJsxExpressionContainer(ctx));
    } else if (ctx.check(TokenType.JSX_TEXT)) {
      const textTok = ctx.advance();
      const raw = textTok.value;
      // Skip whitespace-only formatting lines between tags
      if (/^\s*[\r\n]\s*$/.test(raw)) {
        continue;
      }
      // Normalize leading and trailing newlines from multiline text, preserving inline spacing
      const value = raw
        .replace(/^\s*[\r\n]+\s*/, "")
        .replace(/\s*[\r\n]+\s*$/, "");
      children.push({
        kind: "JSXText",
        value,
        raw,
        span: textTok.span,
      });
    } else {
      throw new ParseError(
        `Unexpected token '${ctx.peek().value}' in JSX children`,
        ctx.peek().span,
      );
    }
  }

  const closingStart = ctx.consume(
    TokenType.JSX_CLOSING_TAG_OPEN,
    `Expected closing tag for <${formatTagName(tagName)}>`,
  ).span.start;
  const closingName = parseJsxTagName(ctx);
  const closingGt = ctx.consume(
    TokenType.JSX_TAG_CLOSE,
    "Expected '>' to close tag",
  );

  if (!areTagNamesEqual(tagName, closingName)) {
    throw new ParseError(
      `Expected closing tag </${formatTagName(tagName)}>, found </${formatTagName(closingName)}>`,
      closingName.span,
    );
  }

  const closingElement: JSXClosingElement = {
    kind: "JSXClosingElement",
    name: closingName,
    span: { start: closingStart, end: closingGt.span.end },
  };

  return {
    kind: "JSXElement",
    openingElement,
    children,
    closingElement,
    span: { start: openingElement.span.start, end: closingElement.span.end },
  };
}

function parseJsxTagName(ctx: JsxParserContext): JSXTagName {
  if (ctx.check(TokenType.JSX_TAG_CLOSE)) {
    // Empty fragment tag (<> or </>)
    const pos = ctx.peek().span.start;
    return {
      kind: "Identifier",
      name: "",
      span: { start: pos, end: pos },
    };
  }

  if (
    !ctx.check(TokenType.IDENTIFIER) &&
    !ctx.check(TokenType.UPPER_IDENTIFIER)
  ) {
    throw new ParseError(
      `Expected JSX tag name, found '${ctx.peek().value}'`,
      ctx.peek().span,
    );
  }

  let name: JSXTagName = ctx.parseAnyIdentifier();
  while (ctx.match(TokenType.DOT)) {
    const prop = ctx.parsePropertyIdentifier();
    name = {
      kind: "MemberExpression",
      object: name as Expression,
      property: prop,
      span: { start: name.span.start, end: prop.span.end },
    };
  }
  return name;
}

function parseJsxAttribute(ctx: JsxParserContext): JSXAttribute {
  if (ctx.match(TokenType.LBRACE)) {
    const start = ctx.previous().span.start;
    ctx.consume(TokenType.DOTDOTDOT, "Expected '...' in JSX spread attribute");
    const argument = ctx.parseExpression();
    const end = ctx.consume(TokenType.RBRACE, "Expected '}' after JSX spread")
      .span.end;
    return { kind: "JSXSpreadAttribute", argument, span: { start, end } };
  }
  let nameTok: Token;
  if (ctx.check(TokenType.JSX_ATTRIBUTE_NAME)) {
    nameTok = ctx.advance();
  } else if (
    ctx.check(TokenType.IDENTIFIER) ||
    ctx.check(TokenType.UPPER_IDENTIFIER)
  ) {
    nameTok = ctx.advance();
  } else {
    throw new ParseError(
      `Expected attribute name, found '${ctx.peek().value}'`,
      ctx.peek().span,
    );
  }

  const nameNode: Identifier | UpperIdentifier =
    nameTok.type === TokenType.UPPER_IDENTIFIER
      ? { kind: "UpperIdentifier", name: nameTok.value, span: nameTok.span }
      : { kind: "Identifier", name: nameTok.value, span: nameTok.span };

  if (ctx.match(TokenType.EQ)) {
    let value: JSXAttributeValue;
    if (ctx.check(TokenType.STRING) || ctx.check(TokenType.STRING_PART)) {
      value = ctx.parseStringLiteral();
    } else if (ctx.check(TokenType.LBRACE)) {
      value = parseJsxExpressionContainer(ctx);
    } else {
      throw new ParseError(
        `Expected attribute value (string or expression container), found '${ctx.peek().value}'`,
        ctx.peek().span,
      );
    }
    return {
      kind: "JSXAttribute",
      name: nameNode,
      value,
      span: { start: nameNode.span.start, end: value.span.end },
    };
  }

  return {
    kind: "JSXAttribute",
    name: nameNode,
    span: nameNode.span,
  };
}

function parseJsxExpressionContainer(
  ctx: JsxParserContext,
): JSXExpressionContainer {
  const start = ctx.consume(TokenType.LBRACE, "Expected '{'").span.start;
  ctx.skipNewlines();
  const hasIndent = ctx.match(TokenType.INDENT);
  ctx.skipNewlines();
  const expression = ctx.parseExpression();
  ctx.skipNewlines();
  if (hasIndent) {
    ctx.match(TokenType.DEDENT);
    ctx.skipNewlines();
  }
  const end = ctx.consume(TokenType.RBRACE, "Expected '}' after JSX expression")
    .span.end;
  return {
    kind: "JSXExpressionContainer",
    expression,
    span: { start, end },
  };
}

function formatTagName(name: JSXTagName): string {
  if (name.kind === "Identifier" || name.kind === "UpperIdentifier") {
    return name.name;
  }
  if (name.kind === "MemberExpression") {
    const obj = formatTagName(name.object as JSXTagName);
    return `${obj}.${name.property.name}`;
  }
  return "";
}

function areTagNamesEqual(a: JSXTagName, b: JSXTagName): boolean {
  return formatTagName(a) === formatTagName(b);
}
