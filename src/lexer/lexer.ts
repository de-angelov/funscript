import { Position, Span } from "../ast/types.js";
import {
  Token,
  TokenType,
  KEYWORDS,
  BANNED_KEYWORDS,
  BANNED_SYMBOLS,
} from "./tokens.js";

export class LexerError extends Error {
  constructor(
    message: string,
    public span: Span,
  ) {
    super(`${message} at line ${span.start.line}, col ${span.start.column}`);
    this.name = "LexerError";
  }
}

export class Lexer {
  private offset = 0;
  private line = 1;
  private column = 1;
  private indentStack: number[] = [0];
  private parenLevel = 0;
  private bracketLevel = 0;
  private braceStack: ("record" | "interpolation")[] = [];
  private tokens: Token[] = [];
  private atLineStart = true;

  constructor(
    private source: string,
    private filename: string = "<anonymous>",
  ) {}

  public tokenize(): Token[] {
    while (!this.isAtEnd()) {
      if (this.atLineStart) {
        this.handleIndentation();
      }

      if (this.isAtEnd()) break;

      const char = this.peek();

      // Whitespace (inline)
      if (char === " " || char === "\t") {
        if (char === "\t") {
          throw new LexerError("Tabs are not allowed for indentation or spacing; use 2 spaces", this.currentSpan(1));
        }
        this.advance();
        continue;
      }

      // Newlines
      if (char === "\r" || char === "\n") {
        this.advanceNewline();
        continue;
      }

      // Comments
      if (char === "#") {
        this.skipComment();
        continue;
      }

      // Banned multi-character operators check
      if (this.matchAhead("===")) {
        throw new LexerError(BANNED_SYMBOLS["==="], this.currentSpan(3));
      }
      if (this.matchAhead("!==")) {
        throw new LexerError(BANNED_SYMBOLS["!=="], this.currentSpan(3));
      }
      if (this.matchAhead("&&")) {
        throw new LexerError(BANNED_SYMBOLS["&&"], this.currentSpan(2));
      }
      if (this.matchAhead("||")) {
        throw new LexerError(BANNED_SYMBOLS["||"], this.currentSpan(2));
      }
      if (this.matchAhead("=>")) {
        throw new LexerError(BANNED_SYMBOLS["=>"], this.currentSpan(2));
      }

      // Multi-character operators
      if (this.matchAhead("???")) {
        this.emitToken(TokenType.TYPED_HOLE, "???", 3);
        continue;
      }
      if (this.matchAhead("...")) {
        this.emitToken(TokenType.DOTDOTDOT, "...", 3);
        continue;
      }
      if (this.matchAhead("->")) {
        this.emitToken(TokenType.ARROW, "->", 2);
        continue;
      }
      if (this.matchAhead("<-")) {
        this.emitToken(TokenType.LARROW, "<-", 2);
        continue;
      }
      if (this.matchAhead("|>")) {
        this.emitToken(TokenType.PIPE, "|>", 2);
        continue;
      }
      if (this.matchAhead("==")) {
        this.emitToken(TokenType.EQEQ, "==", 2);
        continue;
      }
      if (this.matchAhead("!=")) {
        this.emitToken(TokenType.NEQ, "!=", 2);
        continue;
      }
      if (this.matchAhead("**")) {
        this.emitToken(TokenType.STARSTAR, "**", 2);
        continue;
      }
      if (this.matchAhead("??")) {
        this.emitToken(TokenType.QUESTIONQUESTION, "??", 2);
        continue;
      }

      // Strings
      if (char === '"') {
        this.readString();
        continue;
      }

      // Numbers
      if (this.isDigit(char)) {
        this.readNumber();
        continue;
      }

      // Identifiers / Keywords
      if (this.isAlpha(char) || char === "_") {
        this.readIdentifierOrKeyword();
        continue;
      }

      // Single-character symbols
      switch (char) {
        case "=":
          this.emitToken(TokenType.EQ, "=", 1);
          break;
        case "|":
          this.emitToken(TokenType.BAR, "|", 1);
          break;
        case "+":
          this.emitToken(TokenType.PLUS, "+", 1);
          break;
        case "-":
          this.emitToken(TokenType.MINUS, "-", 1);
          break;
        case "*":
          this.emitToken(TokenType.STAR, "*", 1);
          break;
        case "/":
          this.emitToken(TokenType.SLASH, "/", 1);
          break;
        case "%":
          this.emitToken(TokenType.PERCENT, "%", 1);
          break;
        case ":":
          this.emitToken(TokenType.COLON, ":", 1);
          break;
        case ",":
          this.emitToken(TokenType.COMMA, ",", 1);
          break;
        case ".":
          this.emitToken(TokenType.DOT, ".", 1);
          break;
        case "(":
          this.parenLevel++;
          this.emitToken(TokenType.LPAREN, "(", 1);
          break;
        case ")":
          if (this.parenLevel > 0) this.parenLevel--;
          this.emitToken(TokenType.RPAREN, ")", 1);
          break;
        case "[":
          this.bracketLevel++;
          this.emitToken(TokenType.LBRACKET, "[", 1);
          break;
        case "]":
          if (this.bracketLevel > 0) this.bracketLevel--;
          this.emitToken(TokenType.RBRACKET, "]", 1);
          break;
        case "{":
          this.braceStack.push("record");
          this.emitToken(TokenType.LBRACE, "{", 1);
          break;
        case "}":
          if (this.braceStack.length > 0 && this.braceStack[this.braceStack.length - 1] === "interpolation") {
            this.braceStack.pop();
            this.emitToken(TokenType.INTERPOLATION_END, "}", 1);
            this.continueStringAfterInterpolation();
          } else {
            if (this.braceStack.length > 0) this.braceStack.pop();
            this.emitToken(TokenType.RBRACE, "}", 1);
          }
          break;
        case "<":
          this.emitToken(TokenType.LT, "<", 1);
          break;
        case ">":
          this.emitToken(TokenType.GT, ">", 1);
          break;
        case "!":
          throw new LexerError(BANNED_SYMBOLS["!"], this.currentSpan(1));
        default:
          throw new LexerError(`Unexpected character '${char}'`, this.currentSpan(1));
      }
    }

    // Flush remaining indentation
    while (this.indentStack.length > 1) {
      this.indentStack.pop();
      this.tokens.push({
        type: TokenType.DEDENT,
        value: "",
        span: this.currentSpan(0),
      });
    }

    // Final EOF token
    this.tokens.push({
      type: TokenType.EOF,
      value: "",
      span: this.currentSpan(0),
    });

    return this.tokens;
  }

