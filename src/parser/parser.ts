import {
  Program,
  TopLevelDeclaration,
  ImportDeclaration,
  ImportSpecifier,
  ExportDeclaration,
  BindingDeclaration,
  SchemaDeclaration,
  SchemaBody,
  RecordSchema,
  RecordFieldSchema,
  TaggedUnionSchema,
  VariantDeclaration,
  VariantField,
  ErrorDeclaration,
  ErrorField,
  ServiceDeclaration,
  ServiceMember,
  Expression,
  Literal,
  NumberLiteral,
  StringLiteral,
  StringPart,
  BooleanLiteral,
  Identifier,
  UpperIdentifier,
  Placeholder,
  TypedHole,
  PipelineExpression,
  BinaryExpression,
  UnaryExpression,
  CallExpression,
  MemberExpression,
  IndexExpression,
  RecordExpression,
  RecordEntry,
  SpreadEntry,
  FieldEntry,
  DotPathEntry,
  ShorthandEntry,
  ArrayExpression,
  FunctionExpression,
  FunctionBody,
  BlockStatement,
  Statement,
  AssignmentStatement,
  ExpressionStatement,
  MutBlockExpression,
  MatchExpression,
  MatchArm,
  Pattern,
  ConstructorPattern,
  RecordPattern,
  RecordPatternField,
  ArrayPattern,
  OrPattern,
  EffectBlockExpression,
  EffectStatement,
  EffectBindStatement,
  EffectDiscardStatement,
  EffectControlFlowStatement,
  TypeNode,
  TypeReferenceNode,
  TypeParameter,
  Parameter,
  FunctionTypeNode,
  EffectTypeNode,
  RecordTypeNode,
  RecordTypeField,
  ArrayTypeNode,
  UnionTypeNode,
  TsEscapeDeclaration,
  JsExpression,
  TsEscapeExpression,
  TsEscapeTypeNode,
  Span,
  Position,
  JSXElement,
  JSXSelfClosingElement,
  JSXOpeningElement,
  JSXClosingElement,
  JSXAttribute,
  JSXAttributeValue,
  JSXExpressionContainer,
  JSXText,
  JSXChild,
  JSXTagName,
} from "../ast/types.js";
import { Token, TokenType } from "../lexer/tokens.js";

export class ParseError extends Error {
  constructor(
    message: string,
    public span: Span,
  ) {
    super(`${message} at line ${span.start.line}, col ${span.start.column}`);
    this.name = "ParseError";
  }
}

export class Parser {
  private current = 0;
  public diagnostics: ParseError[] = [];

  constructor(
    private tokens: Token[],
    private filename: string = "<anonymous>",
    private source: string = "",
  ) {}

  public getDiagnostics(): ParseError[] {
    return this.diagnostics;
  }

  private synchronize(): void {
    while (!this.isAtEnd()) {
      if (this.peek().type === TokenType.DEDENT) {
        return;
      }
      if (this.advance().type === TokenType.NEWLINE) {
        return;
      }
    }
  }

  public parse(optionsOrThrowOnError: boolean | { throwOnError?: boolean } = true): Program {
    const throwOnError =
      typeof optionsOrThrowOnError === "boolean"
        ? optionsOrThrowOnError
        : (optionsOrThrowOnError?.throwOnError ?? true);

    const start = this.peek().span.start;
    const body: TopLevelDeclaration[] = [];

    this.skipNewlines();

    while (!this.isAtEnd()) {
      if (this.match(TokenType.DEDENT)) {
        continue;
      }
      try {
        body.push(this.parseTopLevelDeclaration());
      } catch (err: any) {
        if (err instanceof ParseError) {
          this.diagnostics.push(err);
          this.synchronize();
        } else {
          throw err;
        }
      }
      this.skipNewlines();
    }

    const end = this.previous().span.end;

    if (throwOnError && this.diagnostics.length > 0) {
      const err = this.diagnostics[0];
      (err as any).diagnostics = this.diagnostics;
      throw err;
    }

    return {
      kind: "Program",
      body,
      span: { start, end },
    };
  }

  // --- Top-Level Declarations ---

  private parseTopLevelDeclaration(): TopLevelDeclaration {
    if (this.match(TokenType.EXPORT)) {
      const exportStart = this.previous().span.start;
      const isJs = this.match(TokenType.JS);
      const decl = this.parseDeclaration(isJs);
      return {
        kind: "ExportDeclaration",
        declaration: decl as any,
        span: { start: exportStart, end: decl.span.end },
      };
    }
    return this.parseDeclaration();
  }

  private parseDeclaration(isJs = false): TopLevelDeclaration {
    if (this.check(TokenType.IMPORT)) {
      return this.parseImportDeclaration();
    }
    if (this.match(TokenType.TS)) {
      const start = this.previous().span.start;
      const code = this.consumeTsCode();
      this.consumeNewlineOrEof("Expected newline after ts declaration");
      return {
        kind: "TsEscapeDeclaration",
        code: code.value,
        span: { start, end: code.span.end },
      };
    }
    if (this.match(TokenType.JS)) {
      return this.parseBindingDeclaration(true);
    }
    if (this.check(TokenType.SCHEMA)) {
      return this.parseSchemaDeclaration();
    }
    if (this.check(TokenType.ERROR)) {
      return this.parseErrorDeclaration();
    }
    if (this.check(TokenType.SERVICE)) {
      return this.parseServiceDeclaration();
    }
    return this.parseBindingDeclaration(isJs);
  }

  /** Consumes the raw TypeScript payload the lexer captured after 'ts'. */
  private consumeTsCode(): Token {
    return this.consume(TokenType.TS_CODE, "Expected \"...\" or an indented block after 'ts'");
  }

  private parseImportDeclaration(): ImportDeclaration {
    const start = this.consume(TokenType.IMPORT, "Expected 'import'").span.start;
    const isTypeOnly = this.match(TokenType.IDENTIFIER) && this.previous().value === "type";

    this.consume(TokenType.LBRACE, "Expected '{' in import declaration");
    const specifiers: ImportSpecifier[] = [];

    if (!this.check(TokenType.RBRACE)) {
      do {
        let specTypeOnly = false;
        if (this.check(TokenType.IDENTIFIER) && this.peek().value === "type" && this.peekAhead(1).type !== TokenType.COMMA && this.peekAhead(1).type !== TokenType.RBRACE) {
          this.advance();
          specTypeOnly = true;
        }

        const importedId = this.parseAnyIdentifier();
        let localId = importedId;

        if (this.check(TokenType.IDENTIFIER) && this.peek().value === "as") {
          this.advance();
          localId = this.parseAnyIdentifier();
        }

        specifiers.push({
          kind: "ImportSpecifier",
          isTypeOnly: specTypeOnly,
          imported: importedId,
          local: localId,
          span: { start: importedId.span.start, end: localId.span.end },
        });
      } while (this.match(TokenType.COMMA) && !this.check(TokenType.RBRACE));
    }

    this.consume(TokenType.RBRACE, "Expected '}' after import specifiers");
    this.consume(TokenType.FROM, "Expected 'from' after import specifiers");

    const source = this.parseStringLiteral();
    this.consumeNewlineOrEof("Expected newline after import declaration");

    return {
      kind: "ImportDeclaration",
      isTypeOnly,
      specifiers,
      source,
      span: { start, end: source.span.end },
    };
  }

