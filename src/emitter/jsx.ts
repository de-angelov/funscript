import type {
  Expression,
  JSXAttribute,
  JSXChild,
  JSXElement,
  JSXExpressionContainer,
  JSXSelfClosingElement,
  JSXTagName,
  JSXText,
  StringLiteral,
} from "../ast/types.js";

export interface JsxEmitterContext {
  emitExpression(expr: Expression): string;
  emitStringLiteral(lit: StringLiteral): string;
  options: {
    forwardNullProperties?: ReadonlySet<number>;
    forwardOptionalProperties?: ReadonlySet<number>;
    markCallArguments?: boolean;
    isJsx?: boolean;
  };
  addEffectImport(name: string): void;
}

export function emitJsxTagName(name: JSXTagName): string {
  switch (name.kind) {
    case "Identifier":
    case "UpperIdentifier":
      return name.name;
    case "MemberExpression":
      return `${emitJsxTagName(name.object as JSXTagName)}.${name.property.name}`;
    default:
      return "";
  }
}

export function emitJsxAttribute(
  ctx: JsxEmitterContext,
  attr: JSXAttribute,
): string {
  if (attr.kind === "JSXSpreadAttribute")
    return `{...${ctx.emitExpression(attr.argument)}}`;
  const name = attr.name.name;
  if (attr.value === undefined) {
    return name;
  }
  if (attr.value.kind === "StringLiteral") {
    const isSimple = attr.value.parts.every((p) => p.kind === "StringRawPart");
    if (isSimple) {
      const rawVal = attr.value.parts.map((p) => (p as any).value).join("");
      return `${name}=${JSON.stringify(rawVal)}`;
    }
    return `${name}={${ctx.emitStringLiteral(attr.value)}}`;
  }
  if (attr.value.kind === "JSXExpressionContainer") {
    const expression = attr.value.expression;
    const value = ctx.emitExpression(expression);
    if (ctx.options.forwardNullProperties?.has(expression.span.start.offset)) {
      ctx.addEffectImport("Option");
      return `${name}={Option.getOrNull(${value})}`;
    }
    if (
      ctx.options.forwardOptionalProperties?.has(expression.span.start.offset)
    ) {
      ctx.addEffectImport("Option");
      return `{...((__value: import("effect").Option.Option<any>) => Option.isSome(__value) ? { [${JSON.stringify(name)}]: __value.value } : {})(${value})}`;
    }
    return `${name}={${ctx.options.markCallArguments ? `__funscriptCallArgument(${expression.span.start.offset}, ${value})` : value}}`;
  }
  return `${name}={${ctx.emitExpression(attr.value)}}`;
}

export function emitJsxExpressionContainer(
  ctx: JsxEmitterContext,
  container: JSXExpressionContainer,
): string {
  return `{${ctx.emitExpression(container.expression)}}`;
}

export function emitJsxText(text: JSXText): string {
  return text.value;
}

export function emitJsxChild(ctx: JsxEmitterContext, child: JSXChild): string {
  switch (child.kind) {
    case "JSXText":
      return emitJsxText(child);
    case "JSXExpressionContainer":
      return emitJsxExpressionContainer(ctx, child);
    case "JSXElement":
      return emitJsxElement(ctx, child);
    case "JSXSelfClosingElement":
      return emitJsxSelfClosingElement(ctx, child);
  }
}

export function emitJsxElement(ctx: JsxEmitterContext, el: JSXElement): string {
  const tagName = emitJsxTagName(el.openingElement.name);
  const attrs = el.openingElement.attributes
    .map((a) => emitJsxAttribute(ctx, a))
    .join(" ");
  const attrsStr = attrs.length > 0 ? ` ${attrs}` : "";
  const openTag = tagName === "" ? "<>" : `<${tagName}${attrsStr}>`;
  const closeTag = tagName === "" ? "</>" : `</${tagName}>`;
  const childrenStr = el.children.map((c) => emitJsxChild(ctx, c)).join("");
  return `${openTag}${childrenStr}${closeTag}`;
}

export function emitJsxSelfClosingElement(
  ctx: JsxEmitterContext,
  el: JSXSelfClosingElement,
): string {
  const tagName = emitJsxTagName(el.name);
  const attrs = el.attributes.map((a) => emitJsxAttribute(ctx, a)).join(" ");
  const attrsStr = attrs.length > 0 ? ` ${attrs}` : "";
  if (tagName === "") {
    return `<${attrsStr} />`;
  }
  return `<${tagName}${attrsStr} />`;
}