  private handleIndentation(): void {
    let spaces = 0;
    const startPos = this.currentPosition();

    while (!this.isAtEnd()) {
      const c = this.peek();
      if (c === " ") {
        spaces++;
        this.advance();
      } else if (c === "\t") {
        throw new LexerError("Tabs are not allowed for indentation; use 2 spaces", this.currentSpan(1));
      } else {
        break;
      }
    }

    // If entire line is blank or comment, ignore indentation
    if (this.peek() === "\r" || this.peek() === "\n" || this.peek() === "#" || this.isAtEnd()) {
      this.atLineStart = false;
      return;
    }

    this.atLineStart = false;

    const currentIndent = this.indentStack[this.indentStack.length - 1];

    if (spaces > currentIndent) {
      this.indentStack.push(spaces);
      this.tokens.push({
        type: TokenType.INDENT,
        value: " ".repeat(spaces),
        span: { start: startPos, end: this.currentPosition() },
      });
    } else if (spaces < currentIndent) {
      while (this.indentStack.length > 1 && this.indentStack[this.indentStack.length - 1] > spaces) {
        this.indentStack.pop();
        this.tokens.push({
          type: TokenType.DEDENT,
          value: "",
          span: { start: startPos, end: this.currentPosition() },
        });
      }
      if (this.indentStack[this.indentStack.length - 1] !== spaces) {
        throw new LexerError(
          `Inconsistent indentation: unindent does not match any outer indentation level (expected ${this.indentStack.join(", ")}, got ${spaces})`,
          { start: startPos, end: this.currentPosition() },
        );
      }
    }
  }

  private advanceNewline(): void {
    const startPos = this.currentPosition();
    if (this.peek() === "\r") this.advance();
    if (this.peek() === "\n") this.advance();

    this.line++;
    this.column = 1;
    this.atLineStart = true;

    const lastToken = this.tokens[this.tokens.length - 1];
    if (lastToken && lastToken.type !== TokenType.NEWLINE && lastToken.type !== TokenType.INDENT) {
      this.tokens.push({
        type: TokenType.NEWLINE,
        value: "\n",
        span: { start: startPos, end: this.currentPosition() },
      });
    }
  }

  private readString(): void {
    const startPos = this.currentPosition();
    this.advance(); // consume opening '"'

    let buffer = "";

    while (!this.isAtEnd() && this.peek() !== '"') {
      const c = this.peek();

      if (c === "\n" || c === "\r") {
        throw new LexerError("Unterminated string literal (newline in string)", {
          start: startPos,
          end: this.currentPosition(),
        });
      }

      if (c === "\\") {
        this.advance();
        if (this.isAtEnd()) break;
        const esc = this.advance();
        if (esc === "n") buffer += "\n";
        else if (esc === "t") buffer += "\t";
        else if (esc === "r") buffer += "\r";
        else if (esc === '"') buffer += '"';
        else if (esc === "\\") buffer += "\\";
        else if (esc === "{") buffer += "{";
        else buffer += "\\" + esc;
        continue;
      }

      if (c === "{") {
        // Start of interpolation
        if (buffer.length > 0) {
          this.tokens.push({
            type: TokenType.STRING_PART,
            value: buffer,
            span: { start: startPos, end: this.currentPosition() },
          });
          buffer = "";
        }
        this.advance(); // consume '{'
        this.braceStack.push("interpolation");
        this.tokens.push({
          type: TokenType.INTERPOLATION_START,
          value: "{",
          span: this.currentSpan(1),
        });
        return; // transition to normal tokenizing for expression inside
      }

      buffer += this.advance();
    }

    if (this.isAtEnd()) {
      throw new LexerError("Unterminated string literal", {
        start: startPos,
        end: this.currentPosition(),
      });
    }

    this.advance(); // consume closing '"'

    this.tokens.push({
      type: TokenType.STRING,
      value: buffer,
      span: { start: startPos, end: this.currentPosition() },
    });
  }

