import { describe, it, expect } from "vitest";
import { Lexer, LexerError } from "../src/lexer/lexer.js";
import { TokenType, BANNED_KEYWORDS, BANNED_SYMBOLS } from "../src/lexer/tokens.js";

describe("FunScript Lexer", () => {
  describe("Basic tokenization & literals", () => {
    it("tokenizes basic bindings and numbers", () => {
      const code = `x = 42\ny = 3.14`;
      const lexer = new Lexer(code);
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.IDENTIFIER,
        TokenType.EQ,
        TokenType.NUMBER,
        TokenType.NEWLINE,
        TokenType.IDENTIFIER,
        TokenType.EQ,
        TokenType.NUMBER,
        TokenType.EOF,
      ]);
      expect(tokens[2].value).toBe("42");
      expect(tokens[6].value).toBe("3.14");
    });

    it("tokenizes identifiers and upper identifiers", () => {
      const code = `foo barBaz UserShape _`;
      const lexer = new Lexer(code);
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.IDENTIFIER,
        TokenType.IDENTIFIER,
        TokenType.UPPER_IDENTIFIER,
        TokenType.UNDERSCORE,
        TokenType.EOF,
      ]);
      expect(tokens[0].value).toBe("foo");
      expect(tokens[1].value).toBe("barBaz");
      expect(tokens[2].value).toBe("UserShape");
      expect(tokens[3].value).toBe("_");
    });

    it("tokenizes boolean literals", () => {
      const code = `true\nfalse`;
      const lexer = new Lexer(code);
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.TRUE,
        TokenType.NEWLINE,
        TokenType.FALSE,
        TokenType.EOF,
      ]);
    });
  });

  describe("Indentation handling (indent/dedent stack)", () => {
    it("handles 2-space indentation (INDENT and DEDENT)", () => {
      const code = `match x\n  | 1 -> "one"\n  | _ -> "other"`;
      const lexer = new Lexer(code);
      const tokens = lexer.tokenize();

      expect(tokens.some((t) => t.type === TokenType.INDENT)).toBe(true);
      expect(tokens.some((t) => t.type === TokenType.DEDENT)).toBe(true);
    });

    it("handles multiple nested indentation levels", () => {
      const code = `
block1
  block2
    block3
      leaf = 1
`;
      const lexer = new Lexer(code.trim());
      const tokens = lexer.tokenize();

      const indents = tokens.filter((t) => t.type === TokenType.INDENT);
      const dedents = tokens.filter((t) => t.type === TokenType.DEDENT);

      expect(indents.length).toBe(3);
      expect(dedents.length).toBe(3);
    });

    it("handles multi-level dedent in a single step", () => {
      const code = `
level0
  level1
    level2
level0Again
`;
      const lexer = new Lexer(code.trim());
      const tokens = lexer.tokenize();

      const dedents = tokens.filter((t) => t.type === TokenType.DEDENT);
      expect(dedents.length).toBe(2);
    });

    it("ignores blank lines and whitespace-only lines for indentation", () => {
      const code = `
first = 1

    
  second = 2
`;
      const lexer = new Lexer(code.trim());
      const tokens = lexer.tokenize();

      const indents = tokens.filter((t) => t.type === TokenType.INDENT);
      expect(indents.length).toBe(1);
    });

    it("flushes open indentation at end of file", () => {
      const code = `
parent
  child1
    child2`;
      const lexer = new Lexer(code.trim());
      const tokens = lexer.tokenize();

      const dedents = tokens.filter((t) => t.type === TokenType.DEDENT);
      expect(dedents.length).toBe(2);
      expect(tokens[tokens.length - 1].type).toBe(TokenType.EOF);
    });

    it("throws on tabs used for indentation", () => {
      const code = `first\n\tsecond`;
      expect(() => new Lexer(code).tokenize()).toThrow(LexerError);
      expect(() => new Lexer(code).tokenize()).toThrow(/Tabs are not allowed/);
    });

    it("throws on tabs used for inline spacing", () => {
      const code = `x\t= 1`;
      expect(() => new Lexer(code).tokenize()).toThrow(LexerError);
      expect(() => new Lexer(code).tokenize()).toThrow(/Tabs are not allowed/);
    });

    it("throws on inconsistent unindent that does not match any outer level", () => {
      const code = `
first
    fourSpaces
  threeSpaces
`;
      // Stack: [0, 4]. 3 spaces does not match 4 or 0.
      const badCode = `first\n    sub\n   bad`;
      expect(() => new Lexer(badCode).tokenize()).toThrow(LexerError);
      expect(() => new Lexer(badCode).tokenize()).toThrow(/Inconsistent indentation/);
    });
  });

  describe("String interpolation and escape handling", () => {
    it("tokenizes simple string literal", () => {
      const code = `msg = "Hello, world!"`;
      const lexer = new Lexer(code);
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.IDENTIFIER,
        TokenType.EQ,
        TokenType.STRING,
        TokenType.EOF,
      ]);
      expect(tokens[2].value).toBe("Hello, world!");
    });

    it("tokenizes string interpolation with single expression", () => {
      const code = `greeting = "Hello, {name}!"`;
      const lexer = new Lexer(code);
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.IDENTIFIER,
        TokenType.EQ,
        TokenType.STRING_PART,
        TokenType.INTERPOLATION_START,
        TokenType.IDENTIFIER,
        TokenType.INTERPOLATION_END,
        TokenType.STRING_PART,
        TokenType.EOF,
      ]);
      expect(tokens[2].value).toBe("Hello, ");
      expect(tokens[4].value).toBe("name");
      expect(tokens[6].value).toBe("!");
    });

    it("tokenizes string with multiple interpolations", () => {
      const code = `msg = "{greeting}, {name}! You have {count} messages."`;
      const lexer = new Lexer(code);
      const tokens = lexer.tokenize();

      expect(tokens.filter((t) => t.type === TokenType.INTERPOLATION_START).length).toBe(3);
      expect(tokens.filter((t) => t.type === TokenType.INTERPOLATION_END).length).toBe(3);
    });

    it("handles escape sequences in strings", () => {
      const code = `escaped = "Line 1\\nLine 2\\tTabbed \\"Quotes\\" \\\\ \\{notInterpolated}"`;
      const lexer = new Lexer(code);
      const tokens = lexer.tokenize();

      const strToken = tokens.find((t) => t.type === TokenType.STRING);
      expect(strToken).toBeDefined();
      expect(strToken?.value).toBe('Line 1\nLine 2\tTabbed "Quotes" \\ {notInterpolated}');
    });

    it("throws on unclosed string at newline", () => {
      const code = `x = "unterminated\ny = 2`;
      expect(() => new Lexer(code).tokenize()).toThrow(LexerError);
      expect(() => new Lexer(code).tokenize()).toThrow(/newline in string/);
    });

    it("throws on unclosed string at EOF", () => {
      const code = `x = "unterminated`;
      expect(() => new Lexer(code).tokenize()).toThrow(LexerError);
      expect(() => new Lexer(code).tokenize()).toThrow(/Unterminated string literal/);
    });
  });

  describe("Comments handling", () => {
    it("skips full-line comments", () => {
      const code = `# This is a comment\nx = 1\n# Another comment\ny = 2`;
      const lexer = new Lexer(code);
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.IDENTIFIER,
        TokenType.EQ,
        TokenType.NUMBER,
        TokenType.NEWLINE,
        TokenType.IDENTIFIER,
        TokenType.EQ,
        TokenType.NUMBER,
        TokenType.EOF,
      ]);
    });

    it("skips inline trailing comments", () => {
      const code = `x = 10 # trailing comment\ny = 20 # another comment`;
      const lexer = new Lexer(code);
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.IDENTIFIER,
        TokenType.EQ,
        TokenType.NUMBER,
        TokenType.NEWLINE,
        TokenType.IDENTIFIER,
        TokenType.EQ,
        TokenType.NUMBER,
        TokenType.EOF,
      ]);
    });

    it("handles comment at EOF without trailing newline", () => {
      const code = `x = 1\n# trailing comment at EOF`;
      const lexer = new Lexer(code);
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.IDENTIFIER,
        TokenType.EQ,
        TokenType.NUMBER,
        TokenType.NEWLINE,
        TokenType.EOF,
      ]);
    });

    it("handles comments within indented blocks without altering indentation", () => {
      const code = `
block
  # comment line inside indent
  val = 42
`;
      const lexer = new Lexer(code.trim());
      const tokens = lexer.tokenize();

      expect(tokens.filter((t) => t.type === TokenType.INDENT).length).toBe(1);
      expect(tokens.filter((t) => t.type === TokenType.DEDENT).length).toBe(1);
    });
  });

  describe("Operators and Delimiters", () => {
    it("tokenizes all multi-character operators", () => {
      const code = `-> <- |> == != ** ?? ... ???`;
      const lexer = new Lexer(code);
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.ARROW,
        TokenType.LARROW,
        TokenType.PIPE,
        TokenType.EQEQ,
        TokenType.NEQ,
        TokenType.STARSTAR,
        TokenType.QUESTIONQUESTION,
        TokenType.DOTDOTDOT,
        TokenType.TYPED_HOLE,
        TokenType.EOF,
      ]);
    });

    it("tokenizes single-character operators and delimiters", () => {
      const code = `= | + - * / % : , . ( ) [ ] { } < >`;
      const lexer = new Lexer(code);
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.EQ,
        TokenType.BAR,
        TokenType.PLUS,
        TokenType.MINUS,
        TokenType.STAR,
        TokenType.SLASH,
        TokenType.PERCENT,
        TokenType.COLON,
        TokenType.COMMA,
        TokenType.DOT,
        TokenType.LPAREN,
        TokenType.RPAREN,
        TokenType.LBRACKET,
        TokenType.RBRACKET,
        TokenType.LBRACE,
        TokenType.RBRACE,
        TokenType.LT,
        TokenType.GT,
        TokenType.EOF,
      ]);
    });

    it("disambiguates prefix and multi-char operators correctly", () => {
      // * vs **
      const starCode = `a * b ** c`;
      const starTokens = new Lexer(starCode).tokenize();
      expect(starTokens.map((t) => t.type)).toEqual([
        TokenType.IDENTIFIER,
        TokenType.STAR,
        TokenType.IDENTIFIER,
        TokenType.STARSTAR,
        TokenType.IDENTIFIER,
        TokenType.EOF,
      ]);

      // . vs ...
      const dotCode = `a.b ...c`;
      const dotTokens = new Lexer(dotCode).tokenize();
      expect(dotTokens.map((t) => t.type)).toEqual([
        TokenType.IDENTIFIER,
        TokenType.DOT,
        TokenType.IDENTIFIER,
        TokenType.DOTDOTDOT,
        TokenType.IDENTIFIER,
        TokenType.EOF,
      ]);

      // = vs ==
      const eqCode = `a = b == c`;
      const eqTokens = new Lexer(eqCode).tokenize();
      expect(eqTokens.map((t) => t.type)).toEqual([
        TokenType.IDENTIFIER,
        TokenType.EQ,
        TokenType.IDENTIFIER,
        TokenType.EQEQ,
        TokenType.IDENTIFIER,
        TokenType.EOF,
      ]);
    });
  });

  describe("Keywords and diagnostics", () => {
    it("tokenizes all 15 FunScript keywords", () => {
      const code = `and effect error export false from import match mut not or schema service true when`;
      const lexer = new Lexer(code);
      const tokens = lexer.tokenize();

      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.AND,
        TokenType.EFFECT,
        TokenType.ERROR,
        TokenType.EXPORT,
        TokenType.FALSE,
        TokenType.FROM,
        TokenType.IMPORT,
        TokenType.MATCH,
        TokenType.MUT,
        TokenType.NOT,
        TokenType.OR,
        TokenType.SCHEMA,
        TokenType.SERVICE,
        TokenType.TRUE,
        TokenType.WHEN,
        TokenType.EOF,
      ]);
    });

    it("rejects banned keywords with friendly diagnostics", () => {
      for (const [kw, expectedMsg] of Object.entries(BANNED_KEYWORDS)) {
        expect(
          () => new Lexer(`${kw} x = 1`).tokenize(),
          `Expected banned keyword '${kw}' to throw LexerError`,
        ).toThrow(LexerError);

        try {
          new Lexer(`${kw} foo`).tokenize();
        } catch (e: any) {
          expect(e.message).toContain(expectedMsg);
        }
      }
    });

    it("rejects banned symbols with friendly diagnostics", () => {
      for (const [sym, expectedMsg] of Object.entries(BANNED_SYMBOLS)) {
        expect(
          () => new Lexer(`a ${sym} b`).tokenize(),
          `Expected banned symbol '${sym}' to throw LexerError`,
        ).toThrow(LexerError);

        try {
          new Lexer(`a ${sym} b`).tokenize();
        } catch (e: any) {
          expect(e.message).toContain(expectedMsg);
        }
      }
    });

    it("throws on unexpected character", () => {
      expect(() => new Lexer(`@`).tokenize()).toThrow(LexerError);
      expect(() => new Lexer(`$`).tokenize()).toThrow(LexerError);
    });
  });
});
