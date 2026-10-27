import { describe, it, expect, expectTypeOf } from "vitest";
import {
  Span,
  Position,
  NodeBase,
  Expression,
  BindingDeclaration,
  Identifier,
  UpperIdentifier,
  StringLiteral,
  BinaryExpression,
  JSXElement,
  JSXOpeningElement,
  JSXClosingElement,
  JSXSelfClosingElement,
  JSXAttribute,
  JSXExpressionContainer,
  JSXText,
  JSXChild,
  JSXTagName,
  JSXAttributeValue,
} from "../src/index.js";

describe("JSX AST Node Definitions", () => {
  const dummySpan: Span = {
    start: { line: 1, column: 1, offset: 0 },
    end: { line: 1, column: 10, offset: 9 },
  };

  const id = (name: string): Identifier => ({
    kind: "Identifier",
    name,
    span: dummySpan,
  });

  const upperId = (name: string): UpperIdentifier => ({
    kind: "UpperIdentifier",
    name,
    span: dummySpan,
  });

  const strLit = (value: string): StringLiteral => ({
    kind: "StringLiteral",
    parts: [{ kind: "StringRawPart", value }],
    raw: `"${value}"`,
    span: dummySpan,
  });

  describe("NodeBase conformance", () => {
    it("verifies all JSX node interfaces extend NodeBase", () => {
      const text: JSXText = {
        kind: "JSXText",
        value: "Hello, FunScript!",
        raw: "Hello, FunScript!",
        span: dummySpan,
      };

      const exprContainer: JSXExpressionContainer = {
        kind: "JSXExpressionContainer",
        expression: id("user"),
        span: dummySpan,
      };

      const attr: JSXAttribute = {
        kind: "JSXAttribute",
        name: id("className"),
        value: strLit("btn-primary"),
        span: dummySpan,
      };

      const opening: JSXOpeningElement = {
        kind: "JSXOpeningElement",
        name: id("button"),
        attributes: [attr],
        span: dummySpan,
      };

      const closing: JSXClosingElement = {
        kind: "JSXClosingElement",
        name: id("button"),
        span: dummySpan,
      };

      const element: JSXElement = {
        kind: "JSXElement",
        openingElement: opening,
        children: [text, exprContainer],
        closingElement: closing,
        span: dummySpan,
      };

      const selfClosing: JSXSelfClosingElement = {
        kind: "JSXSelfClosingElement",
        name: upperId("Avatar"),
        attributes: [attr],
        span: dummySpan,
      };

      expectTypeOf(text).toMatchTypeOf<NodeBase>();
      expectTypeOf(exprContainer).toMatchTypeOf<NodeBase>();
      expectTypeOf(attr).toMatchTypeOf<NodeBase>();
      expectTypeOf(opening).toMatchTypeOf<NodeBase>();
      expectTypeOf(closing).toMatchTypeOf<NodeBase>();
      expectTypeOf(element).toMatchTypeOf<NodeBase>();
      expectTypeOf(selfClosing).toMatchTypeOf<NodeBase>();

      expect(text.span).toEqual(dummySpan);
      expect(exprContainer.span).toEqual(dummySpan);
      expect(attr.span).toEqual(dummySpan);
      expect(opening.span).toEqual(dummySpan);
      expect(closing.span).toEqual(dummySpan);
      expect(element.span).toEqual(dummySpan);
      expect(selfClosing.span).toEqual(dummySpan);
    });
  });

  describe("Expression union compatibility", () => {
    it("allows JSXElement and JSXSelfClosingElement as Expression", () => {
      const selfClosing: JSXSelfClosingElement = {
        kind: "JSXSelfClosingElement",
        name: id("input"),
        attributes: [
          {
            kind: "JSXAttribute",
            name: id("disabled"),
            span: dummySpan,
          },
        ],
        span: dummySpan,
      };

      const element: JSXElement = {
        kind: "JSXElement",
        openingElement: {
          kind: "JSXOpeningElement",
          name: id("div"),
          attributes: [],
          span: dummySpan,
        },
        children: [selfClosing],
        closingElement: {
          kind: "JSXClosingElement",
          name: id("div"),
          span: dummySpan,
        },
        span: dummySpan,
      };

      // Type-level assertion
      expectTypeOf(element).toMatchTypeOf<Expression>();
      expectTypeOf(selfClosing).toMatchTypeOf<Expression>();

      // Runtime assignment to Expression type
      const expr1: Expression = element;
      const expr2: Expression = selfClosing;

      expect(expr1.kind).toBe("JSXElement");
      expect(expr2.kind).toBe("JSXSelfClosingElement");
    });

    it("allows JSX nodes in FunScript AST structures such as BindingDeclaration init", () => {
      const jsxNode: JSXElement = {
        kind: "JSXElement",
        openingElement: {
          kind: "JSXOpeningElement",
          name: upperId("MyComponent"),
          attributes: [
            {
              kind: "JSXAttribute",
              name: id("title"),
              value: strLit("Welcome"),
              span: dummySpan,
            },
          ],
          span: dummySpan,
        },
        children: [
          {
            kind: "JSXText",
            value: "Content here",
            span: dummySpan,
          },
        ],
        closingElement: {
          kind: "JSXClosingElement",
          name: upperId("MyComponent"),
          span: dummySpan,
        },
        span: dummySpan,
      };

      const binding: BindingDeclaration = {
        kind: "BindingDeclaration",
        isMut: false,
        id: id("view"),
        init: jsxNode,
        span: dummySpan,
      };

      expect(binding.init.kind).toBe("JSXElement");
      const initElement = binding.init as JSXElement;
      expect(initElement.openingElement.name.name).toBe("MyComponent");
      expect(initElement.children.length).toBe(1);
      expect((initElement.children[0] as JSXText).value).toBe("Content here");
    });
  });

  describe("JSXAttribute variations", () => {
    it("supports boolean attributes without a value", () => {
      const boolAttr: JSXAttribute = {
        kind: "JSXAttribute",
        name: id("required"),
        span: dummySpan,
      };

      expect(boolAttr.name.name).toBe("required");
      expect(boolAttr.value).toBeUndefined();
    });

    it("supports string literal attribute values", () => {
      const strAttr: JSXAttribute = {
        kind: "JSXAttribute",
        name: id("placeholder"),
        value: strLit("Enter email"),
        span: dummySpan,
      };

      expect(strAttr.value?.kind).toBe("StringLiteral");
    });

    it("supports JSXExpressionContainer attribute values with complex expressions", () => {
      const binaryExpr: BinaryExpression = {
        kind: "BinaryExpression",
        operator: "+",
        left: id("count"),
        right: {
          kind: "NumberLiteral",
          value: 1,
          raw: "1",
          span: dummySpan,
        },
        span: dummySpan,
      };

      const exprAttr: JSXAttribute = {
        kind: "JSXAttribute",
        name: id("count"),
        value: {
          kind: "JSXExpressionContainer",
          expression: binaryExpr,
          span: dummySpan,
        },
        span: dummySpan,
      };

      expect(exprAttr.value?.kind).toBe("JSXExpressionContainer");
      const container = exprAttr.value as JSXExpressionContainer;
      expect(container.expression.kind).toBe("BinaryExpression");
    });
  });

  describe("JSXChild union", () => {
    it("supports nested elements, self-closing elements, text, and expression containers as children", () => {
      const childText: JSXText = {
        kind: "JSXText",
        value: "Counter: ",
        span: dummySpan,
      };

      const childExpr: JSXExpressionContainer = {
        kind: "JSXExpressionContainer",
        expression: id("count"),
        span: dummySpan,
      };

      const childSelfClosing: JSXSelfClosingElement = {
        kind: "JSXSelfClosingElement",
        name: id("br"),
        attributes: [],
        span: dummySpan,
      };

      const childElement: JSXElement = {
        kind: "JSXElement",
        openingElement: {
          kind: "JSXOpeningElement",
          name: id("span"),
          attributes: [],
          span: dummySpan,
        },
        children: [childText],
        closingElement: {
          kind: "JSXClosingElement",
          name: id("span"),
          span: dummySpan,
        },
        span: dummySpan,
      };

      const children: JSXChild[] = [
        childText,
        childExpr,
        childSelfClosing,
        childElement,
      ];

      expect(children.length).toBe(4);
      expect(children.map((c) => c.kind)).toEqual([
        "JSXText",
        "JSXExpressionContainer",
        "JSXSelfClosingElement",
        "JSXElement",
      ]);
    });
  });
});