  private continueStringAfterInterpolation(): void {
    const startPos = this.currentPosition();
    let buffer = "";

    while (!this.isAtEnd() && this.peek() !== '"') {
      const c = this.peek();
      if (c === "{" && this.peekPrev() !== "\\") {
        if (buffer.length > 0) {
          this.tokens.push({
            type: TokenType.STRING_PART,
            value: buffer,
            span: { start: startPos, end: this.currentPosition() },
          });
          buffer = "";
        }
        this.advance();
        this.braceStack.push("interpolation");
        this.tokens.push({
          type: TokenType.INTERPOLATION_START,
          value: "{",
          span: this.currentSpan(1),
        });
        return;
      }
      buffer += this.advance();
    }

    if (!this.isAtEnd() && this.peek() === '"') {
      this.advance(); // consume closing '"'
    }

    if (buffer.length > 0) {
      this.tokens.push({
        type: TokenType.STRING_PART,
        value: buffer,
        span: { start: startPos, end: this.currentPosition() },
      });
    }
  }

  private readNumber(): void {
    const startPos = this.currentPosition();
    let raw = "";

    while (!this.isAtEnd() && this.isDigit(this.peek())) {
      raw += this.advance();
    }

    if (!this.isAtEnd() && this.peek() === "." && this.isDigit(this.peekAhead(1))) {
      raw += this.advance(); // consume '.'
      while (!this.isAtEnd() && this.isDigit(this.peek())) {
        raw += this.advance();
      }
    }

    this.tokens.push({
      type: TokenType.NUMBER,
      value: raw,
      span: { start: startPos, end: this.currentPosition() },
    });
  }

  private readIdentifierOrKeyword(): void {
    const startPos = this.currentPosition();
    let raw = "";

    while (!this.isAtEnd() && (this.isAlphaNumeric(this.peek()) || this.peek() === "_")) {
      raw += this.advance();
    }

    const span = { start: startPos, end: this.currentPosition() };

    // Check banned keywords
    if (BANNED_KEYWORDS[raw]) {
      throw new LexerError(BANNED_KEYWORDS[raw], span);
    }

    // Check active keywords
    if (KEYWORDS[raw]) {
      this.tokens.push({
        type: KEYWORDS[raw],
        value: raw,
        span,
      });
      return;
    }

    // Placeholder '_'
    if (raw === "_") {
      this.tokens.push({
        type: TokenType.UNDERSCORE,
        value: "_",
        span,
      });
      return;
    }

    // UpperCamel vs lowerCamel
    if (raw[0] >= "A" && raw[0] <= "Z") {
      this.tokens.push({
        type: TokenType.UPPER_IDENTIFIER,
        value: raw,
        span,
      });
    } else {
      this.tokens.push({
        type: TokenType.IDENTIFIER,
        value: raw,
        span,
      });
    }
  }

  private skipComment(): void {
    while (!this.isAtEnd() && this.peek() !== "\n" && this.peek() !== "\r") {
      this.advance();
    }
  }

  private isAtEnd(): boolean {
    return this.offset >= this.source.length;
  }

  private peek(): string {
    return this.source[this.offset] || "\0";
  }

  private peekPrev(): string {
    return this.source[this.offset - 1] || "\0";
  }

  private peekAhead(n: number): string {
    return this.source[this.offset + n] || "\0";
  }

  private matchAhead(str: string): boolean {
    if (this.source.slice(this.offset, this.offset + str.length) === str) {
      return true;
    }
    return false;
  }

  private advance(): string {
    const c = this.source[this.offset++];
    this.column++;
    return c;
  }

  private emitToken(type: TokenType, value: string, length: number): void {
    const start = this.currentPosition();
    for (let i = 0; i < length; i++) {
      this.advance();
    }
    this.tokens.push({
      type,
      value,
      span: { start, end: this.currentPosition() },
    });
  }

  private isDigit(c: string): boolean {
    return c >= "0" && c <= "9";
  }

  private isAlpha(c: string): boolean {
    return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
  }

  private isAlphaNumeric(c: string): boolean {
    return this.isAlpha(c) || this.isDigit(c);
  }

  private currentPosition(): Position {
    return {
      line: this.line,
      column: this.column,
      offset: this.offset,
    };
  }

  private currentSpan(length: number): Span {
    return {
      start: this.currentPosition(),
      end: {
        line: this.line,
        column: this.column + length,
        offset: this.offset + length,
      },
    };
  }
}
