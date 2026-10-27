import { describe, it, expect } from "vitest";
import { Lexer } from "../src/lexer/lexer.js";
import {
  TokenType,
  JsxTagOpen,
  JsxTagClose,
  JsxSlashClose,
  JsxClosingTagOpen,
  JsxAttributeName,
  JsxText,
} from "../src/lexer/tokens.js";

describe("JSX Lexer Tokenization (.funx mode)", () => {
  describe("Basic elements and fragments", () => {
    it("tokenizes a self-closing element", () => {
      const code = `<br />`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.JsxTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxSlashClose,
        TokenType.EOF,
      ]);
      expect(tokens[0].value).toBe("<");
      expect(tokens[1].value).toBe("br");
      expect(tokens[2].value).toBe("/>");
    });

    it("tokenizes a capitalized component self-closing element", () => {
      const code = `<Avatar />`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.JsxTagOpen,
        TokenType.UPPER_IDENTIFIER,
        TokenType.JsxSlashClose,
        TokenType.EOF,
      ]);
      expect(tokens[1].value).toBe("Avatar");
    });

    it("tokenizes an element with text content and closing tag", () => {
      const code = `<div>Hello, FunScript!</div>`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.JsxTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxTagClose,
        TokenType.JsxText,
        TokenType.JsxClosingTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxTagClose,
        TokenType.EOF,
      ]);
      expect(tokens[0].value).toBe("<");
      expect(tokens[1].value).toBe("div");
      expect(tokens[2].value).toBe(">");
      expect(tokens[3].value).toBe("Hello, FunScript!");
      expect(tokens[4].value).toBe("</");
      expect(tokens[5].value).toBe("div");
      expect(tokens[6].value).toBe(">");
    });

    it("tokenizes nested elements with text", () => {
      const code = `<div><span>Inner Text</span></div>`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.JsxTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxTagClose,
        TokenType.JsxTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxTagClose,
        TokenType.JsxText,
        TokenType.JsxClosingTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxTagClose,
        TokenType.JsxClosingTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxTagClose,
        TokenType.EOF,
      ]);
      expect(tokens[6].value).toBe("Inner Text");
    });

    it("tokenizes empty fragments (<> and </>) ", () => {
      const code = `<>Fragment content</>`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.JsxTagOpen,
        TokenType.JsxTagClose,
        TokenType.JsxText,
        TokenType.JsxClosingTagOpen,
        TokenType.JsxTagClose,
        TokenType.EOF,
      ]);
      expect(tokens[2].value).toBe("Fragment content");
    });

    it("tokenizes member access components like <Icons.Close />", () => {
      const code = `<Icons.Close size={24} />`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.JsxTagOpen,
        TokenType.UPPER_IDENTIFIER,
        TokenType.DOT,
        TokenType.UPPER_IDENTIFIER,
        TokenType.JsxAttributeName,
        TokenType.EQ,
        TokenType.LBRACE,
        TokenType.NUMBER,
        TokenType.RBRACE,
        TokenType.JsxSlashClose,
        TokenType.EOF,
      ]);
      expect(tokens[1].value).toBe("Icons");
      expect(tokens[3].value).toBe("Close");
      expect(tokens[4].value).toBe("size");
      expect(tokens[7].value).toBe("24");
    });
  });

  describe("JSX Attributes", () => {
    it("tokenizes boolean attributes without values", () => {
      const code = `<button disabled autofocus />`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.JsxTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxAttributeName,
        TokenType.JsxAttributeName,
        TokenType.JsxSlashClose,
        TokenType.EOF,
      ]);
      expect(tokens[2].value).toBe("disabled");
      expect(tokens[3].value).toBe("autofocus");
    });

    it("tokenizes string attributes", () => {
      const code = `<div className="btn-primary" id="main" />`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.JsxTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxAttributeName,
        TokenType.EQ,
        TokenType.STRING,
        TokenType.JsxAttributeName,
        TokenType.EQ,
        TokenType.STRING,
        TokenType.JsxSlashClose,
        TokenType.EOF,
      ]);
      expect(tokens[2].value).toBe("className");
      expect(tokens[4].value).toBe("btn-primary");
      expect(tokens[5].value).toBe("id");
      expect(tokens[7].value).toBe("main");
    });

    it("tokenizes hyphenated and colon attribute names (aria, data, on:click)", () => {
      const code = `<input data-testid="user-input" aria-label="Username" on:input={handleInput} />`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.JsxTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxAttributeName,
        TokenType.EQ,
        TokenType.STRING,
        TokenType.JsxAttributeName,
        TokenType.EQ,
        TokenType.STRING,
        TokenType.JsxAttributeName,
        TokenType.EQ,
        TokenType.LBRACE,
        TokenType.IDENTIFIER,
        TokenType.RBRACE,
        TokenType.JsxSlashClose,
        TokenType.EOF,
      ]);
      expect(tokens[2].value).toBe("data-testid");
      expect(tokens[5].value).toBe("aria-label");
      expect(tokens[8].value).toBe("on:input");
      expect(tokens[11].value).toBe("handleInput");
    });

    it("tokenizes embedded expressions in attributes", () => {
      const code = `<button count={x + 1} onClick={handleClick}>Submit</button>`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.JsxTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxAttributeName,
        TokenType.EQ,
        TokenType.LBRACE,
        TokenType.IDENTIFIER,
        TokenType.PLUS,
        TokenType.NUMBER,
        TokenType.RBRACE,
        TokenType.JsxAttributeName,
        TokenType.EQ,
        TokenType.LBRACE,
        TokenType.IDENTIFIER,
        TokenType.RBRACE,
        TokenType.JsxTagClose,
        TokenType.JsxText,
        TokenType.JsxClosingTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxTagClose,
        TokenType.EOF,
      ]);
      expect(tokens[2].value).toBe("count");
      expect(tokens[5].value).toBe("x");
      expect(tokens[7].value).toBe("1");
      expect(tokens[9].value).toBe("onClick");
      expect(tokens[12].value).toBe("handleClick");
    });
  });

  describe("Embedded FunScript Expressions within JSX Children", () => {
    it("tokenizes expression container in child position", () => {
      const code = `<div>{count}</div>`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.JsxTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxTagClose,
        TokenType.LBRACE,
        TokenType.IDENTIFIER,
        TokenType.RBRACE,
        TokenType.JsxClosingTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxTagClose,
        TokenType.EOF,
      ]);
      expect(tokens[4].value).toBe("count");
    });

    it("tokenizes mixed text and expression children", () => {
      const code = `<h1>Hello, {name}! Total: {total}</h1>`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.JsxTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxTagClose,
        TokenType.JsxText,
        TokenType.LBRACE,
        TokenType.IDENTIFIER,
        TokenType.RBRACE,
        TokenType.JsxText,
        TokenType.LBRACE,
        TokenType.IDENTIFIER,
        TokenType.RBRACE,
        TokenType.JsxClosingTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxTagClose,
        TokenType.EOF,
      ]);
      expect(tokens[3].value).toBe("Hello, ");
      expect(tokens[5].value).toBe("name");
      expect(tokens[7].value).toBe("! Total: ");
      expect(tokens[9].value).toBe("total");
    });

    it("tokenizes pipeline operator inside embedded JSX child expression", () => {
      const code = `<div>{items |> Array.map(renderItem)}</div>`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.JsxTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxTagClose,
        TokenType.LBRACE,
        TokenType.IDENTIFIER,
        TokenType.PIPE,
        TokenType.UPPER_IDENTIFIER,
        TokenType.DOT,
        TokenType.IDENTIFIER,
        TokenType.LPAREN,
        TokenType.IDENTIFIER,
        TokenType.RPAREN,
        TokenType.RBRACE,
        TokenType.JsxClosingTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxTagClose,
        TokenType.EOF,
      ]);
      expect(tokens[5].type).toBe(TokenType.PIPE);
      expect(tokens[5].value).toBe("|>");
    });

    it("tokenizes JSX nested inside embedded FunScript expression", () => {
      const code = `<div>{ifTrue and <span>Active</span>}</div>`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.JsxTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxTagClose,
        TokenType.LBRACE,
        TokenType.IDENTIFIER,
        TokenType.AND,
        TokenType.JsxTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxTagClose,
        TokenType.JsxText,
        TokenType.JsxClosingTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxTagClose,
        TokenType.RBRACE,
        TokenType.JsxClosingTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxTagClose,
        TokenType.EOF,
      ]);
      expect(tokens[9].value).toBe("Active");
    });
  });

  describe("Disambiguation between JSX and FunScript Operators", () => {
    it("distinguishes comparison operators (< and >) from JSX tags", () => {
      const code = `isSmall = count < 10\nisLarge = count > 100\nview = <div />`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      // Line 1: count < 10
      expect(tokens[0].value).toBe("isSmall");
      expect(tokens[1].type).toBe(TokenType.EQ);
      expect(tokens[2].value).toBe("count");
      expect(tokens[3].type).toBe(TokenType.LT);
      expect(tokens[3].value).toBe("<");
      expect(tokens[4].value).toBe("10");
      expect(tokens[5].type).toBe(TokenType.NEWLINE);

      // Line 2: count > 100
      expect(tokens[6].value).toBe("isLarge");
      expect(tokens[7].type).toBe(TokenType.EQ);
      expect(tokens[8].value).toBe("count");
      expect(tokens[9].type).toBe(TokenType.GT);
      expect(tokens[9].value).toBe(">");
      expect(tokens[10].value).toBe("100");
      expect(tokens[11].type).toBe(TokenType.NEWLINE);

      // Line 3: view = <div />
      expect(tokens[12].value).toBe("view");
      expect(tokens[13].type).toBe(TokenType.EQ);
      expect(tokens[14].type).toBe(TokenType.JsxTagOpen);
      expect(tokens[14].value).toBe("<");
      expect(tokens[15].value).toBe("div");
      expect(tokens[16].type).toBe(TokenType.JsxSlashClose);
    });

    it("correctly tokenizes comparison operators inside JSX attribute expressions", () => {
      const code = `<div visible={count < 10} />`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.JsxTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxAttributeName,
        TokenType.EQ,
        TokenType.LBRACE,
        TokenType.IDENTIFIER,
        TokenType.LT,
        TokenType.NUMBER,
        TokenType.RBRACE,
        TokenType.JsxSlashClose,
        TokenType.EOF,
      ]);
      expect(tokens[6].type).toBe(TokenType.LT);
      expect(tokens[6].value).toBe("<");
    });

    it("correctly tokenizes comparison operators inside JSX child expressions", () => {
      const code = `<div>{x > 0 and y < 5}</div>`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.JsxTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxTagClose,
        TokenType.LBRACE,
        TokenType.IDENTIFIER,
        TokenType.GT,
        TokenType.NUMBER,
        TokenType.AND,
        TokenType.IDENTIFIER,
        TokenType.LT,
        TokenType.NUMBER,
        TokenType.RBRACE,
        TokenType.JsxClosingTagOpen,
        TokenType.IDENTIFIER,
        TokenType.JsxTagClose,
        TokenType.EOF,
      ]);
      expect(tokens[5].type).toBe(TokenType.GT);
      expect(tokens[9].type).toBe(TokenType.LT);
    });

    it("distinguishes pipeline operator (|>) from JSX", () => {
      const code = `item |> transform |> (<div />)`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      expect(tokens[1].type).toBe(TokenType.PIPE);
      expect(tokens[3].type).toBe(TokenType.PIPE);
      expect(tokens[4].type).toBe(TokenType.LPAREN);
      expect(tokens[5].type).toBe(TokenType.JsxTagOpen);
      expect(tokens[6].value).toBe("div");
      expect(tokens[7].type).toBe(TokenType.JsxSlashClose);
      expect(tokens[8].type).toBe(TokenType.RPAREN);
    });

    it("preserves generic type parameter angle brackets in schema definitions", () => {
      const code = `schema Box<T> =\n  val: T`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      expect(tokens[0].type).toBe(TokenType.SCHEMA);
      expect(tokens[1].type).toBe(TokenType.UPPER_IDENTIFIER);
      expect(tokens[1].value).toBe("Box");
      expect(tokens[2].type).toBe(TokenType.LT);
      expect(tokens[3].type).toBe(TokenType.UPPER_IDENTIFIER);
      expect(tokens[3].value).toBe("T");
      expect(tokens[4].type).toBe(TokenType.GT);
    });

    it("tokenizes JSX after function arrow, effect larrow, match, and array bracket", () => {
      const code = `
f = () -> <div />
e = effect
  x <- <span />
arr = [<li />, <li />]
`;
      const lexer = new Lexer(code.trim(), "test.funx");
      const tokens = lexer.tokenize();

      const jsxOpens = tokens.filter((t) => t.type === TokenType.JsxTagOpen);
      expect(jsxOpens.length).toBe(4);
    });
  });

  describe("Constructor options and non-.funx regression", () => {
    it("enables JSX tokenization with filename ending in .funx", () => {
      const code = `x = <div />`;
      const tokens = new Lexer(code, "App.funx").tokenize();
      expect(tokens[2].type).toBe(TokenType.JsxTagOpen);
    });

    it("enables JSX tokenization with options { jsx: true }", () => {
      const code = `x = <div />`;
      const tokens = new Lexer(code, "App.fun", { jsx: true }).tokenize();
      expect(tokens[2].type).toBe(TokenType.JsxTagOpen);
    });

    it("enables JSX tokenization with boolean true option", () => {
      const code = `x = <div />`;
      const tokens = new Lexer(code, "<anonymous>", true).tokenize();
      expect(tokens[2].type).toBe(TokenType.JsxTagOpen);
    });

    it("does NOT tokenize JSX in standard .fun mode (treats < as LT)", () => {
      const code = `x = <div`;
      const tokens = new Lexer(code, "App.fun").tokenize();
      expect(tokens[2].type).toBe(TokenType.LT);
    });

    it("exports direct token constants matching TokenType values", () => {
      expect(JsxTagOpen).toBe(TokenType.JsxTagOpen);
      expect(JsxTagClose).toBe(TokenType.JsxTagClose);
      expect(JsxSlashClose).toBe(TokenType.JsxSlashClose);
      expect(JsxClosingTagOpen).toBe(TokenType.JsxClosingTagOpen);
      expect(JsxAttributeName).toBe(TokenType.JsxAttributeName);
      expect(JsxText).toBe(TokenType.JsxText);
    });
  });

  describe("Multi-line JSX formatting and comments", () => {
    it("tokenizes multi-line tags with attributes across lines without spurious newlines", () => {
      const code = `<button
  className="btn"
  disabled
  onClick={handleClick}
>
  Click
</button>`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      const newlines = tokens.filter((t) => t.type === TokenType.NEWLINE);
      // Newlines within tags should not emit statement NEWLINE tokens
      expect(newlines.length).toBe(0);

      const attrNames = tokens
        .filter((t) => t.type === TokenType.JsxAttributeName)
        .map((t) => t.value);
      expect(attrNames).toEqual(["className", "disabled", "onClick"]);
    });

    it("handles comments inside JSX tags and expression containers", () => {
      const code = `<div # tag comment
  count={# expr comment
    42}
>
  Hello
</div>`;
      const lexer = new Lexer(code, "test.funx");
      const tokens = lexer.tokenize();

      expect(tokens.some((t) => t.type === TokenType.NUMBER && t.value === "42")).toBe(true);
      expect(tokens.some((t) => t.type === TokenType.JSX_TEXT && t.value.includes("Hello"))).toBe(true);
    });
  });
});