  private parseSchemaDeclaration(): SchemaDeclaration {
    const start = this.consume(TokenType.SCHEMA, "Expected 'schema'").span.start;
    const id = this.parseUpperIdentifier();
    let typeParams: TypeParameter[] | undefined;

    if (this.check(TokenType.LT)) {
      typeParams = this.parseTypeParameters();
    }

    this.consume(TokenType.EQ, "Expected '=' after schema name");

    const body = this.parseSchemaBody();
    this.consumeNewlineOrEof("Expected newline after schema declaration");

    return {
      kind: "SchemaDeclaration",
      id,
      typeParams,
      body,
      span: { start, end: body.span.end },
    };
  }

  private parseSchemaBody(): SchemaBody {
    this.skipNewlines();

    // 1. Tagged Union: | Variant(...)
    if (this.check(TokenType.BAR) || (this.check(TokenType.INDENT) && this.peekAhead(1).type === TokenType.BAR)) {
      return this.parseTaggedUnionSchema();
    }

    // 2. Struct Schema: { ... }
    if (this.check(TokenType.LBRACE)) {
      return this.parseRecordSchema();
    }

    // 3. Function / Effect type alias or Refinement
    const typeNode = this.parseTypeNode();
    if (this.match(TokenType.PIPE)) {
      const refinement = this.parseExpression();
      return {
        kind: "RefinementSchema",
        baseType: typeNode,
        refinement,
        span: { start: typeNode.span.start, end: refinement.span.end },
      };
    }

    return {
      kind: "TypeSignatureSchema",
      signature: typeNode as any,
      span: typeNode.span,
    };
  }

  private parseRecordSchema(): RecordSchema {
    const start = this.consume(TokenType.LBRACE, "Expected '{'").span.start;
    const fields: RecordFieldSchema[] = [];

    this.skipNewlines();
    const hasIndent = this.match(TokenType.INDENT);

    while (!this.check(TokenType.RBRACE) && !this.check(TokenType.DEDENT) && !this.isAtEnd()) {
      this.skipNewlines();
      if (this.check(TokenType.RBRACE) || this.check(TokenType.DEDENT)) break;

      const fieldName = this.parseIdentifier();
      this.consume(TokenType.COLON, "Expected ':' after field name");
      const fieldType = this.parseTypeNode();
      let defaultValue: Expression | undefined;

      if (this.match(TokenType.EQ)) {
        defaultValue = this.parseExpression();
      }

      fields.push({
        kind: "RecordFieldSchema",
        name: fieldName,
        typeAnnotation: fieldType,
        defaultValue,
        span: { start: fieldName.span.start, end: (defaultValue || fieldType).span.end },
      });

      this.match(TokenType.COMMA);
      this.skipNewlines();
    }

    if (hasIndent) {
      this.consume(TokenType.DEDENT, "Expected unindent after schema fields");
    }
    this.skipNewlines();
    const end = this.consume(TokenType.RBRACE, "Expected '}' after record schema").span.end;

    return {
      kind: "RecordSchema",
      fields,
      span: { start, end },
    };
  }

  private parseTaggedUnionSchema(): TaggedUnionSchema {
    const start = this.peek().span.start;
    const variants: VariantDeclaration[] = [];
    const hasIndent = this.match(TokenType.INDENT);

    while (this.match(TokenType.BAR) || (variants.length === 0 && this.check(TokenType.UPPER_IDENTIFIER))) {
      const varStart = this.previous().span.start;
      const varName = this.parseUpperIdentifier();
      const fields: VariantField[] = [];

      if (this.match(TokenType.LPAREN)) {
        if (!this.check(TokenType.RPAREN)) {
          do {
            const fName = this.parseIdentifier();
            this.consume(TokenType.COLON, "Expected ':' after variant field name");
            const fType = this.parseTypeNode();
            fields.push({
              kind: "VariantField",
              name: fName,
              typeAnnotation: fType,
              span: { start: fName.span.start, end: fType.span.end },
            });
          } while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));
        }
        this.consume(TokenType.RPAREN, "Expected ')' after variant fields");
      }

      variants.push({
        kind: "VariantDeclaration",
        name: varName,
        fields,
        span: { start: varStart, end: this.previous().span.end },
      });

