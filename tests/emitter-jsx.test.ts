import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { Lexer } from "../src/lexer/lexer.js";
import { Parser } from "../src/parser/parser.js";
import { Emitter } from "../src/emitter/emitter.js";
import { compileString } from "../src/compiler.js";
import {
  JSXElement,
  JSXSelfClosingElement,
  JSXAttribute,
  JSXExpressionContainer,
  JSXText,
  Identifier,
  UpperIdentifier,
  StringLiteral,
  Span,
} from "../src/index.js";

const dummySpan: Span = {
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 10, offset: 9 },
};

function emitJsxExpr(source: string): string {
  const lexer = new Lexer(source, "test.funx");
  const parser = new Parser(lexer.tokenize(), "test.funx");
  const ast = parser.parseJsxElement();
  const emitter = new Emitter();
  return emitter.emitExpression(ast);
}

async function compileFunx(source: string): Promise<string> {
  const res = await Effect.runPromise(compileString(source, "test.funx"));
  return res.typescript;
}

describe("TSX Emitter for JSX AST Nodes", () => {
  describe("Self-closing elements", () => {
    it("emits lowercase HTML self-closing elements", () => {
      expect(emitJsxExpr("<br />")).toBe("<br />");
      expect(emitJsxExpr("<hr />")).toBe("<hr />");
      expect(emitJsxExpr('<img src="avatar.png" alt="Profile" />')).toBe(
        '<img src="avatar.png" alt="Profile" />',
      );
    });

    it("emits component self-closing elements with UpperIdentifier", () => {
      expect(emitJsxExpr("<Avatar />")).toBe("<Avatar />");
      expect(emitJsxExpr("<UserProfile user={user} />")).toBe("<UserProfile user={user} />");
    });

    it("emits member access component self-closing elements", () => {
      expect(emitJsxExpr("<Icons.Close size={24} />")).toBe("<Icons.Close size={24} />");
      expect(emitJsxExpr("<Layout.Sidebar.Item active={true} />")).toBe(
        "<Layout.Sidebar.Item active={true} />",
      );
    });
  });

  describe("Elements with text children", () => {
    it("emits element with text child", () => {
      expect(emitJsxExpr("<div>Hello, FunScript!</div>")).toBe("<div>Hello, FunScript!</div>");
      expect(emitJsxExpr("<span>Simple string</span>")).toBe("<span>Simple string</span>");
    });

    it("emits element with multiline normalized text", () => {
      const code = `<div>
  Welcome to FunScript UI components!
</div>`;
      expect(emitJsxExpr(code)).toBe("<div>Welcome to FunScript UI components!</div>");
    });

    it("emits empty elements", () => {
      expect(emitJsxExpr("<button></button>")).toBe("<button></button>");
    });
  });

  describe("Fragments", () => {
    it("emits empty fragment elements (<> and </>) ", () => {
      expect(emitJsxExpr("<>Fragment content</>")).toBe("<>Fragment content</>");
      expect(emitJsxExpr("<><span>One</span><span>Two</span></>")).toBe(
        "<><span>One</span><span>Two</span></>",
      );
    });
  });

  describe("JSX Attributes", () => {
    it("emits boolean attributes without value", () => {
      expect(emitJsxExpr("<button disabled autofocus />")).toBe("<button disabled autofocus />");
    });

    it("emits string literal attributes with double quotes", () => {
      expect(emitJsxExpr('<div className="btn-primary" id="main" />')).toBe(
        '<div className="btn-primary" id="main" />',
      );
    });

    it("emits expression container attributes with identifier or arithmetic expressions", () => {
      expect(emitJsxExpr("<button count={x + 1} onClick={handleClick}>Submit</button>")).toBe(
        "<button count={(x + 1)} onClick={handleClick}>Submit</button>",
      );
    });

    it("emits hyphenated and colon-prefixed attribute names", () => {
      expect(
        emitJsxExpr('<input data-testid="user-input" aria-label="Username" on:input={handleInput} />'),
      ).toBe('<input data-testid="user-input" aria-label="Username" on:input={handleInput} />');
    });

    it("emits record expressions as JSX attribute values", () => {
      expect(emitJsxExpr('<div style={{ color: "red", fontSize: 16 }} />')).toBe(
        '<div style={{ color: "red", fontSize: 16 }} />',
      );
    });

    it("emits template string interpolation attribute values inside braces", () => {
      const code = '<button className="btn-${variant}" />';
      expect(emitJsxExpr(code)).toBe("<button className={`btn-${variant}`} />");
    });
  });

  describe("Children with expression containers", () => {
    it("emits identifier expression container as child", () => {
      expect(emitJsxExpr("<div>{count}</div>")).toBe("<div>{count}</div>");
    });

    it("emits mixed text and expression containers preserving whitespace", () => {
      expect(emitJsxExpr("<h1>Hello, {name}! Total: {total}</h1>")).toBe(
        "<h1>Hello, {name}! Total: {total}</h1>",
      );
    });

    it("emits conditional binary expression inside expression container", () => {
      expect(emitJsxExpr("<div>{isActive and <span>Active</span>}</div>")).toBe(
        "<div>{(isActive && <span>Active</span>)}</div>",
      );
    });

    it("emits pipeline expression inside expression container", () => {
      const emitted = emitJsxExpr("<div>{items |> Array.map(renderItem)}</div>");
      expect(emitted).toContain("pipe(");
      expect(emitted).toContain("items");
      expect(emitted).toContain("Array.map(renderItem)");
    });

    it("emits lambda function returning JSX inside expression container", () => {
      const code = `<div>{users |> Array.map((u) -> <span key={u.id}>{u.name}</span>)}</div>`;
      const emitted = emitJsxExpr(code);
      expect(emitted).toContain("(u) => <span key={u.id}>{u.name}</span>");
    });
  });

  describe("Nested elements", () => {
    it("emits nested JSX elements", () => {
      expect(emitJsxExpr("<div><span>Inner Text</span></div>")).toBe(
        "<div><span>Inner Text</span></div>",
      );
    });

    it("emits sibling elements", () => {
      const code = `<ul>
  <li>Item 1</li>
  <li>Item 2</li>
  <li>Item 3</li>
</ul>`;
      expect(emitJsxExpr(code)).toBe("<ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul>");
    });

    it("emits mixed nested elements, self-closing elements, and text", () => {
      const code = `<div>
  <p>Paragraph text<br /></p>
  <Footer />
</div>`;
      expect(emitJsxExpr(code)).toBe("<div><p>Paragraph text<br /></p><Footer /></div>");
    });
  });

  describe("Direct Emitter methods unit tests", () => {
    const emitter = new Emitter();

    it("emitJsxTagName formats identifiers and member expressions", () => {
      expect(emitter.emitJsxTagName({ kind: "Identifier", name: "div", span: dummySpan })).toBe(
        "div",
      );
      expect(
        emitter.emitJsxTagName({ kind: "UpperIdentifier", name: "Avatar", span: dummySpan }),
      ).toBe("Avatar");
      expect(
        emitter.emitJsxTagName({
          kind: "MemberExpression",
          object: { kind: "UpperIdentifier", name: "Icons", span: dummySpan },
          property: { kind: "Identifier", name: "Close", span: dummySpan },
          span: dummySpan,
        }),
      ).toBe("Icons.Close");
      expect(emitter.emitJsxTagName({ kind: "Identifier", name: "", span: dummySpan })).toBe("");
    });

    it("emitJsxText returns the text value", () => {
      const textNode: JSXText = {
        kind: "JSXText",
        value: "Some inner text",
        raw: "Some inner text",
        span: dummySpan,
      };
      expect(emitter.emitJsxText(textNode)).toBe("Some inner text");
    });

    it("emitJsxExpressionContainer wraps expression in braces", () => {
      const container: JSXExpressionContainer = {
        kind: "JSXExpressionContainer",
        expression: { kind: "Identifier", name: "user", span: dummySpan },
        span: dummySpan,
      };
      expect(emitter.emitJsxExpressionContainer(container)).toBe("{user}");
    });

    it("emitJsxAttribute formats attributes properly", () => {
      const boolAttr: JSXAttribute = {
        kind: "JSXAttribute",
        name: { kind: "Identifier", name: "disabled", span: dummySpan },
        span: dummySpan,
      };
      expect(emitter.emitJsxAttribute(boolAttr)).toBe("disabled");

      const strAttr: JSXAttribute = {
        kind: "JSXAttribute",
        name: { kind: "Identifier", name: "className", span: dummySpan },
        value: {
          kind: "StringLiteral",
          parts: [{ kind: "StringRawPart", value: "btn" }],
          raw: '"btn"',
          span: dummySpan,
        },
        span: dummySpan,
      };
      expect(emitter.emitJsxAttribute(strAttr)).toBe('className="btn"');

      const exprAttr: JSXAttribute = {
        kind: "JSXAttribute",
        name: { kind: "Identifier", name: "count", span: dummySpan },
        value: {
          kind: "JSXExpressionContainer",
          expression: { kind: "NumberLiteral", value: 42, raw: "42", span: dummySpan },
          span: dummySpan,
        },
        span: dummySpan,
      };
      expect(emitter.emitJsxAttribute(exprAttr)).toBe("count={42}");
    });
  });

  describe("End-to-end .funx program compilation", () => {
    it("compiles top-level binding with JSX initializer", async () => {
      const code = `
export view = <div className="app">
  <h1>Hello</h1>
</div>
`.trim();
      const tsx = await compileFunx(code);
      expect(tsx).toContain('export const view = <div className="app"><h1>Hello</h1></div>;');
    });

    it("compiles inline component arrow function returning JSX", async () => {
      const code = `
export Item = (props: Props) -> <li className="item">{props.title}</li>
`.trim();
      const tsx = await compileFunx(code);
      expect(tsx).toContain(
        'export const Item = (props: Props) => <li className="item">{props.title}</li>;',
      );
    });

    it("compiles component with indented block returning JSX", async () => {
      const code = `
export renderCard = (user: User) ->
  title = user.name
  <div className="card">
    <h2>{title}</h2>
  </div>
`.trim();
      const tsx = await compileFunx(code);
      expect(tsx).toContain("export const renderCard = (user: User) => {");
      expect(tsx).toContain("const title = user.name;");
      expect(tsx).toContain('return <div className="card"><h2>{title}</h2></div>;');
    });

    it("compiles JSX elements inside array literal", async () => {
      const code = `
export navItems = [<li key="1">Home</li>, <li key="2">About</li>]
`.trim();
      const tsx = await compileFunx(code);
      expect(tsx).toContain('export const navItems = [<li key="1">Home</li>, <li key="2">About</li>];');
    });

    it("compiles match expressions returning JSX", async () => {
      const code = `
export renderStatus = (state) ->
  match state
    | Loading -> <Spinner />
    | Success(info) -> <UserProfile user={info} />
`.trim();
      const tsx = await compileFunx(code);
      expect(tsx).toContain('import { match, P } from "ts-pattern";');
      expect(tsx).toContain(".with({ _tag: \"Loading\" }, () => <Spinner />)");
      expect(tsx).toContain(".with({ _tag: \"Success\" }");
      expect(tsx).toContain("return <UserProfile user={info} />;");
    });

    it("compiles effect block returning JSX with automatic Effect import", async () => {
      const code = `
export viewEffect = effect
  user <- fetchUser(userId)
  <Profile user={user} />
`.trim();
      const tsx = await compileFunx(code);
      expect(tsx).toContain('import { Effect } from "effect";');
      expect(tsx).toContain("Effect.gen(function* () {");
      expect(tsx).toContain("const user = yield* fetchUser(userId);");
      expect(tsx).toContain("return <Profile user={user} />;");
    });

    it("compiles pipeline in JSX child with automatic pipe import", async () => {
      const code = `
export list = <ul>
  {items |> Array.map((i) -> <li>{i}</li>)}
</ul>
`.trim();
      const tsx = await compileFunx(code);
      expect(tsx).toContain('import { Array, pipe } from "effect";');
      expect(tsx).toContain("pipe(");
      expect(tsx).toContain("Array.map((i) => <li>{i}</li>)");
    });
  });
});
