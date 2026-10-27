import { describe, it, expect } from "vitest";
import { Lexer } from "../src/lexer/lexer.js";
import { Parser, ParseError } from "../src/parser/parser.js";
import {
  Program,
  BindingDeclaration,
  FunctionExpression,
  BlockStatement,
  JSXElement,
  JSXSelfClosingElement,
  JSXText,
  JSXExpressionContainer,
  JSXAttribute,
  StringLiteral,
  BinaryExpression,
  PipelineExpression,
  MemberExpression,
  MatchExpression,
  Identifier,
  UpperIdentifier,
} from "../src/index.js";

function parse(source: string, filename = "test.funx"): Program {
  const lexer = new Lexer(source, filename);
  const parser = new Parser(lexer.tokenize(), filename);
  return parser.parse();
}

function parseJsx(source: string, filename = "test.funx"): JSXElement | JSXSelfClosingElement {
  const lexer = new Lexer(source, filename);
  const parser = new Parser(lexer.tokenize(), filename);
  return parser.parseJsxElement();
}

describe("JSX Parser (.funx mode)", () => {
  describe("Self-closing elements", () => {
    it("parses lowercase self-closing element", () => {
      const el = parseJsx("<br />") as JSXSelfClosingElement;

      expect(el.kind).toBe("JSXSelfClosingElement");
      expect(el.name.kind).toBe("Identifier");
      expect((el.name as Identifier).name).toBe("br");
      expect(el.attributes).toEqual([]);
      expect(el.span.start.line).toBe(1);
    });

    it("parses uppercase component self-closing element", () => {
      const el = parseJsx("<Avatar />") as JSXSelfClosingElement;

      expect(el.kind).toBe("JSXSelfClosingElement");
      expect(el.name.kind).toBe("UpperIdentifier");
      expect((el.name as UpperIdentifier).name).toBe("Avatar");
      expect(el.attributes).toEqual([]);
    });

    it("parses member access component self-closing element", () => {
      const el = parseJsx("<Icons.Close size={24} />") as JSXSelfClosingElement;

      expect(el.kind).toBe("JSXSelfClosingElement");
      expect(el.name.kind).toBe("MemberExpression");
      const member = el.name as MemberExpression;
      expect((member.object as UpperIdentifier).name).toBe("Icons");
      expect(member.property.name).toBe("Close");
      expect(el.attributes.length).toBe(1);
      expect(el.attributes[0].name.name).toBe("size");
    });
  });

  describe("Elements with text children", () => {
    it("parses element with raw text content and matching closing tag", () => {
      const el = parseJsx("<div>Hello, FunScript!</div>") as JSXElement;

      expect(el.kind).toBe("JSXElement");
      expect(el.openingElement.kind).toBe("JSXOpeningElement");
      expect((el.openingElement.name as Identifier).name).toBe("div");
      expect(el.children.length).toBe(1);

      const text = el.children[0] as JSXText;
      expect(text.kind).toBe("JSXText");
      expect(text.value).toBe("Hello, FunScript!");
      expect(text.raw).toBe("Hello, FunScript!");

      expect(el.closingElement.kind).toBe("JSXClosingElement");
      expect((el.closingElement.name as Identifier).name).toBe("div");
    });

    it("parses multiline text inside element and normalizes boundary newlines", () => {
      const code = `<div>
  Welcome to FunScript UI components!
</div>`;
      const el = parseJsx(code) as JSXElement;

      expect(el.kind).toBe("JSXElement");
      expect(el.children.length).toBe(1);
      const text = el.children[0] as JSXText;
      expect(text.value).toBe("Welcome to FunScript UI components!");
    });
  });

  describe("Nested JSX elements", () => {
    it("parses nested elements inline", () => {
      const el = parseJsx("<div><span>Inner Text</span></div>") as JSXElement;

      expect(el.children.length).toBe(1);
      const childEl = el.children[0] as JSXElement;
      expect(childEl.kind).toBe("JSXElement");
      expect((childEl.openingElement.name as Identifier).name).toBe("span");
      expect(childEl.children.length).toBe(1);
      expect((childEl.children[0] as JSXText).value).toBe("Inner Text");
    });

    it("parses nested sibling elements across multiple lines", () => {
      const code = `<ul>
  <li>Item 1</li>
  <li>Item 2</li>
  <li>Item 3</li>
</ul>`;
      const el = parseJsx(code) as JSXElement;

      expect(el.children.length).toBe(3);
      for (let i = 0; i < 3; i++) {
        const item = el.children[i] as JSXElement;
        expect(item.kind).toBe("JSXElement");
        expect((item.openingElement.name as Identifier).name).toBe("li");
        expect((item.children[0] as JSXText).value).toBe(`Item ${i + 1}`);
      }
    });

    it("parses mixed nested elements, self-closing elements, and text", () => {
      const code = `<div>
  <p>Paragraph text<br /></p>
  <Footer />
</div>`;
      const el = parseJsx(code) as JSXElement;

      expect(el.children.length).toBe(2);
      const p = el.children[0] as JSXElement;
      expect(p.kind).toBe("JSXElement");
      expect(p.children.length).toBe(2);
      expect((p.children[0] as JSXText).value).toBe("Paragraph text");
      expect(p.children[1].kind).toBe("JSXSelfClosingElement");

      const footer = el.children[1] as JSXSelfClosingElement;
      expect(footer.kind).toBe("JSXSelfClosingElement");
      expect((footer.name as UpperIdentifier).name).toBe("Footer");
    });
  });

  describe("JSX Attributes", () => {
    it("parses boolean attributes without value", () => {
      const el = parseJsx("<button disabled autofocus />") as JSXSelfClosingElement;

      expect(el.attributes.length).toBe(2);
      expect(el.attributes[0].name.name).toBe("disabled");
      expect(el.attributes[0].value).toBeUndefined();

      expect(el.attributes[1].name.name).toBe("autofocus");
      expect(el.attributes[1].value).toBeUndefined();
    });

    it("parses string literal attributes", () => {
      const el = parseJsx('<div className="btn-primary" id="main" />') as JSXSelfClosingElement;

      expect(el.attributes.length).toBe(2);
      const attr1 = el.attributes[0];
      expect(attr1.name.name).toBe("className");
      expect(attr1.value?.kind).toBe("StringLiteral");
      expect((attr1.value as StringLiteral).parts[0]).toEqual({
        kind: "StringRawPart",
        value: "btn-primary",
      });

      const attr2 = el.attributes[1];
      expect(attr2.name.name).toBe("id");
      expect((attr2.value as StringLiteral).parts[0]).toEqual({
        kind: "StringRawPart",
        value: "main",
      });
    });

    it("parses expression container attributes", () => {
      const el = parseJsx("<button count={x + 1} onClick={handleClick}>Submit</button>") as JSXElement;

      expect(el.openingElement.attributes.length).toBe(2);

      const countAttr = el.openingElement.attributes[0];
      expect(countAttr.name.name).toBe("count");
      expect(countAttr.value?.kind).toBe("JSXExpressionContainer");
      const countExpr = (countAttr.value as JSXExpressionContainer).expression as BinaryExpression;
      expect(countExpr.kind).toBe("BinaryExpression");
      expect(countExpr.operator).toBe("+");

      const clickAttr = el.openingElement.attributes[1];
      expect(clickAttr.name.name).toBe("onClick");
      expect(clickAttr.value?.kind).toBe("JSXExpressionContainer");
      const clickExpr = (clickAttr.value as JSXExpressionContainer).expression as Identifier;
      expect(clickExpr.kind).toBe("Identifier");
      expect(clickExpr.name).toBe("handleClick");
    });

    it("parses hyphenated and colon-prefixed attribute names", () => {
      const code = '<input data-testid="user-input" aria-label="Username" on:input={handleInput} />';
      const el = parseJsx(code) as JSXSelfClosingElement;

      expect(el.attributes.length).toBe(3);
      expect(el.attributes[0].name.name).toBe("data-testid");
      expect(el.attributes[1].name.name).toBe("aria-label");
      expect(el.attributes[2].name.name).toBe("on:input");
    });
  });

  describe("Children with expression containers", () => {
    it("parses identifier expression container as child", () => {
      const el = parseJsx("<div>{count}</div>") as JSXElement;

      expect(el.children.length).toBe(1);
      const child = el.children[0] as JSXExpressionContainer;
      expect(child.kind).toBe("JSXExpressionContainer");
      expect((child.expression as Identifier).name).toBe("count");
    });

    it("parses mixed text and expression containers preserving inline whitespace", () => {
      const el = parseJsx("<h1>Hello, {name}! Total: {total}</h1>") as JSXElement;

      expect(el.children.length).toBe(4);
      expect((el.children[0] as JSXText).value).toBe("Hello, ");
      expect(((el.children[1] as JSXExpressionContainer).expression as Identifier).name).toBe("name");
      expect((el.children[2] as JSXText).value).toBe("! Total: ");
      expect(((el.children[3] as JSXExpressionContainer).expression as Identifier).name).toBe("total");
    });

    it("parses pipeline expression inside JSX children", () => {
      const el = parseJsx("<div>{items |> Array.map(renderItem)}</div>") as JSXElement;

      expect(el.children.length).toBe(1);
      const child = el.children[0] as JSXExpressionContainer;
      expect(child.expression.kind).toBe("PipelineExpression");
      const pipe = child.expression as PipelineExpression;
      expect((pipe.left as Identifier).name).toBe("items");
    });

    it("parses nested JSX element inside embedded child expression", () => {
      const el = parseJsx("<div>{isActive and <span>Active</span>}</div>") as JSXElement;

      expect(el.children.length).toBe(1);
      const child = el.children[0] as JSXExpressionContainer;
      expect(child.expression.kind).toBe("BinaryExpression");
      const bin = child.expression as BinaryExpression;
      expect(bin.operator).toBe("and");
      expect(bin.right.kind).toBe("JSXElement");
      const innerJsx = bin.right as JSXElement;
      expect((innerJsx.openingElement.name as Identifier).name).toBe("span");
      expect((innerJsx.children[0] as JSXText).value).toBe("Active");
    });
  });

  describe("FunScript block rules integration", () => {
    it("parses JSX as the initializer of a top-level binding declaration", () => {
      const code = `view = <div className="app">\n  <h1>Hello</h1>\n</div>`;
      const ast = parse(code);

      expect(ast.body.length).toBe(1);
      const decl = ast.body[0] as BindingDeclaration;
      expect(decl.kind).toBe("BindingDeclaration");
      expect(decl.id.name).toBe("view");
      expect(decl.init.kind).toBe("JSXElement");

      const root = decl.init as JSXElement;
      expect((root.openingElement.name as Identifier).name).toBe("div");
      expect(root.children.length).toBe(1);
    });

    it("parses inline arrow function returning JSX", () => {
      const code = "render = (item) -> <li>{item.name}</li>";
      const ast = parse(code);

      const decl = ast.body[0] as BindingDeclaration;
      const fn = decl.init as FunctionExpression;
      expect(fn.kind).toBe("FunctionExpression");
      expect(fn.params.length).toBe(1);
      expect((fn.body as JSXElement).kind).toBe("JSXElement");
    });

    it("parses function with indented block returning JSX as finalExpression", () => {
      const code = `renderCard = (user) ->
  title = user.name
  <div className="card">
    <h2>{title}</h2>
  </div>`;
      const ast = parse(code);

      const decl = ast.body[0] as BindingDeclaration;
      const fn = decl.init as FunctionExpression;
      expect(fn.body.kind).toBe("BlockStatement");
      const block = fn.body as BlockStatement;
      expect(block.statements.length).toBe(1);
      expect(block.finalExpression.kind).toBe("JSXElement");
    });

    it("parses JSX elements inside array literal", () => {
      const code = 'navItems = [<li key="1">Home</li>, <li key="2">About</li>]';
      const ast = parse(code);

      const decl = ast.body[0] as BindingDeclaration;
      expect(decl.init.kind).toBe("ArrayExpression");
    });

    it("parses match expression arms producing JSX elements", () => {
      const code = `renderStatus = (state) ->
  match state
    | Loading -> <Spinner />
    | Success(info) -> <UserProfile user={info} />
    | Failed(err) -> <ErrorMessage errorMsg={err} />`;
      const ast = parse(code);

      const decl = ast.body[0] as BindingDeclaration;
      const fn = decl.init as FunctionExpression;
      const block = fn.body as BlockStatement;
      const matchExpr = block.finalExpression as MatchExpression;
      expect(matchExpr.kind).toBe("MatchExpression");
      expect(matchExpr.arms.length).toBe(3);
      expect((matchExpr.arms[0].body as JSXSelfClosingElement).kind).toBe("JSXSelfClosingElement");
    });

    it("parses JSX inside effect block as final expression", () => {
      const code = `viewEffect = effect
  user <- fetchUser(userId)
  <Profile user={user} />`;
      const ast = parse(code);

      const decl = ast.body[0] as BindingDeclaration;
      expect(decl.init.kind).toBe("EffectBlockExpression");
      const eff = decl.init as any;
      expect(eff.body.length).toBe(1);
      expect(eff.finalExpression.kind).toBe("JSXSelfClosingElement");
    });

    it("parses arrow function lambda inside JSX child expression container", () => {
      const code = `<div>
  {users |> Array.map((u) -> <span key={u.id}>{u.name}</span>)}
</div>`;
      const el = parseJsx(code) as JSXElement;

      expect(el.children.length).toBe(1);
      const container = el.children[0] as JSXExpressionContainer;
      expect(container.expression.kind).toBe("PipelineExpression");
    });

    it("correctly records source spans for all JSX AST nodes", () => {
      const code = `<button disabled className="btn">Click me</button>`;
      const el = parseJsx(code) as JSXElement;

      expect(el.span.start.offset).toBe(0);
      expect(el.span.end.offset).toBe(code.length);
      expect(el.openingElement.span.start.offset).toBe(0);
      expect(el.closingElement.span.end.offset).toBe(code.length);

      const attr0 = el.openingElement.attributes[0];
      expect(attr0.span.start.offset).toBeGreaterThan(0);
      expect(attr0.value).toBeUndefined();

      const attr1 = el.openingElement.attributes[1];
      expect(attr1.span.start.offset).toBeGreaterThan(attr0.span.end.offset);
      expect(attr1.value?.span.end.offset).toBe(attr1.span.end.offset);

      const text = el.children[0] as JSXText;
      expect(text.span.start.offset).toBe(el.openingElement.span.end.offset);
      expect(text.span.end.offset).toBe(el.closingElement.span.start.offset);
    });
  });

  describe("Empty fragments", () => {
    it("parses empty fragment elements (<> and </>) ", () => {
      const el = parseJsx("<>Fragment content</>") as JSXElement;

      expect(el.kind).toBe("JSXElement");
      expect((el.openingElement.name as Identifier).name).toBe("");
      expect(el.children.length).toBe(1);
      expect((el.children[0] as JSXText).value).toBe("Fragment content");
      expect((el.closingElement.name as Identifier).name).toBe("");
    });
  });

  describe("Syntax error handling", () => {
    it("throws ParseError on mismatched opening and closing tags", () => {
      expect(() => parseJsx("<div></span>")).toThrow(ParseError);
      expect(() => parseJsx("<div></span>")).toThrow(
        "Expected closing tag </div>, found </span>",
      );
    });

    it("throws ParseError on unclosed JSX element", () => {
      expect(() => parseJsx("<div>Hello")).toThrow(ParseError);
    });

    it("throws ParseError on unclosed tag without '>' or '/>'", () => {
      expect(() => parseJsx("<button disabled")).toThrow(ParseError);
    });

    it("throws ParseError on invalid attribute value syntax", () => {
      expect(() => parseJsx("<div class=></div>")).toThrow(ParseError);
    });
  });
});