      this.skipNewlines();
      if (!this.check(TokenType.BAR)) break;
    }

    if (hasIndent) {
      this.consume(TokenType.DEDENT, "Expected unindent after tagged union variants");
    }

    return {
      kind: "TaggedUnionSchema",
      variants,
      span: { start, end: variants[variants.length - 1].span.end },
    };
  }

  private parseErrorDeclaration(): ErrorDeclaration {
    const start = this.consume(TokenType.ERROR, "Expected 'error'").span.start;
    const id = this.parseUpperIdentifier();
    const fields: ErrorField[] = [];

    if (this.match(TokenType.LPAREN)) {
      if (!this.check(TokenType.RPAREN)) {
        do {
          const fName = this.parseIdentifier();
          this.consume(TokenType.COLON, "Expected ':' after error field name");
          const fType = this.parseTypeNode();
          fields.push({
            kind: "ErrorField",
            name: fName,
            typeAnnotation: fType,
            span: { start: fName.span.start, end: fType.span.end },
          });
        } while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));
      }
      this.consume(TokenType.RPAREN, "Expected ')' after error fields");
    }

    this.consumeNewlineOrEof("Expected newline after error declaration");

    return {
      kind: "ErrorDeclaration",
      id,
      fields,
      span: { start, end: this.previous().span.end },
    };
  }

  private parseServiceDeclaration(): ServiceDeclaration {
    const start = this.consume(TokenType.SERVICE, "Expected 'service'").span.start;
    const id = this.parseUpperIdentifier();
    let customTag: StringLiteral | undefined;

    if (this.check(TokenType.STRING)) {
      customTag = this.parseStringLiteral();
    }

    this.consume(TokenType.NEWLINE, "Expected newline before service members");
    this.consume(TokenType.INDENT, "Expected indent before service members");

    const members: ServiceMember[] = [];
    while (!this.check(TokenType.DEDENT) && !this.isAtEnd()) {
      this.skipNewlines();
      if (this.check(TokenType.DEDENT)) break;

      const mStart = this.peek().span.start;
      const mName = this.parseIdentifier();
      this.consume(TokenType.COLON, "Expected ':' after service member name");
      const sig = this.parseFunctionTypeNode();

      members.push({
        kind: "ServiceMember",
        name: mName,
        signature: sig,
        span: { start: mStart, end: sig.span.end },
      });

      this.skipNewlines();
    }

    this.consume(TokenType.DEDENT, "Expected unindent after service members");

    return {
      kind: "ServiceDeclaration",
      id,
      customTag,
      members,
      span: { start, end: this.previous().span.end },
    };
  }

  private parseBindingDeclaration(isJs = false): BindingDeclaration {
    const start = this.peek().span.start;
    const isMut = this.match(TokenType.MUT);
    const id = this.parseAnyIdentifier();
    let typeAnnotation: TypeNode | undefined;

    if (this.match(TokenType.COLON)) {
      typeAnnotation = this.parseTypeNode();
    }

    this.consume(TokenType.EQ, "Expected '=' in binding declaration");
    let hasIndent = false;
    if (this.match(TokenType.NEWLINE)) {
      hasIndent = this.match(TokenType.INDENT);
    }
    const init = this.parseExpression();
    if (hasIndent) {
      this.skipNewlines();
      if (!this.isAtEnd() && !this.check(TokenType.EOF)) {
        this.consume(TokenType.DEDENT, "Expected unindent after binding expression");
      }
    }
    this.consumeNewlineOrEof("Expected newline after binding");

    return {
      kind: "BindingDeclaration",
      isMut,
      isJs,
      id,
      typeAnnotation,
      init,
      span: { start, end: init.span.end },
    };
  }

  // --- Expressions & Pratt Parser ---

  public parseExpression(): Expression {
    return this.parsePipeline();
  }

  private parsePipeline(): Expression {
    let expr = this.parseLogicalOr();

    while (this.checkPipelinePipe()) {
      this.consumePipelinePipe();
      this.skipNewlines();
      const right = this.parsePipelineTarget();
      expr = {
        kind: "PipelineExpression",
        left: expr,
        right,
        span: { start: expr.span.start, end: right.span.end },
      };
    }

    return expr;
  }

  private checkPipelinePipe(): boolean {
    if (this.check(TokenType.PIPE)) return true;
    if (this.check(TokenType.NEWLINE)) {
      let offset = 1;
      while (this.peekAhead(offset).type === TokenType.NEWLINE) offset++;
      if (this.peekAhead(offset).type === TokenType.PIPE) return true;
    }
    return false;
  }

  private consumePipelinePipe(): void {
    if (this.match(TokenType.PIPE)) return;
    this.skipNewlines();
    this.consume(TokenType.PIPE, "Expected '|>' in pipeline");
  }

  private parsePipelineTarget(): Expression {
    if (this.match(TokenType.MUT)) {
      return this.parseMutBlock();
    }
    return this.parseLogicalOr();
  }

  private parseMutBlock(): MutBlockExpression {
    const start = this.previous().span.start;
    this.consume(TokenType.LPAREN, "Expected '(' after 'mut'");
    const draftParam = this.parseIdentifier();
    this.consume(TokenType.RPAREN, "Expected ')' after draft param");
    this.consume(TokenType.ARROW, "Expected '->' in mut block");

    const body = this.parseFunctionBody();
    return {
      kind: "MutBlockExpression",
      draftParam,
      body,
      span: { start, end: body.span.end },
    };
  }

  private parseLogicalOr(): Expression {
    let expr = this.parseLogicalAnd();
    while (this.match(TokenType.OR)) {
      const right = this.parseLogicalAnd();
      expr = {
        kind: "BinaryExpression",
        operator: "or",
        left: expr,
        right,
        span: { start: expr.span.start, end: right.span.end },
      };
    }
    return expr;
  }

  private parseLogicalAnd(): Expression {
    let expr = this.parseNullishCoalescing();
    while (this.match(TokenType.AND)) {
      const right = this.parseNullishCoalescing();
      expr = {
        kind: "BinaryExpression",
        operator: "and",
        left: expr,
        right,
        span: { start: expr.span.start, end: right.span.end },
      };
    }
    return expr;
  }

  private parseNullishCoalescing(): Expression {
    let expr = this.parseEquality();
    while (this.match(TokenType.QUESTIONQUESTION)) {
      const right = this.parseEquality();
      expr = {
        kind: "BinaryExpression",
        operator: "??",
        left: expr,
        right,
        span: { start: expr.span.start, end: right.span.end },
      };
    }
    return expr;
  }

  private parseEquality(): Expression {
    let expr = this.parseAdditive();
    while (this.match(TokenType.EQEQ, TokenType.NEQ)) {
      const op = this.previous().value as "==" | "!=";
      const right = this.parseAdditive();
      expr = {
        kind: "BinaryExpression",
        operator: op,
        left: expr,
        right,
        span: { start: expr.span.start, end: right.span.end },
      };
    }
    return expr;
  }

  private parseAdditive(): Expression {
    let expr = this.parseMultiplicative();
    while (this.match(TokenType.PLUS, TokenType.MINUS)) {
      const op = this.previous().value as "+" | "-";
      const right = this.parseMultiplicative();
      expr = {
        kind: "BinaryExpression",
        operator: op,
        left: expr,
        right,
        span: { start: expr.span.start, end: right.span.end },
      };
    }
    return expr;
  }

  private parseMultiplicative(): Expression {
    let expr = this.parseExponent();
    while (this.match(TokenType.STAR, TokenType.SLASH, TokenType.PERCENT)) {
      const op = this.previous().value as "*" | "/" | "%";
      const right = this.parseExponent();
      expr = {
        kind: "BinaryExpression",
        operator: op,
        left: expr,
        right,
        span: { start: expr.span.start, end: right.span.end },
      };
    }
    return expr;
  }

  private parseExponent(): Expression {
    let expr = this.parseUnary();
    if (this.match(TokenType.STARSTAR)) {
      const right = this.parseExponent(); // Right-associative
      expr = {
        kind: "BinaryExpression",
        operator: "**",
        left: expr,
        right,
        span: { start: expr.span.start, end: right.span.end },
      };
    }
    return expr;
  }

  private parseUnary(): Expression {
    if (this.match(TokenType.NOT, TokenType.MINUS)) {
      const op = this.previous().value as "not" | "-";
      const arg = this.parseUnary();
      return {
        kind: "UnaryExpression",
        operator: op,
        argument: arg,
        span: { start: this.previous().span.start, end: arg.span.end },
      };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expression {
    let expr = this.parsePrimary();

    while (true) {
      if (this.match(TokenType.LPAREN)) {
        const args: Expression[] = [];
        if (!this.check(TokenType.RPAREN)) {
          do {
            args.push(this.parseExpression());
          } while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));
        }
        const end = this.consume(TokenType.RPAREN, "Expected ')' after call arguments").span.end;
        expr = {
          kind: "CallExpression",
          callee: expr,
          args,
          span: { start: expr.span.start, end },
        };
      } else if (this.match(TokenType.DOT)) {
        const prop = this.parseAnyIdentifier();
        expr = {
          kind: "MemberExpression",
          object: expr,
          property: prop as any,
          span: { start: expr.span.start, end: prop.span.end },
        };
      } else if (this.match(TokenType.LBRACKET)) {
        const index = this.parseExpression();
        const end = this.consume(TokenType.RBRACKET, "Expected ']' after index").span.end;
        expr = {
          kind: "IndexExpression",
          object: expr,
          index,
          span: { start: expr.span.start, end },
        };
      } else {
        break;
      }
    }

    return expr;
  }

  private parsePrimary(): Expression {
    // 0. JSX Element: <tag ...> or <tag ... />
    if (this.check(TokenType.JSX_TAG_OPEN)) {
      return this.parseJsxElement();
    }

    // 1. Placeholder _
    if (this.match(TokenType.UNDERSCORE)) {
      return {
        kind: "Placeholder",
        span: this.previous().span,
      };
    }

    // 2. Typed hole ???
    if (this.match(TokenType.TYPED_HOLE)) {
      const start = this.previous().span.start;
      let label: string | undefined;
      if (this.check(TokenType.STRING)) {
        label = this.parseStringLiteral().parts.map((p) => (p.kind === "StringRawPart" ? p.value : "")).join("");
      }
      return {
        kind: "TypedHole",
        label,
        span: { start, end: this.previous().span.end },
      };
    }

    // 3. Literals
    if (this.match(TokenType.NUMBER)) {
      const tok = this.previous();
      return {
        kind: "NumberLiteral",
        value: parseFloat(tok.value),
        raw: tok.value,
        span: tok.span,
      };
    }
    if (
      this.check(TokenType.STRING) ||
      this.check(TokenType.STRING_PART) ||
      this.check(TokenType.INTERPOLATION_START)
    ) {
      return this.parseStringLiteral();
    }
    if (this.match(TokenType.TRUE)) {
      return { kind: "BooleanLiteral", value: true, span: this.previous().span };
    }
    if (this.match(TokenType.FALSE)) {
      return { kind: "BooleanLiteral", value: false, span: this.previous().span };
    }

    // 4. Identifiers & Constructors
    if (this.match(TokenType.UPPER_IDENTIFIER)) {
      return {
        kind: "UpperIdentifier",
        name: this.previous().value,
        span: this.previous().span,
      };
    }
    if (this.match(TokenType.IDENTIFIER)) {
      return {
        kind: "Identifier",
        name: this.previous().value,
        span: this.previous().span,
      };
    }

    // 5. Parenthesized expression or arrow function
    if (this.match(TokenType.LPAREN)) {
      const start = this.previous().span.start;
      if (this.match(TokenType.RPAREN)) {
        // Zero-arg lambda: () -> ...
        if (this.match(TokenType.ARROW)) {
          const body = this.parseFunctionBody();
          return {
            kind: "FunctionExpression",
            params: [],
            body,
            span: { start, end: body.span.end },
          };
        }
        throw new ParseError("Empty parentheses '()' must be followed by '->'", this.previous().span);
      }

      // Check if this looks like function params (param: Type, ...) ->
      const firstExpr = this.parseExpression();

      if (this.check(TokenType.COLON) || this.check(TokenType.COMMA)) {
        const params: Parameter[] = [];
        let pType: TypeNode | undefined;
        if (this.match(TokenType.COLON)) {
          pType = this.parseTypeNode();
        }
        params.push({
          kind: "Parameter",
          name: firstExpr as Identifier,
          typeAnnotation: pType,
          span: firstExpr.span,
        });

        while (this.match(TokenType.COMMA)) {
          const pName = this.parseIdentifier();
          let nextType: TypeNode | undefined;
          if (this.match(TokenType.COLON)) {
            nextType = this.parseTypeNode();
          }
          params.push({
            kind: "Parameter",
            name: pName,
            typeAnnotation: nextType,
            span: pName.span,
          });
        }

        this.consume(TokenType.RPAREN, "Expected ')' after parameters");
        let returnType: TypeNode | undefined;
        if (this.match(TokenType.COLON)) {
          returnType = this.parseTypeNode();
        }
        this.consume(TokenType.ARROW, "Expected '->' after parameters");
        const body = this.parseFunctionBody();
        return {
          kind: "FunctionExpression",
          params,
          returnType,
          body,
          span: { start, end: body.span.end },
        };
      }

      this.consume(TokenType.RPAREN, "Expected ')' after expression");

      let singleReturnType: TypeNode | undefined;
      if (this.match(TokenType.COLON)) {
        singleReturnType = this.parseTypeNode();
      }

      if (this.match(TokenType.ARROW)) {
        const body = this.parseFunctionBody();
        return {
          kind: "FunctionExpression",
          params: [{ kind: "Parameter", name: firstExpr as Identifier, span: firstExpr.span }],
          returnType: singleReturnType,
          body,
          span: { start, end: body.span.end },
        };
      }

      return firstExpr;
    }

    // 6. Zero-arg function: -> body
    if (this.match(TokenType.ARROW)) {
      const start = this.previous().span.start;
      const body = this.parseFunctionBody();
      return {
        kind: "FunctionExpression",
        params: [],
        body,
        span: { start, end: body.span.end },
      };
    }

    // 7. Record Literal: { ... }
    if (this.check(TokenType.LBRACE)) {
      return this.parseRecordLiteral();
    }

    // 8. Array Literal: [ ... ]
    if (this.check(TokenType.LBRACKET)) {
      return this.parseArrayLiteral();
    }

    // 9. Match Expression: match ...
    if (this.match(TokenType.MATCH)) {
      return this.parseMatchExpression();
    }

    // 10. Effect Block: effect ...
    if (this.match(TokenType.EFFECT)) {
      return this.parseEffectBlock();
    }

    // 11. JS Expression or bare 'js' pipeline stage
    if (this.match(TokenType.JS)) {
      const start = this.previous().span.start;
      if (
        this.isAtEnd() ||
        this.check(TokenType.NEWLINE) ||
        this.check(TokenType.EOF) ||
        this.check(TokenType.DEDENT) ||
        this.check(TokenType.RPAREN)
      ) {
        return {
          kind: "Identifier",
          name: "js",
          span: this.previous().span,
        };
      }
      const inner = this.parseExpression();
      return {
        kind: "JsExpression",
        expression: inner,
        span: { start, end: inner.span.end },
      };
    }

    // 12. TS escape hatch: ts "raw TypeScript expression"
    if (this.match(TokenType.TS)) {
      const start = this.previous().span.start;
      const code = this.consumeTsCode();
      return {
        kind: "TsEscapeExpression",
        code: code.value,
        span: { start, end: code.span.end },
      };
    }

    throw new ParseError(`Unexpected token '${this.peek().value}' (${this.peek().type})`, this.peek().span);
  }

  private parseRecordLiteral(): RecordExpression {
    const start = this.consume(TokenType.LBRACE, "Expected '{'").span.start;
    const entries: RecordEntry[] = [];

    this.skipNewlines();
    const hasIndent = this.match(TokenType.INDENT);

    while (!this.check(TokenType.RBRACE) && !this.check(TokenType.DEDENT) && !this.isAtEnd()) {
      this.skipNewlines();
      if (this.check(TokenType.RBRACE) || this.check(TokenType.DEDENT)) break;

      if (this.match(TokenType.DOTDOTDOT)) {
        const arg = this.parseExpression();
        entries.push({
          kind: "SpreadEntry",
          argument: arg,
          span: { start: this.previous().span.start, end: arg.span.end },
        });
      } else {
        const firstId = this.parseIdentifier();
        if (this.match(TokenType.DOT)) {
          // Dot-path entry: address.city: "Paris"
          const path: Identifier[] = [firstId];
          do {
            path.push(this.parseIdentifier());
          } while (this.match(TokenType.DOT));

          this.consume(TokenType.COLON, "Expected ':' after dot-path");
          const val = this.parseExpression();
          entries.push({
            kind: "DotPathEntry",
            path,
            value: val,
            span: { start: firstId.span.start, end: val.span.end },
          });
        } else if (this.match(TokenType.COLON)) {
          const val = this.parseExpression();
          entries.push({
            kind: "FieldEntry",
            key: firstId,
            value: val,
            span: { start: firstId.span.start, end: val.span.end },
          });
        } else {
          // Shorthand { x }
          entries.push({
            kind: "ShorthandEntry",
            key: firstId,
            span: firstId.span,
          });
        }
      }

      this.match(TokenType.COMMA);
      this.skipNewlines();
    }

    if (hasIndent) {
      this.consume(TokenType.DEDENT, "Expected unindent in record literal");
    }
    this.skipNewlines();
    const end = this.consume(TokenType.RBRACE, "Expected '}'").span.end;

    return {
      kind: "RecordExpression",
      entries,
      span: { start, end },
    };
  }

  private parseArrayLiteral(): ArrayExpression {
    const start = this.consume(TokenType.LBRACKET, "Expected '['").span.start;
    const elements: Expression[] = [];

    this.skipNewlines();
    if (!this.check(TokenType.RBRACKET)) {
      do {
        this.skipNewlines();
        if (this.check(TokenType.RBRACKET)) break;
        elements.push(this.parseExpression());
      } while (this.match(TokenType.COMMA) && !this.check(TokenType.RBRACKET));
    }

    this.skipNewlines();
    const end = this.consume(TokenType.RBRACKET, "Expected ']'").span.end;

    return {
      kind: "ArrayExpression",
      elements,
      span: { start, end },
    };
  }

  // --- Match & Patterns ---

  private parseMatchExpression(): MatchExpression {
    const start = this.previous().span.start;
    let scrutinee: Expression | undefined;

    // Check if scrutinee is present or if it's a subjectless boolean match
    if (!this.check(TokenType.BAR) && !this.check(TokenType.NEWLINE) && !this.check(TokenType.INDENT)) {
      scrutinee = this.parseExpression();
    }

    this.skipNewlines();
    const hasIndent = this.match(TokenType.INDENT);
    const arms: MatchArm[] = [];

    const isSubjectless = scrutinee === undefined;
    while (this.match(TokenType.BAR)) {
      const armStart = this.previous().span.start;
      let pattern: Pattern;

      if (isSubjectless) {
        if (this.match(TokenType.UNDERSCORE)) {
          pattern = { kind: "WildcardPattern", span: this.previous().span };
        } else {
          const condExpr = this.parseExpression();
          pattern = {
            kind: "LiteralPattern",
            literal: {
              kind: "BooleanLiteral",
              value: true,
              rawExpr: condExpr,
              span: condExpr.span,
            } as any,
            span: condExpr.span,
          };
        }
      } else {
        pattern = this.parsePattern();
      }

      let guard: Expression | undefined;

      if (this.match(TokenType.WHEN)) {
        guard = this.parseExpression();
      }

      this.consume(TokenType.ARROW, "Expected '->' in match arm");
      const body = this.parseFunctionBody();

      arms.push({
        kind: "MatchArm",
        pattern,
        guard,
        body,
        span: { start: armStart, end: body.span.end },
      });

      this.skipNewlines();
      if (!this.check(TokenType.BAR)) break;
    }

    if (hasIndent) {
      this.consume(TokenType.DEDENT, "Expected unindent after match arms");
    }

    return {
      kind: "MatchExpression",
      scrutinee,
      arms,
      span: { start, end: arms[arms.length - 1]?.span.end || start },
    };
  }

  private parsePattern(): Pattern {
    let pat = this.parsePrimaryPattern();
    if (this.match(TokenType.BAR)) {
      const patterns: Pattern[] = [pat];
      do {
        patterns.push(this.parsePrimaryPattern());
      } while (this.match(TokenType.BAR));
      return {
        kind: "OrPattern",
        patterns,
        span: { start: pat.span.start, end: patterns[patterns.length - 1].span.end },
      };
    }
    return pat;
  }

  private parsePrimaryPattern(): Pattern {
    if (this.match(TokenType.UNDERSCORE)) {
      return { kind: "WildcardPattern", span: this.previous().span };
    }
    if (this.match(TokenType.NUMBER)) {
      return {
        kind: "LiteralPattern",
        literal: { kind: "NumberLiteral", value: parseFloat(this.previous().value), raw: this.previous().value, span: this.previous().span },
        span: this.previous().span,
      };
    }
    if (this.check(TokenType.STRING)) {
      const lit = this.parseStringLiteral();
      return {
        kind: "LiteralPattern",
        literal: lit,
        span: lit.span,
      };
    }
    if (this.match(TokenType.TRUE, TokenType.FALSE)) {
      return {
        kind: "LiteralPattern",
        literal: { kind: "BooleanLiteral", value: this.previous().value === "true", span: this.previous().span },
        span: this.previous().span,
      };
    }
    if (this.match(TokenType.UPPER_IDENTIFIER)) {
      const start = this.previous().span.start;
      const constructorName: UpperIdentifier = { kind: "UpperIdentifier", name: this.previous().value, span: this.previous().span };
      const args: Pattern[] = [];

      if (this.match(TokenType.LPAREN)) {
        if (!this.check(TokenType.RPAREN)) {
          do {
            args.push(this.parsePattern());
          } while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));
        }
        this.consume(TokenType.RPAREN, "Expected ')' after constructor pattern args");
      }

      return {
        kind: "ConstructorPattern",
        constructorName,
        args,
        span: { start, end: this.previous().span.end },
      };
    }
    if (this.match(TokenType.IDENTIFIER)) {
      return {
        kind: "VariablePattern",
        name: { kind: "Identifier", name: this.previous().value, span: this.previous().span },
        span: this.previous().span,
      };
    }

    throw new ParseError(`Unexpected pattern token '${this.peek().value}'`, this.peek().span);
  }

  // --- Effect Blocks ---

  private parseEffectBlock(): EffectBlockExpression {
    const start = this.previous().span.start;
    this.consume(TokenType.NEWLINE, "Expected newline after 'effect'");
    this.consume(TokenType.INDENT, "Expected indent after 'effect'");

    const body: EffectStatement[] = [];
    let finalExpression: Expression | undefined;

    while (!this.check(TokenType.DEDENT) && !this.isAtEnd()) {
      this.skipNewlines();
      if (this.check(TokenType.DEDENT)) break;

      // Check for effect bind: x <- eff or _ <- eff
      if (this.check(TokenType.UNDERSCORE) && this.peekAhead(1).type === TokenType.LARROW) {
        this.advance(); // consume '_'
        this.advance(); // consume '<-'
        const eff = this.parseExpression();
        this.consumeNewlineOrEof("Expected newline after discard bind");
        body.push({
          kind: "EffectDiscardStatement",
          effect: eff,
          span: { start: eff.span.start, end: eff.span.end },
        });
      } else if (this.check(TokenType.IDENTIFIER) && this.peekAhead(1).type === TokenType.LARROW) {
        const id = this.parseIdentifier();
        this.advance(); // consume '<-'
        const eff = this.parseExpression();
        this.consumeNewlineOrEof("Expected newline after effect bind");
        body.push({
          kind: "EffectBindStatement",
          id,
          effect: eff,
          span: { start: id.span.start, end: eff.span.end },
        });
      } else if (
        this.check(TokenType.MUT) ||
        (this.check(TokenType.IDENTIFIER) && (this.peekAhead(1).type === TokenType.EQ || this.peekAhead(1).type === TokenType.COLON)) ||
        (this.check(TokenType.UNDERSCORE) && this.peekAhead(1).type === TokenType.EQ)
      ) {
        if (this.check(TokenType.UNDERSCORE)) {
          this.advance(); // consume '_'
          this.advance(); // consume '='
          const discardExpr = this.parseExpression();
          this.consumeNewlineOrEof("Expected newline");
          body.push({
            kind: "BindingDeclaration",
            isMut: false,
            id: { kind: "Identifier", name: "_", span: discardExpr.span },
            init: discardExpr,
            span: discardExpr.span,
          });
        } else {
          const bind = this.parseBindingDeclaration();
          body.push(bind);
        }
      } else {
        // Expression - must be the final line or control flow
        const expr = this.parseExpression();
        this.skipNewlines();
        if (this.check(TokenType.DEDENT)) {
          finalExpression = expr;
          break;
        } else {
          throw new ParseError(
            "Non-final bare expression in effect block is not executed. Use '<-' to run an effect or '_ <-' to discard its value.",
            expr.span,
          );
        }
      }
    }

    this.consume(TokenType.DEDENT, "Expected unindent after effect block");

    if (!finalExpression) {
      throw new ParseError("Effect block must end with a return expression", { start, end: this.previous().span.end });
    }

    return {
      kind: "EffectBlockExpression",
      body,
      finalExpression,
      span: { start, end: finalExpression.span.end },
    };
  }

  private parseFunctionBody(): FunctionBody {
    if (this.match(TokenType.NEWLINE)) {
      this.consume(TokenType.INDENT, "Expected indent for function body block");
      const statements: Statement[] = [];
      let finalExpression: Expression | undefined;

      while (!this.check(TokenType.DEDENT) && !this.isAtEnd()) {
        this.skipNewlines();
        if (this.check(TokenType.DEDENT)) break;

        try {
          if (
            this.check(TokenType.MUT) ||
            (this.check(TokenType.IDENTIFIER) && (this.peekAhead(1).type === TokenType.EQ || this.peekAhead(1).type === TokenType.COLON)) ||
            (this.check(TokenType.UNDERSCORE) && this.peekAhead(1).type === TokenType.EQ)
          ) {
            if (this.check(TokenType.UNDERSCORE)) {
              this.advance(); // consume '_'
              this.advance(); // consume '='
              const discardExpr = this.parseExpression();
              this.consumeNewlineOrEof("Expected newline");
              statements.push({
                kind: "BindingDeclaration",
                isMut: false,
                id: { kind: "Identifier", name: "_", span: discardExpr.span },
                init: discardExpr,
                span: discardExpr.span,
              });
            } else {
              const bind = this.parseBindingDeclaration();
              this.skipNewlines();
              if (this.check(TokenType.DEDENT)) {
                statements.push(bind);
                finalExpression = bind.id;
                break;
              } else {
                statements.push(bind);
              }
            }
          } else {
            const expr = this.parseExpression();
            this.skipNewlines();

            if (this.check(TokenType.DEDENT)) {
              finalExpression = expr;
              break;
            } else {
              statements.push({
                kind: "ExpressionStatement",
                expression: expr,
                span: expr.span,
              });
            }
          }
        } catch (err: any) {
          if (err instanceof ParseError) {
            this.diagnostics.push(err);
            this.synchronize();
          } else {
            throw err;
          }
        }
      }

      this.consume(TokenType.DEDENT, "Expected unindent after function body");
      const fallbackExpr: Expression = {
        kind: "Identifier",
        name: "_error",
        span: { start: this.previous().span.start, end: this.previous().span.end },
      };
      return {
        kind: "BlockStatement",
        statements,
        finalExpression: finalExpression ?? fallbackExpr,
        span: { start: statements[0]?.span.start || this.previous().span.start, end: (finalExpression ?? fallbackExpr).span.end },
      };
    }

    return this.parseExpression();
  }

  // --- Types ---

  private parseTypeNode(): TypeNode {
    return this.parseFunctionTypeNode();
  }

  private parseFunctionTypeNode(): FunctionTypeNode {
    const start = this.peek().span.start;
    if (this.match(TokenType.LPAREN)) {
      const params: Parameter[] = [];
      if (!this.check(TokenType.RPAREN)) {
        do {
          const pName = this.parseIdentifier();
          this.consume(TokenType.COLON, "Expected ':' after param name");
          const pType = this.parsePrimaryType();
          params.push({
            kind: "Parameter",
            name: pName,
            typeAnnotation: pType,
            span: { start: pName.span.start, end: pType.span.end },
          });
        } while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));
      }
      this.consume(TokenType.RPAREN, "Expected ')'");
      this.consume(TokenType.ARROW, "Expected '->' in function type");
      const ret = this.parsePrimaryType();
      return {
        kind: "FunctionTypeNode",
        params: params as any,
        returnType: ret,
        span: { start, end: ret.span.end },
      };
    }

    return this.parsePrimaryType() as any;
  }

  private parsePrimaryType(): TypeNode {
    if (this.match(TokenType.LBRACE)) {
      const start = this.previous().span.start;
      const fields: RecordTypeField[] = [];
      this.skipNewlines();
      const hasIndent = this.match(TokenType.INDENT);

      while (!this.check(TokenType.RBRACE) && !this.check(TokenType.DEDENT) && !this.isAtEnd()) {
        this.skipNewlines();
        if (this.check(TokenType.RBRACE) || this.check(TokenType.DEDENT)) break;
        const fName = this.parseIdentifier();
        this.consume(TokenType.COLON, "Expected ':' after field name");
        const fType = this.parseTypeNode();
        fields.push({
          kind: "RecordTypeField",
          name: fName,
          typeAnnotation: fType,
          span: { start: fName.span.start, end: fType.span.end },
        });
        this.match(TokenType.COMMA);
        this.skipNewlines();
      }

      if (hasIndent) {
        this.consume(TokenType.DEDENT, "Expected unindent in record type");
      }
      this.skipNewlines();
      const end = this.consume(TokenType.RBRACE, "Expected '}'").span.end;
      return { kind: "RecordTypeNode", fields, span: { start, end } };
    }

    // TS escape hatch for types: ts "Record<string, unknown>"
    if (this.match(TokenType.TS)) {
      const start = this.previous().span.start;
      const code = this.consumeTsCode();
      return {
        kind: "TsEscapeTypeNode",
        code: code.value,
        span: { start, end: code.span.end },
      };
    }

    if (this.check(TokenType.UPPER_IDENTIFIER) && this.peek().value === "Effect") {
      return this.parseEffectTypeNode();
    }

    const typeId = this.parseAnyIdentifier();
    let typeArgs: TypeNode[] | undefined;

    if (this.match(TokenType.LT)) {
      typeArgs = [];
      do {
        typeArgs.push(this.parsePrimaryType());
      } while (this.match(TokenType.COMMA) && !this.check(TokenType.GT));
      this.consume(TokenType.GT, "Expected '>' after type arguments");
    }

    return {
      kind: "TypeReferenceNode",
      name: typeId as any,
      typeArgs,
      span: { start: typeId.span.start, end: this.previous().span.end },
    };
  }

  private parseEffectTypeNode(): EffectTypeNode {
    const start = this.advance().span.start; // consume 'Effect'
    this.consume(TokenType.LT, "Expected '<' after Effect");
    const success = this.parsePrimaryType();
    let error: TypeNode | undefined;
    let requirements: TypeNode | undefined;

    if (this.match(TokenType.COMMA)) {
      error = this.parsePrimaryType();
      if (this.match(TokenType.COMMA)) {
        requirements = this.parsePrimaryType();
      }
    }

    this.consume(TokenType.GT, "Expected '>' after Effect type args");

    return {
      kind: "EffectTypeNode",
      success,
      error,
      requirements,
      span: { start, end: this.previous().span.end },
    };
  }

  private parseTypeParameters(): TypeParameter[] {
    this.consume(TokenType.LT, "Expected '<'");
    const params: TypeParameter[] = [];
    do {
      const id = this.parseUpperIdentifier();
      params.push({ kind: "TypeParameter", name: id, span: id.span });
    } while (this.match(TokenType.COMMA) && !this.check(TokenType.GT));
    this.consume(TokenType.GT, "Expected '>'");
    return params;
  }

  // --- JSX Parsing ---

  public parseJsxElement(): JSXElement | JSXSelfClosingElement {
    const start = this.consume(TokenType.JSX_TAG_OPEN, "Expected '<'").span.start;
    const tagName = this.parseJsxTagName();

    const attributes: JSXAttribute[] = [];
    while (
      !this.check(TokenType.JSX_TAG_CLOSE) &&
      !this.check(TokenType.JSX_SLASH_CLOSE) &&
      !this.isAtEnd()
    ) {
      this.skipNewlines();
      if (this.check(TokenType.JSX_TAG_CLOSE) || this.check(TokenType.JSX_SLASH_CLOSE)) break;
      attributes.push(this.parseJsxAttribute());
      this.skipNewlines();
    }

    if (this.match(TokenType.JSX_SLASH_CLOSE)) {
      const slashClose = this.previous();
      return {
        kind: "JSXSelfClosingElement",
        name: tagName,
        attributes,
        span: { start, end: slashClose.span.end },
      };
    }

    const tagClose = this.consume(TokenType.JSX_TAG_CLOSE, "Expected '>' or '/>' after JSX attributes");
    const openingElement: JSXOpeningElement = {
      kind: "JSXOpeningElement",
      name: tagName,
      attributes,
      span: { start, end: tagClose.span.end },
    };

    const children: JSXChild[] = [];
    while (!this.check(TokenType.JSX_CLOSING_TAG_OPEN) && !this.isAtEnd()) {
      if (this.check(TokenType.JSX_TAG_OPEN)) {
        children.push(this.parseJsxElement());
      } else if (this.check(TokenType.LBRACE)) {
        children.push(this.parseJsxExpressionContainer());
      } else if (this.check(TokenType.JSX_TEXT)) {
        const textTok = this.advance();
        const raw = textTok.value;
        // Skip whitespace-only formatting lines between tags
        if (/^\s*[\r\n]\s*$/.test(raw)) {
          continue;
        }
        // Normalize leading and trailing newlines from multiline text, preserving inline spacing
        const value = raw.replace(/^\s*[\r\n]+\s*/, "").replace(/\s*[\r\n]+\s*$/, "");
        children.push({
          kind: "JSXText",
          value,
          raw,
          span: textTok.span,
        });
      } else {
        throw new ParseError(`Unexpected token '${this.peek().value}' in JSX children`, this.peek().span);
      }
    }

    const closingStart = this.consume(
      TokenType.JSX_CLOSING_TAG_OPEN,
      `Expected closing tag for <${this.formatTagName(tagName)}>`,
    ).span.start;
    const closingName = this.parseJsxTagName();
    const closingGt = this.consume(TokenType.JSX_TAG_CLOSE, "Expected '>' to close tag");

    if (!this.areTagNamesEqual(tagName, closingName)) {
      throw new ParseError(
        `Expected closing tag </${this.formatTagName(tagName)}>, found </${this.formatTagName(closingName)}>`,
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

  private parseJsxTagName(): JSXTagName {
    if (this.check(TokenType.JSX_TAG_CLOSE)) {
      // Empty fragment tag (<> or </>)
      const pos = this.peek().span.start;
      return {
        kind: "Identifier",
        name: "",
        span: { start: pos, end: pos },
      };
    }

    if (!this.check(TokenType.IDENTIFIER) && !this.check(TokenType.UPPER_IDENTIFIER)) {
      throw new ParseError(`Expected JSX tag name, found '${this.peek().value}'`, this.peek().span);
    }

    let name: JSXTagName = this.parseAnyIdentifier();
    while (this.match(TokenType.DOT)) {
      const prop = this.parseAnyIdentifier();
      name = {
        kind: "MemberExpression",
        object: name as Expression,
        property: prop as any,
        span: { start: name.span.start, end: prop.span.end },
      };
    }
    return name;
  }

  private parseJsxAttribute(): JSXAttribute {
    let nameTok: Token;
    if (this.check(TokenType.JSX_ATTRIBUTE_NAME)) {
      nameTok = this.advance();
    } else if (this.check(TokenType.IDENTIFIER) || this.check(TokenType.UPPER_IDENTIFIER)) {
      nameTok = this.advance();
    } else {
      throw new ParseError(`Expected attribute name, found '${this.peek().value}'`, this.peek().span);
    }

    const nameNode: Identifier | UpperIdentifier =
      nameTok.type === TokenType.UPPER_IDENTIFIER
        ? { kind: "UpperIdentifier", name: nameTok.value, span: nameTok.span }
        : { kind: "Identifier", name: nameTok.value, span: nameTok.span };

    if (this.match(TokenType.EQ)) {
      let value: JSXAttributeValue;
      if (this.check(TokenType.STRING) || this.check(TokenType.STRING_PART)) {
        value = this.parseStringLiteral();
      } else if (this.check(TokenType.LBRACE)) {
        value = this.parseJsxExpressionContainer();
      } else {
        throw new ParseError(
          `Expected attribute value (string or expression container), found '${this.peek().value}'`,
          this.peek().span,
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

  private parseJsxExpressionContainer(): JSXExpressionContainer {
    const start = this.consume(TokenType.LBRACE, "Expected '{'").span.start;
    this.skipNewlines();
    const hasIndent = this.match(TokenType.INDENT);
    this.skipNewlines();
    const expression = this.parseExpression();
    this.skipNewlines();
    if (hasIndent) {
      this.match(TokenType.DEDENT);
      this.skipNewlines();
    }
    const end = this.consume(TokenType.RBRACE, "Expected '}' after JSX expression").span.end;
    return {
      kind: "JSXExpressionContainer",
      expression,
      span: { start, end },
    };
  }

  private formatTagName(name: JSXTagName): string {
    if (name.kind === "Identifier" || name.kind === "UpperIdentifier") {
      return name.name;
    }
    if (name.kind === "MemberExpression") {
      const obj = this.formatTagName(name.object as JSXTagName);
      return `${obj}.${name.property.name}`;
    }
    return "";
  }

  private areTagNamesEqual(a: JSXTagName, b: JSXTagName): boolean {
    return this.formatTagName(a) === this.formatTagName(b);
  }

  // --- Helpers ---

  private parseIdentifier(): Identifier {
    const tok = this.consume(TokenType.IDENTIFIER, "Expected lowercase identifier");
    return { kind: "Identifier", name: tok.value, span: tok.span };
  }

  private parseUpperIdentifier(): UpperIdentifier {
    const tok = this.consume(TokenType.UPPER_IDENTIFIER, "Expected UpperCamel identifier");
    return { kind: "UpperIdentifier", name: tok.value, span: tok.span };
  }

  private parseAnyIdentifier(): Identifier | UpperIdentifier {
    if (this.check(TokenType.UPPER_IDENTIFIER)) return this.parseUpperIdentifier();
    return this.parseIdentifier();
  }

  private parseStringLiteral(): StringLiteral {
    const start = this.peek().span.start;
    const parts: StringPart[] = [];

    if (this.match(TokenType.STRING)) {
      return {
        kind: "StringLiteral",
        parts: [{ kind: "StringRawPart", value: this.previous().value }],
        raw: `"${this.previous().value}"`,
        span: this.previous().span,
      };
    }

    while (this.check(TokenType.STRING_PART) || this.check(TokenType.INTERPOLATION_START)) {
      if (this.match(TokenType.STRING_PART)) {
        parts.push({ kind: "StringRawPart", value: this.previous().value });
      } else if (this.match(TokenType.INTERPOLATION_START)) {
        const expr = this.parseExpression();
        this.consume(TokenType.INTERPOLATION_END, "Expected '}' to close interpolation");
        parts.push({ kind: "StringInterpolationPart", expression: expr });
      }
    }

    return {
      kind: "StringLiteral",
      parts,
      raw: "",
      span: { start, end: this.previous().span.end },
    };
  }

  private skipNewlines(): void {
    while (this.match(TokenType.NEWLINE)) {}
  }

  private consumeNewlineOrEof(message: string): void {
    if (
      this.isAtEnd() ||
      this.check(TokenType.DEDENT) ||
      this.previous().type === TokenType.DEDENT ||
      this.previous().type === TokenType.NEWLINE
    ) {
      return;
    }
    if (this.previous().span.end.line < this.peek().span.start.line) return;
    if (this.match(TokenType.NEWLINE)) {
      this.skipNewlines();
      return;
    }
    throw new ParseError(`${message} (got '${this.peek().value}', expected NEWLINE)`, this.peek().span);
  }

  private match(...types: TokenType[]): boolean {
    for (const type of types) {
      if (this.check(type)) {
        this.advance();
        return true;
      }
    }
    return false;
  }

  private check(type: TokenType): boolean {
    if (this.isAtEnd()) return type === TokenType.EOF;
    return this.peek().type === type;
  }

  private advance(): Token {
    if (!this.isAtEnd()) this.current++;
    return this.previous();
  }

  private isAtEnd(): boolean {
    return this.peek().type === TokenType.EOF;
  }

  private peek(): Token {
    return this.tokens[this.current] || this.tokens[this.tokens.length - 1];
  }

  private peekAhead(n: number): Token {
    return this.tokens[this.current + n] || this.tokens[this.tokens.length - 1];
  }

  private previous(): Token {
    return this.tokens[this.current - 1];
  }

  private consume(type: TokenType, message: string): Token {
    if (this.check(type)) return this.advance();
    throw new ParseError(`${message} (got '${this.peek().value}', expected ${type})`, this.peek().span);
  }
}
