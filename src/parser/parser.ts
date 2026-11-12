import {
  Program,
  TopLevelDeclaration,
  ImportDeclaration,
  ImportSpecifier,
  ExportDeclaration,
  ExportDefaultDeclaration,
  BindingDeclaration,
  BindingTarget,
  SchemaDeclaration,
  SchemaBody,
  RecordSchema,
  RecordFieldSchema,
  TaggedUnionSchema,
  ImportedTsSchema,
  VariantDeclaration,
  VariantField,
  TsDerivedSchema,
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
  DotPathExpression,
  RecordExpression,
  RecordEntry,
  SpreadEntry,
  SpreadElement,
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
  ReturnStatement,
  WhenStatement,
  MutBlockExpression,
  MatchExpression,
  MatchArm,
  Pattern,
  ConstructorPattern,
  RecordPattern,
  RecordPatternField,
  ArrayPattern,
  RestPattern,
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
  IntersectionTypeNode,
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
import { Token, TokenType, KEYWORDS } from "../lexer/tokens.js";
import { FunScriptError } from "../errors.js";

export class ParseError extends FunScriptError {
  constructor(message: string, span: Span) {
    super(message, span);
    this.name = "ParseError";
  }
}

export const FUNCTION_RETURN_DIAGNOSTIC =
  "Function block must end with an explicit '=> returnValue'. Multi-statement functions require an explicit return arrow to distinguish returned values from side effects. Use '=> value' or rewrite as an inline single-expression lambda '(args) => expr'. See docs/syntax.md#311-explicit-returns-and-conditional-execution.";

export const EFFECT_RETURN_DIAGNOSTIC =
  "Effect block must end with an explicit '=> returnValue'. Effect blocks require an explicit return arrow to ensure values are yielded and returned properly. Use '=> value' to return, or '_ <- effect' followed by '=> Unit' to discard. See docs/syntax.md#93-the-non-final-expression-rule-and-control-flow-lowering.";

export const EFFECT_BARE_EXPR_DIAGNOSTIC =
  "Non-final bare expression in effect block is not executed. Use '<-' to run an effect or '_ <-' to discard its value. See docs/syntax.md#93-the-non-final-expression-rule-and-control-flow-lowering.";

export interface ParserOptions {
  throwOnError?: boolean;
  allowLegacyReturns?: boolean;
  isFunx?: boolean;
}

export class Parser {
  private current = 0;
  public diagnostics: ParseError[] = [];
  private functionDepth = 0;
  private mutableVariables = new Set<string>();
  private mutDraftVariables = new Set<string>();
  private parsingBraceEffect = false;
  private hasDefaultExport = false;
  private allowOptionalRecordFields = false;
  private recordTypeDepth = 0;
  private options: ParserOptions;
  private isFunx: boolean;

  constructor(
    private tokens: Token[],
    private filename: string = "<anonymous>",
    private source: string = "",
    options?: ParserOptions,
  ) {
    this.options = { ...options };
    this.isFunx = options?.isFunx ?? this.filename.endsWith(".funx");
  }

  public getDiagnostics(): ParseError[] {
    return this.diagnostics;
  }

  private synchronize(): void {
    while (!this.isAtEnd()) {
      if (this.peek().type === TokenType.DEDENT) {
        return;
      }
      const tok = this.advance();
      if (tok.type === TokenType.NEWLINE || tok.type === TokenType.RBRACE) {
        return;
      }
    }
  }

  public parse(optionsOrThrowOnError: boolean | ParserOptions = true): Program {
    const opts: ParserOptions =
      typeof optionsOrThrowOnError === "boolean"
        ? { throwOnError: optionsOrThrowOnError }
        : (optionsOrThrowOnError ?? {});
    const throwOnError = opts.throwOnError ?? this.options.throwOnError ?? true;
    if (opts.allowLegacyReturns !== undefined) {
      this.options.allowLegacyReturns = opts.allowLegacyReturns;
    }
    if (opts.isFunx !== undefined) {
      this.isFunx = opts.isFunx;
    }
    this.hasDefaultExport = false;

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
      if (this.match(TokenType.DEFAULT)) {
        return this.parseExportDefaultDeclaration(exportStart);
      }
      const isJs = this.match(TokenType.JS);
      const isTs = !isJs && this.match(TokenType.TS);
      const decl = this.parseDeclaration(isJs, isTs);
      return {
        kind: "ExportDeclaration",
        declaration: decl as any,
        span: { start: exportStart, end: decl.span.end },
      };
    }
    return this.parseDeclaration();
  }

  private parseExportDefaultDeclaration(start: Position): ExportDefaultDeclaration {
    if (this.hasDefaultExport) {
      throw new ParseError("Multiple default exports are not allowed", {
        start,
        end: this.previous().span.end,
      });
    }
    this.hasDefaultExport = true;
    let hasIndent = false;
    if (this.match(TokenType.NEWLINE)) {
      hasIndent = this.match(TokenType.INDENT);
    }
    const expression = this.parseExpression();
    if (hasIndent) {
      this.skipNewlines();
      if (!this.isAtEnd() && !this.check(TokenType.EOF)) {
        this.consume(TokenType.DEDENT, "Expected unindent after default export");
      }
    }
    this.consumeNewlineOrEof("Expected newline after default export");
    return {
      kind: "ExportDefaultDeclaration",
      expression,
      span: { start, end: expression.span.end },
    };
  }

  private parseDeclaration(isJs = false, isTs = false): TopLevelDeclaration {
    if (this.check(TokenType.IMPORT)) {
      return this.parseImportDeclaration();
    }
    if (isTs) {
      if (this.check(TokenType.SCHEMA)) {
        return this.parseSchemaDeclaration(true);
      }
      throw new ParseError("Expected 'schema' after 'export ts'", this.peek().span);
    }
    if (this.match(TokenType.TS)) {
      const start = this.previous().span.start;
      if (this.check(TokenType.SCHEMA)) {
        return this.parseSchemaDeclaration(true, start);
      }
      const code = this.consumeTsCode();
      this.consumeNewlineOrEof("Expected newline after ts declaration");
      return {
        kind: "TsEscapeDeclaration",
        code: code.value,
        span: { start, end: code.span.end },
      };
    }
    if (this.match(TokenType.JS)) {
      if (this.check(TokenType.IDENTIFIER) && this.peek().value === "fn") {
        return this.parseFunctionDeclaration(true);
      }
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
    if (this.check(TokenType.WHEN)) {
      return this.parseWhenStatement();
    }
    if (this.check(TokenType.IDENTIFIER) && this.peek().value === "fn") {
      return this.parseFunctionDeclaration(isJs);
    }
    return this.parseBindingDeclaration(isJs);
  }

  /** Consumes the raw TypeScript payload the lexer captured after 'ts'. */
  private consumeTsCode(): Token {
    return this.consume(TokenType.TS_CODE, "Expected '{ ... }' after 'ts'");
  }

  private parseImportDeclaration(): ImportDeclaration {
    const start = this.consume(TokenType.IMPORT, "Expected 'import'").span.start;
    if (this.check(TokenType.STRING)) {
      const source = this.parseImportSource();
      this.consumeNewlineOrEof("Expected newline after import declaration");
      return { kind: "ImportDeclaration", isTypeOnly: false, isSideEffect: true, specifiers: [], source, span: { start, end: source.span.end } };
    }
    const isTypeOnly = this.check(TokenType.IDENTIFIER) && this.peek().value === "type" && this.peekAhead(1).type !== TokenType.FROM;
    if (isTypeOnly) this.advance();
    let defaultBinding: Identifier | UpperIdentifier | undefined;
    let namespaceBinding: Identifier | UpperIdentifier | undefined;
    const specifiers: ImportSpecifier[] = [];
    if (this.check(TokenType.IDENTIFIER) || this.check(TokenType.UPPER_IDENTIFIER)) {
      defaultBinding = this.parseAnyIdentifier();
      if (this.match(TokenType.COMMA)) {
        if (isTypeOnly) throw new ParseError("A type-only import cannot combine a default binding with other bindings", this.peek().span);
      } else {
        this.consume(TokenType.FROM, "Expected 'from' after import binding");
        const source = this.parseImportSource();
        this.consumeNewlineOrEof("Expected newline after import declaration");
        return { kind: "ImportDeclaration", isTypeOnly, isSideEffect: false, defaultBinding, specifiers, source, span: { start, end: source.span.end } };
      }
    }
    if (this.match(TokenType.STAR)) {
      if (!(this.check(TokenType.IDENTIFIER) && this.peek().value === "as")) {
        throw new ParseError("Expected 'as' after '*' in namespace import", this.peek().span);
      }
      this.advance();
      namespaceBinding = this.parseAnyIdentifier();
    } else {
      this.consume(TokenType.LBRACE, "Expected '{' or '*' in import declaration");
      if (!this.check(TokenType.RBRACE)) {
        do {
          let specTypeOnly = false;
          if (this.check(TokenType.IDENTIFIER) && this.peek().value === "type" && this.peekAhead(1).type !== TokenType.COMMA && this.peekAhead(1).type !== TokenType.RBRACE && this.peekAhead(1).value !== "as") {
            this.advance();
            specTypeOnly = true;
            if (isTypeOnly) throw new ParseError("A type-only import cannot contain a type-only specifier", this.previous().span);
          }
          let importedId: Identifier | UpperIdentifier;
          if (this.match(TokenType.DEFAULT)) {
            const token = this.previous();
            importedId = { kind: "Identifier", name: token.value, span: token.span };
          } else importedId = this.parseAnyIdentifier();
          let localId = importedId;
          if (this.check(TokenType.IDENTIFIER) && this.peek().value === "as") {
            this.advance();
            localId = this.parseAnyIdentifier();
          } else if (importedId.name === "default") {
            throw new ParseError("A default import specifier requires an alias", importedId.span);
          }
          specifiers.push({ kind: "ImportSpecifier", isTypeOnly: specTypeOnly, imported: importedId, local: localId, span: { start: importedId.span.start, end: localId.span.end } });
        } while (this.match(TokenType.COMMA) && !this.check(TokenType.RBRACE));
      }
      this.consume(TokenType.RBRACE, "Expected '}' after import specifiers");
    }
    this.consume(TokenType.FROM, "Expected 'from' after import specifiers");
    const source = this.parseImportSource();
    this.consumeNewlineOrEof("Expected newline after import declaration");
    return { kind: "ImportDeclaration", isTypeOnly, isSideEffect: false, defaultBinding, namespaceBinding, specifiers, source, span: { start, end: source.span.end } };
  }

  private parseImportSource(): StringLiteral {
    if (!this.check(TokenType.STRING)) {
      throw new ParseError("Expected a non-interpolated string module specifier", this.peek().span);
    }
    return this.parseStringLiteral();
  }

  private parseSchemaDeclaration(isTs = false, tsStart?: Position): SchemaDeclaration {
    const start = tsStart ?? this.consume(TokenType.SCHEMA, "Expected 'schema'").span.start;
    if (tsStart) {
      this.consume(TokenType.SCHEMA, "Expected 'schema'");
    }
    const id = this.parseUpperIdentifier();
    let typeParams: TypeParameter[] | undefined;

    if (this.check(TokenType.LT)) {
      typeParams = this.parseTypeParameters();
    }

    this.consume(TokenType.EQ, "Expected '=' after schema name");

    const body = isTs ? this.parseTsDerivedSchema() : this.parseSchemaBody();
    this.consumeNewlineOrEof("Expected newline after schema declaration");

    return {
      kind: "SchemaDeclaration",
      id,
      typeParams,
      body,
      isTs: isTs ? true : undefined,
      span: { start, end: body.span.end },
    };
  }

  private parseTsDerivedSchema(): TsDerivedSchema {
    this.skipNewlines();
    const targetType = this.parseTypeNode();
    return {
      kind: "TsDerivedSchema",
      targetType,
      span: targetType.span,
    };
  }

  private parseSchemaBody(): SchemaBody {
    this.skipNewlines();

    // 0. Imported TypeScript Schema: from ts<Type>
    if (this.check(TokenType.FROM)) {
      return this.parseImportedTsSchema();
    }

    // 1. Tagged Union: | Variant(...)
    if (this.check(TokenType.BAR) || (this.check(TokenType.INDENT) && this.peekAhead(1).type === TokenType.BAR)) {
      const first = this.check(TokenType.INDENT) ? this.peekAhead(2) : this.peekAhead(1);
      if ([TokenType.STRING, TokenType.NUMBER, TokenType.TRUE, TokenType.FALSE, TokenType.LBRACE].includes(first.type)) {
        return this.parseStructuralUnionSchema();
      }
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

  private parseImportedTsSchema(): ImportedTsSchema {
    const fromToken = this.consume(TokenType.FROM, "Expected 'from'");
    const tsToken = this.consume(TokenType.TS, "Expected 'ts' after 'from'");
    const ltToken = this.consume(TokenType.LT, "Expected '<' after 'ts'");

    if (this.check(TokenType.GT)) {
      throw new ParseError("Expected type argument inside 'ts<...>'", this.peek().span);
    }

    const typeArgs: TypeNode[] = [];
    do {
      typeArgs.push(this.parseTypeNode());
    } while (this.match(TokenType.COMMA) && !this.check(TokenType.GT));

    const gtToken = this.consume(TokenType.GT, "Expected '>' after type argument");

    return {
      kind: "ImportedTsSchema",
      typeNode: typeArgs[0],
      typeArgs,
      typeArguments: typeArgs,
      span: { start: fromToken.span.start, end: gtToken.span.end },
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

      const fieldName: Identifier = this.parseRecordKeyIdentifier();
      const optional = this.match(TokenType.QUESTION);
      this.consume(TokenType.COLON, "Expected ':' after field name");
      const previous = this.allowOptionalRecordFields;
      this.allowOptionalRecordFields = true;
      let fieldType: TypeNode;
      try { fieldType = this.parseTypeNode(); }
      finally { this.allowOptionalRecordFields = previous; }
      let defaultValue: Expression | undefined;

      if (this.match(TokenType.EQ)) {
        if (optional) throw new ParseError("A schema field cannot be both optional and defaulted", fieldName.span);
        defaultValue = this.parseExpression();
      }

      fields.push({
        kind: "RecordFieldSchema",
        name: fieldName,
        typeAnnotation: fieldType,
        optional,
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

  private parseStructuralUnionSchema(): import("../ast/types.js").StructuralUnionSchema {
    const start = this.peek().span.start;
    const hasIndent = this.match(TokenType.INDENT);
    const members: TypeNode[] = [];
    while (this.match(TokenType.BAR)) {
      const previous = this.allowOptionalRecordFields;
      this.allowOptionalRecordFields = true;
      try { members.push(this.parsePrimaryType()); }
      finally { this.allowOptionalRecordFields = previous; }
      this.skipNewlines();
    }
    if (hasIndent) this.consume(TokenType.DEDENT, "Expected unindent after union members");
    return { kind: "StructuralUnionSchema", members, span: { start, end: members[members.length - 1].span.end } };
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
    let id: BindingTarget;
    if (this.check(TokenType.LBRACE) || this.check(TokenType.LBRACKET)) {
      id = this.parsePattern() as RecordPattern | ArrayPattern;
      if (isMut) {
        for (const name of this.collectPatternVariables(id)) {
          this.mutableVariables.add(name);
        }
      }
    } else {
      id = this.parseAnyIdentifier();
      if (isMut) {
        this.mutableVariables.add(id.name);
      }
    }
    let typeParams: TypeParameter[] | undefined;
    if ((id.kind === "Identifier" || id.kind === "UpperIdentifier") && this.check(TokenType.LT)) {
      typeParams = this.parseTypeParameters();
    }
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
    if (typeParams) {
      if (init.kind !== "FunctionExpression") {
        throw new ParseError("Generic type parameters require a function initializer", typeParams[0].span);
      }
      if (init.typeParams?.length) {
        throw new ParseError("Generic type parameters may be declared either after the binding name or before the parameter list, not both", typeParams[0].span);
      }
      init.typeParams = typeParams;
      init.span = { start: typeParams[0].span.start, end: init.span.end };
    }
    if (isJs && init.kind === "FunctionExpression" && init.params.some((p) => p.optional || p.defaultValue || (p.typeAnnotation?.kind === "RecordTypeNode" && p.typeAnnotation.fields.some((field) => field.optional || field.defaultValue)))) {
      throw new ParseError("Optional and defaulted parameters are not yet supported on js entry bindings", init.span);
    }
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

  private expressionToBindingTarget(expr: Expression): BindingTarget | null {
    if (expr.kind === "Identifier" || expr.kind === "UpperIdentifier") {
      return expr;
    }
    if (expr.kind === "Placeholder") {
      return { kind: "Identifier", name: "_", span: expr.span };
    }
    if (expr.kind === "RecordExpression") {
      const fields: RecordPatternField[] = [];
      for (const entry of expr.entries) {
        if (entry.kind === "SpreadEntry") {
          if (entry.argument.kind !== "Identifier") return null;
          fields.push({
            kind: "RecordPatternField",
            key: entry.argument,
            isRest: true,
            span: entry.span,
          });
        } else if (entry.kind === "ShorthandEntry") {
          fields.push({
            kind: "RecordPatternField",
            key: entry.key,
            span: entry.span,
          });
        } else if (entry.kind === "FieldEntry") {
          const subTarget = this.expressionToBindingTarget(entry.value);
          if (!subTarget) return null;
          const subPattern: Pattern = subTarget.kind === "Identifier" || subTarget.kind === "UpperIdentifier"
            ? { kind: "VariablePattern", name: subTarget as Identifier, span: subTarget.span }
            : subTarget;
          fields.push({
            kind: "RecordPatternField",
            key: entry.key,
            pattern: subPattern,
            span: entry.span,
          });
        } else {
          return null;
        }
      }
      return {
        kind: "RecordPattern",
        fields,
        span: expr.span,
      };
    }
    if (expr.kind === "ArrayExpression") {
      const elements: Pattern[] = [];
      for (const el of expr.elements) {
        if (el.kind === "SpreadElement") {
          const subTarget = this.expressionToBindingTarget(el.argument);
          if (!subTarget) return null;
          elements.push({
            kind: "RestPattern",
            argument: subTarget.kind === "Identifier" || subTarget.kind === "UpperIdentifier"
              ? { kind: "VariablePattern", name: subTarget as Identifier, span: subTarget.span }
              : subTarget,
            span: el.span,
          });
        } else {
          const subTarget = this.expressionToBindingTarget(el);
          if (!subTarget) return null;
          elements.push(
            subTarget.kind === "Identifier" || subTarget.kind === "UpperIdentifier"
              ? { kind: "VariablePattern", name: subTarget as Identifier, span: subTarget.span }
              : subTarget
          );
        }
      }
      return {
        kind: "ArrayPattern",
        elements,
        span: expr.span,
      };
    }
    return null;
  }

  private parseValueParameter(name: BindingTarget, nameOnlySpan = false, isRest = false): Parameter {
    const optional = this.match(TokenType.QUESTION);
    let typeAnnotation: TypeNode | undefined;
    if (this.match(TokenType.COLON)) {
      const previous = this.allowOptionalRecordFields;
      this.allowOptionalRecordFields = this.check(TokenType.LBRACE);
      try { typeAnnotation = this.parseTypeNode(); }
      finally { this.allowOptionalRecordFields = previous; }
    }
    if (optional && !typeAnnotation) throw new ParseError("Optional parameters require a type annotation", name.span);
    const defaultValue = this.match(TokenType.EQ) ? this.parseExpression() : undefined;
    if (optional && defaultValue) throw new ParseError("A parameter cannot be both optional and defaulted", name.span);
    return {
      kind: "Parameter",
      name,
      typeAnnotation,
      optional,
      defaultValue,
      isRest: isRest ? true : undefined,
      span: nameOnlySpan ? name.span : { start: name.span.start, end: (defaultValue ?? typeAnnotation ?? name).span.end },
    };
  }

  private validateValueParameters(params: Parameter[]): void {
    for (let i = 0; i < params.length; i++) {
      if (params[i].optional && params.slice(i + 1).some((p) => !p.optional && !p.isRest)) {
        throw new ParseError("Only optional parameters may follow an optional parameter", params[i].span);
      }
      if (params[i].isRest) {
        if (i !== params.length - 1) {
          throw new ParseError("A rest parameter must be the last parameter in a parameter list", params[i].span);
        }
        if (params[i].optional) {
          throw new ParseError("A rest parameter cannot be optional", params[i].span);
        }
        if (params[i].defaultValue) {
          throw new ParseError("A rest parameter cannot have a default value", params[i].span);
        }
      }
    }
  }

  private parseFunctionDeclaration(isJs = false): BindingDeclaration {
    const start = this.peek().span.start;
    this.advance(); // consume 'fn'

    const id = this.parseIdentifier();
    let typeParams: TypeParameter[] | undefined;
    if (this.check(TokenType.LT)) {
      typeParams = this.parseTypeParameters();
    }

    this.consume(TokenType.LPAREN, "Expected '(' after function name");
    const params: Parameter[] = [];
    if (!this.check(TokenType.RPAREN)) {
      do {
        let isRest = false;
        let dotSpan: Span | undefined;
        if (this.match(TokenType.DOTDOTDOT)) {
          isRest = true;
          dotSpan = this.previous().span;
        }
        let target: BindingTarget;
        if (this.check(TokenType.LBRACE) || this.check(TokenType.LBRACKET)) {
          target = this.parsePattern() as RecordPattern | ArrayPattern;
        } else {
          target = this.parseIdentifier();
        }
        const p = this.parseValueParameter(target, false, isRest);
        if (dotSpan) {
          p.span = { start: dotSpan.start, end: p.span.end };
        }
        params.push(p);
      } while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));
    }
    this.consume(TokenType.RPAREN, "Expected ')' after parameters");
    this.validateValueParameters(params);
    if (isJs && params.some((p) => p.optional || p.defaultValue || (p.typeAnnotation?.kind === "RecordTypeNode" && p.typeAnnotation.fields.some((field) => field.optional || field.defaultValue)))) {
      throw new ParseError("Optional and defaulted parameters are not yet supported on js entry bindings", params[0].span);
    }

    let returnType: TypeNode | undefined;
    if (this.match(TokenType.COLON)) {
      returnType = this.parseTypeNode();
    }

    let body: FunctionBody;
    const requireExplicitReturn = !this.options.allowLegacyReturns;
    if (this.match(TokenType.ARROW)) {
      if (
        !returnType &&
        (this.check(TokenType.UPPER_IDENTIFIER) || this.check(TokenType.IDENTIFIER)) &&
        (this.peekAhead(1).type === TokenType.LBRACE ||
          this.peekAhead(1).type === TokenType.NEWLINE ||
          this.peekAhead(1).type === TokenType.ARROW)
      ) {
        returnType = this.parseTypeNode();
        if (this.match(TokenType.ARROW)) {
          // consumed arrow before expression body
        }
        body = this.parseFunctionBody(requireExplicitReturn);
      } else {
        body = this.parseFunctionBody(requireExplicitReturn);
      }
    } else if (this.check(TokenType.LBRACE)) {
      this.consume(TokenType.LBRACE, "Expected '{'");
      body = this.parseBraceBlock(requireExplicitReturn);
    } else if (this.match(TokenType.NEWLINE)) {
      this.consume(TokenType.INDENT, "Expected indent for function body block");
      body = this.parseIndentedBlock(requireExplicitReturn);
    } else {
      throw new ParseError("Expected '=>', '{', or newline for function body", this.peek().span);
    }

    this.skipNewlines();

    return {
      kind: "BindingDeclaration",
      isMut: false,
      isJs,
      id,
      init: {
        kind: "FunctionExpression",
        typeParams,
        params,
        returnType,
        body,
        span: { start, end: body.span.end },
      },
      span: { start, end: body.span.end },
    };
  }

  private parseWhenStatement(): WhenStatement {
    const start = this.consume(TokenType.WHEN, "Expected 'when'").span.start;
    let condition: Expression;
    if (this.match(TokenType.LPAREN)) {
      condition = this.parseExpression();
      this.consume(TokenType.RPAREN, "Expected ')' after when condition");
    } else {
      condition = this.parseExpression();
    }

    if (this.match(TokenType.ARROW)) {
      if (this.functionDepth === 0) {
        throw new ParseError("Early return 'when (...) =>' is rejected outside function context", this.previous().span);
      }
      const earlyExpr = this.parseExpression();
      this.consumeNewlineOrEof();
      return {
        kind: "WhenStatement",
        condition,
        consequent: earlyExpr,
        isEarlyReturn: true,
        span: { start, end: earlyExpr.span.end },
      };
    }

    if (this.check(TokenType.LBRACE)) {
      this.consume(TokenType.LBRACE, "Expected '{'");
      const blockBody = this.parseBraceBlock();
      return {
        kind: "WhenStatement",
        condition,
        consequent: blockBody,
        isEarlyReturn: false,
        span: { start, end: blockBody.span.end },
      };
    }

    if (this.match(TokenType.NEWLINE)) {
      this.consume(TokenType.INDENT, "Expected indent for when block");
      const blockBody = this.parseIndentedBlock();
      return {
        kind: "WhenStatement",
        condition,
        consequent: blockBody,
        isEarlyReturn: false,
        span: { start, end: blockBody.span.end },
      };
    }

    throw new ParseError("Expected '=>' or conditional block '{ ... }' after when condition", this.peek().span);
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
    if (this.match(TokenType.MATCH)) {
      return this.parseMatchExpression(true);
    }
    return this.parseLogicalOr();
  }

  private parseMutBlock(): MutBlockExpression {
    const start = this.previous().span.start;
    this.consume(TokenType.LPAREN, "Expected '(' after 'mut'");
    const draftParam = this.parseIdentifier();
    this.consume(TokenType.RPAREN, "Expected ')' after draft param");
    if (!this.match(TokenType.ARROW)) {
      throw new ParseError("Expected '=>' in mut block", this.peek().span);
    }

    this.mutDraftVariables.add(draftParam.name);
    let body: FunctionBody;
    try {
      body = this.parseFunctionBody();
    } finally {
      this.mutDraftVariables.delete(draftParam.name);
    }
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
    let expr = this.parseEquality();
    while (this.match(TokenType.AND)) {
      const right = this.parseEquality();
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

  private isPrimitiveLiteral(expr: Expression): boolean {
    if (
      expr.kind === "NumberLiteral" ||
      expr.kind === "StringLiteral" ||
      expr.kind === "BooleanLiteral"
    ) {
      return true;
    }
    if (expr.kind === "UnaryExpression" && this.isPrimitiveLiteral(expr.argument)) {
      return true;
    }
    if (expr.kind === "BinaryExpression") {
      return true;
    }
    return false;
  }

  private parseEquality(): Expression {
    let expr = this.parseComparison();
    while (this.match(TokenType.VALUE_EQ, TokenType.VALUE_NEQ, TokenType.REF_EQ, TokenType.REF_NEQ)) {
      const opTok = this.previous();
      const op = opTok.value as "#=" | "#!" | "@=" | "@!";
      const right = this.parseComparison();
      if (op === "@=" || op === "@!") {
        if (this.isPrimitiveLiteral(expr) || this.isPrimitiveLiteral(right)) {
          throw new ParseError(
            `Reference identity operator '${op}' cannot be used with primitive values; use '#=' or '#!' for value equality`,
            opTok.span
          );
        }
      }
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

  private parseComparison(): Expression {
    let expr = this.parseAdditive();
    while (this.match(TokenType.LT, TokenType.LTE, TokenType.GT, TokenType.GTE)) {
      const op = this.previous().value as "<" | "<=" | ">" | ">=";
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
        this.skipNewlines();
        while (this.match(TokenType.INDENT) || this.match(TokenType.DEDENT)) {}
        this.skipNewlines();
        const args: Expression[] = [];
        if (!this.check(TokenType.RPAREN)) {
          do {
            this.skipNewlines();
            while (this.match(TokenType.INDENT) || this.match(TokenType.DEDENT)) {}
            this.skipNewlines();
            if (this.check(TokenType.RPAREN)) break;
            if (this.match(TokenType.DOTDOTDOT)) {
              const dotSpan = this.previous().span;
              const arg = this.parseExpression();
              args.push({
                kind: "SpreadElement",
                argument: arg,
                span: { start: dotSpan.start, end: arg.span.end },
              });
            } else {
              args.push(this.parseExpression());
            }
            this.skipNewlines();
            while (this.match(TokenType.INDENT) || this.match(TokenType.DEDENT)) {}
            this.skipNewlines();
          } while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));
        }
        this.skipNewlines();
        while (this.match(TokenType.INDENT) || this.match(TokenType.DEDENT)) {}
        this.skipNewlines();
        const end = this.consume(TokenType.RPAREN, "Expected ')' after call arguments").span.end;
        expr = {
          kind: "CallExpression",
          callee: expr,
          args,
          span: { start: expr.span.start, end },
        };
      } else if (this.match(TokenType.DOT)) {
        const prop = this.parsePropertyIdentifier();
        expr = {
          kind: "MemberExpression",
          object: expr,
          property: prop as any,
          span: { start: expr.span.start, end: prop.span.end },
        };
      } else if (this.check(TokenType.LBRACKET) && this.peek().span.start.line === expr.span.end.line) {
        this.advance();
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
    if (this.parsingBraceEffect && this.isAtEnd()) {
      throw new ParseError("Expected '}' to close effect block", this.peek().span);
    }
    // 0. Generic function expression: <A>(value: A) => ...
    if (this.check(TokenType.LT) && this.isGenericCallableStart()) {
      return this.parseGenericFunctionExpression();
    }

    // 1. JSX Element: <tag ...> or <tag ... />
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
        value: parseFloat(tok.value.replaceAll("_", "")),
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
        // Zero-argument lambda: () => ...
        if (this.match(TokenType.ARROW)) {
          const body = this.parseFunctionBody(!this.options.allowLegacyReturns);
          return {
            kind: "FunctionExpression",
            params: [],
            body,
            span: { start, end: body.span.end },
          };
        }
        throw new ParseError("Empty parentheses '()' must be followed by '=>'", this.previous().span);
      }

      // Check if this looks like function params (param: Type, ...) => or (...rest) =>
      let firstIsRest = false;
      let firstDotSpan: Span | undefined;
      if (this.match(TokenType.DOTDOTDOT)) {
        firstIsRest = true;
        firstDotSpan = this.previous().span;
      }

      const firstExpr = firstIsRest ? this.parseIdentifier() : this.parseExpression();

      if (firstIsRest || this.check(TokenType.COLON) || this.check(TokenType.COMMA) || this.check(TokenType.QUESTION) || this.check(TokenType.EQ)) {
        const firstTarget = this.expressionToBindingTarget(firstExpr);
        if (!firstTarget) throw new ParseError("Expected a parameter name or pattern", firstExpr.span);
        const firstParam = this.parseValueParameter(firstTarget, true, firstIsRest);
        if (firstDotSpan) {
          firstParam.span = { start: firstDotSpan.start, end: firstParam.span.end };
        }
        const params: Parameter[] = [firstParam];
        while (this.match(TokenType.COMMA)) {
          if (this.check(TokenType.RPAREN)) break;
          let isRest = false;
          let dotSpan: Span | undefined;
          if (this.match(TokenType.DOTDOTDOT)) {
            isRest = true;
            dotSpan = this.previous().span;
          }
          let pTarget: BindingTarget;
          if (this.check(TokenType.LBRACE) || this.check(TokenType.LBRACKET)) {
            pTarget = this.parsePattern() as RecordPattern | ArrayPattern;
          } else {
            pTarget = this.parseIdentifier();
          }
          const p = this.parseValueParameter(pTarget, true, isRest);
          if (dotSpan) {
            p.span = { start: dotSpan.start, end: p.span.end };
          }
          params.push(p);
        }

        this.consume(TokenType.RPAREN, "Expected ')' after parameters");
        this.validateValueParameters(params);
        let returnType: TypeNode | undefined;
        let arrowConsumed = false;
        if (this.match(TokenType.COLON)) {
          returnType = this.parseTypeNode();
        } else if (
          this.check(TokenType.ARROW) &&
          this.peekAhead(1).type === TokenType.UPPER_IDENTIFIER &&
          (this.peekAhead(2).type === TokenType.ARROW ||
            this.peekAhead(2).type === TokenType.LBRACE ||
            this.peekAhead(2).type === TokenType.NEWLINE)
        ) {
          this.advance(); // consume the arrow before the return type
          arrowConsumed = true;
          returnType = this.parseTypeNode();
          this.match(TokenType.ARROW);
        }
        if (!arrowConsumed && !this.match(TokenType.ARROW)) {
          throw new ParseError("Expected '=>' after parameters", this.peek().span);
        }
        const body = this.parseFunctionBody(!this.options.allowLegacyReturns);
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
      let arrowConsumed = false;
      if (this.match(TokenType.COLON)) {
        singleReturnType = this.parseTypeNode();
      } else if (
        this.check(TokenType.ARROW) &&
        this.peekAhead(1).type === TokenType.UPPER_IDENTIFIER &&
        (this.peekAhead(2).type === TokenType.ARROW ||
          this.peekAhead(2).type === TokenType.LBRACE ||
          this.peekAhead(2).type === TokenType.NEWLINE)
      ) {
        this.advance(); // consume the arrow before the return type
        arrowConsumed = true;
        singleReturnType = this.parseTypeNode();
        this.match(TokenType.ARROW);
      }

      if (arrowConsumed || this.match(TokenType.ARROW)) {
        const body = this.parseFunctionBody(!this.options.allowLegacyReturns);
        const paramTarget = this.expressionToBindingTarget(firstExpr);
        if (!paramTarget) throw new ParseError("Expected parameter name or pattern", firstExpr.span);
        return {
          kind: "FunctionExpression",
          params: [{ kind: "Parameter", name: paramTarget, span: firstExpr.span }],
          returnType: singleReturnType,
          body,
          span: { start, end: body.span.end },
        };
      }

      return firstExpr;
    }

    // 6. Zero-argument function: => body
    if (this.match(TokenType.ARROW)) {
      const start = this.previous().span.start;
      const body = this.parseFunctionBody(!this.options.allowLegacyReturns);
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

    // 12. TS escape hatch: ts { raw TypeScript expression }
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
        const firstId: Identifier = this.parseRecordKeyIdentifier();
        if (this.match(TokenType.DOT)) {
          // Dot-path entry: address.city: "Paris"
          const path: Identifier[] = [firstId];
          do {
            path.push(this.parsePropertyIdentifier() as Identifier);
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
        if (this.match(TokenType.DOTDOTDOT)) {
          const dotSpan = this.previous().span;
          const element = this.parseExpression();
          elements.push({
            kind: "SpreadElement",
            argument: element,
            span: { start: dotSpan.start, end: element.span.end },
          });
        } else {
          elements.push(this.parseExpression());
        }
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

  private parseMatchExpression(isPipeline = false): MatchExpression {
    const start = this.previous().span.start;
    let scrutinee: Expression | undefined;

    // Check if scrutinee is present or if it's a subjectless boolean match
    if (!isPipeline && !this.check(TokenType.BAR) && !this.check(TokenType.NEWLINE) && !this.check(TokenType.INDENT)) {
      scrutinee = this.parseExpression();
    }

    this.skipNewlines();
    const hasIndent = this.match(TokenType.INDENT);
    const arms: MatchArm[] = [];

    const isSubjectless = !isPipeline && scrutinee === undefined;
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

      if (!this.match(TokenType.ARROW)) {
        throw new ParseError("Expected '=>' in match arm", this.peek().span);
      }
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
      isPipeline: isPipeline ? true : undefined,
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
        literal: { kind: "NumberLiteral", value: parseFloat(this.previous().value.replaceAll("_", "")), raw: this.previous().value, span: this.previous().span },
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
    if (this.match(TokenType.LBRACE)) {
      const start = this.previous().span.start;
      const fields: RecordPatternField[] = [];
      this.skipNewlines();
      const hasIndent = this.match(TokenType.INDENT);

      while (!this.check(TokenType.RBRACE) && !this.check(TokenType.DEDENT) && !this.isAtEnd()) {
        this.skipNewlines();
        if (this.check(TokenType.RBRACE) || this.check(TokenType.DEDENT)) break;

        const isRest = this.match(TokenType.DOTDOTDOT);
        const key = this.parseIdentifier();
        let pattern: Pattern | undefined;
        if (!isRest && this.match(TokenType.COLON)) {
          pattern = this.parsePattern();
        }
        fields.push({
          kind: "RecordPatternField",
          key,
          pattern,
          isRest: isRest || undefined,
          span: { start: isRest ? this.previous().span.start : key.span.start, end: pattern ? pattern.span.end : key.span.end },
        });

        this.match(TokenType.COMMA);
        this.skipNewlines();
      }

      if (hasIndent) {
        this.consume(TokenType.DEDENT, "Expected unindent in record pattern");
      }
      this.skipNewlines();
      const end = this.consume(TokenType.RBRACE, "Expected '}' after record pattern").span.end;
      return {
        kind: "RecordPattern",
        fields,
        span: { start, end },
      };
    }
    if (this.match(TokenType.LBRACKET)) {
      const start = this.previous().span.start;
      const elements: Pattern[] = [];
      this.skipNewlines();
      while (!this.check(TokenType.RBRACKET) && !this.isAtEnd()) {
        this.skipNewlines();
        if (this.check(TokenType.RBRACKET)) break;
        if (this.match(TokenType.COMMA)) {
          elements.push({ kind: "WildcardPattern", span: this.previous().span });
          continue;
        }
        if (this.match(TokenType.DOTDOTDOT)) {
          const restStart = this.previous().span.start;
          const arg = this.parsePattern();
          elements.push({
            kind: "RestPattern",
            argument: arg,
            span: { start: restStart, end: arg.span.end },
          });
        } else {
          elements.push(this.parsePattern());
        }
        this.match(TokenType.COMMA);
        this.skipNewlines();
      }
      const end = this.consume(TokenType.RBRACKET, "Expected ']' after array pattern").span.end;
      return {
        kind: "ArrayPattern",
        elements,
        span: { start, end },
      };
    }

    throw new ParseError(`Unexpected pattern token '${this.peek().value}'`, this.peek().span);
  }

  // --- Effect Blocks ---

  private parseEffectBlock(): EffectBlockExpression {
    const start = this.previous().span.start;
    const braced = this.match(TokenType.LBRACE);
    if (braced) this.parsingBraceEffect = true;
    if (!braced) {
      this.consume(TokenType.NEWLINE, "Expected newline or '{' after 'effect'");
      this.consume(TokenType.INDENT, "Expected indent after 'effect'");
    }

    const body: EffectStatement[] = [];
    let finalExpression: Expression | undefined;

    const atEnd = () => braced ? this.check(TokenType.RBRACE) : this.check(TokenType.DEDENT);
    while (!atEnd() && !this.isAtEnd()) {
      this.skipNewlines();
      if (braced) while (this.match(TokenType.INDENT) || this.match(TokenType.DEDENT)) {}
      if (atEnd()) break;

      if (this.match(TokenType.ARROW)) {
        finalExpression = this.parseExpression();
        this.skipNewlines();
        if (braced) while (this.match(TokenType.INDENT) || this.match(TokenType.DEDENT)) {}
        if (!atEnd()) throw new ParseError("Effect block return must be the final statement", finalExpression.span);
        break;
      } else if (this.check(TokenType.WHEN)) {
        body.push(this.parseWhenStatement());
      // Check for effect bind: x <- eff or _ <- eff
      } else if (this.check(TokenType.UNDERSCORE) && this.peekAhead(1).type === TokenType.LARROW) {
        this.advance(); // consume '_'
        this.advance(); // consume '<-'
        const eff = this.parseExpression();
        this.consumeNewlineOrEof("Expected newline after discard bind");
        body.push({
          kind: "EffectDiscardStatement",
          effect: eff,
          span: { start: eff.span.start, end: eff.span.end },
        });
      } else if (
        (this.check(TokenType.IDENTIFIER) && this.peekAhead(1).type === TokenType.LARROW) ||
        this.isDestructuringEffectBindStart()
      ) {
        const id = (this.check(TokenType.LBRACE) || this.check(TokenType.LBRACKET))
          ? (this.parsePattern() as RecordPattern | ArrayPattern)
          : this.parseIdentifier();
        this.consume(TokenType.LARROW, "Expected '<-' in effect bind");
        const eff = this.parseExpression();
        this.consumeNewlineOrEof("Expected newline after effect bind");
        body.push({
          kind: "EffectBindStatement",
          id,
          effect: eff,
          span: { start: id.span.start, end: eff.span.end },
        });
      } else if (this.check(TokenType.IDENTIFIER) && this.peekAhead(1).type === TokenType.EQ && this.mutableVariables.has(this.peek().value)) {
        const target = this.parseIdentifier();
        this.consume(TokenType.EQ, "Expected '=' in assignment");
        const val = this.parseExpression();
        this.consumeNewlineOrEof();
        body.push({
          kind: "AssignmentStatement",
          target,
          value: val,
          span: { start: target.span.start, end: val.span.end },
        });
        this.skipNewlines();
        continue;
      } else if (
        this.check(TokenType.MUT) ||
        (this.check(TokenType.IDENTIFIER) && (this.peekAhead(1).type === TokenType.EQ || this.peekAhead(1).type === TokenType.COLON)) ||
        (this.check(TokenType.UNDERSCORE) && this.peekAhead(1).type === TokenType.EQ) ||
        this.isDestructuringBindingStart()
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
        if (braced) while (this.match(TokenType.INDENT) || this.match(TokenType.DEDENT)) {}
        if (atEnd()) {
          if (this.options.allowLegacyReturns) {
            finalExpression = expr;
            (finalExpression as any).isLegacyBareEffectReturn = true;
            break;
          }
          throw new ParseError(EFFECT_RETURN_DIAGNOSTIC, expr.span);
        } else {
          throw new ParseError(
            EFFECT_BARE_EXPR_DIAGNOSTIC,
            expr.span,
          );
        }
      }
    }

    if (braced) {
      this.consume(TokenType.RBRACE, "Expected '}' to close effect block");
      this.parsingBraceEffect = false;
    } else {
      this.consume(TokenType.DEDENT, "Expected unindent after effect block");
    }

    if (!finalExpression) {
      if (this.options.allowLegacyReturns) {
        finalExpression = {
          kind: "Identifier",
          name: "_missingReturn",
          span: { start, end: this.previous().span.end },
        };
        (finalExpression as any).isMissingEffectReturn = true;
      } else {
        throw new ParseError(EFFECT_RETURN_DIAGNOSTIC, { start, end: this.previous().span.end });
      }
    }

    return {
      kind: "EffectBlockExpression",
      body,
      finalExpression,
      span: { start, end: finalExpression.span.end },
    };
  }

  private isBraceBlock(): boolean {
    if (!this.check(TokenType.LBRACE)) return false;
    let i = 1;
    while (this.current + i < this.tokens.length) {
      const t = this.tokens[this.current + i].type;
      if (t === TokenType.NEWLINE || t === TokenType.INDENT) {
        i++;
      } else {
        break;
      }
    }
    if (this.current + i >= this.tokens.length) return false;
    const firstTok = this.tokens[this.current + i];
    if (firstTok.type === TokenType.DOTDOTDOT) return false;
    if (firstTok.type === TokenType.RBRACE) return false;
    if (firstTok.type === TokenType.WHEN || firstTok.type === TokenType.MUT || firstTok.type === TokenType.ARROW) return true;
    if (firstTok.type === TokenType.IDENTIFIER && firstTok.value === "fn") return true;
    if (this.current + i + 1 < this.tokens.length && this.tokens[this.current + i + 1].type === TokenType.EQ) return true;

    while (this.current + i < this.tokens.length) {
      const tok = this.tokens[this.current + i];
      if (tok.type === TokenType.RBRACE || tok.type === TokenType.DEDENT) break;
      if (tok.type === TokenType.ARROW) return true;
      if (tok.type === TokenType.WHEN || tok.type === TokenType.MUT) return true;
      if (tok.type === TokenType.DOTDOTDOT) return false;
      if (tok.type === TokenType.COLON) {
        let j = i + 1;
        let hasEq = false;
        while (this.current + j < this.tokens.length) {
          const t = this.tokens[this.current + j];
          if (t.type === TokenType.NEWLINE || t.type === TokenType.COMMA || t.type === TokenType.RBRACE || t.type === TokenType.DEDENT) break;
          if (t.type === TokenType.EQ) {
            hasEq = true;
            break;
          }
          j++;
        }
        if (!hasEq) return false;
      }
      if (tok.type === TokenType.NEWLINE) break;
      i++;
    }
    return true;
  }

  private isAssignmentStart(): boolean {
    if (!this.check(TokenType.IDENTIFIER)) return false;
    let i = 1;
    let member = false;
    while (true) {
      const type = this.peekAhead(i).type;
      if (type === TokenType.DOT) { member = true; i += 2; continue; }
      if (type === TokenType.LBRACKET) {
        member = true;
        i++;
        let depth = 1;
        while (depth > 0 && this.peekAhead(i).type !== TokenType.EOF) {
          if (this.peekAhead(i).type === TokenType.LBRACKET) depth++;
          if (this.peekAhead(i).type === TokenType.RBRACKET) depth--;
          i++;
        }
        continue;
      }
      break;
    }
    return this.peekAhead(i).type === TokenType.EQ &&
      (this.mutableVariables.has(this.peek().value) || (member && this.mutDraftVariables.has(this.peek().value)));
  }

  private parseAssignmentTarget(): Identifier | DotPathExpression | IndexExpression {
    const expr = this.parsePostfix();
    if (expr.kind === "Identifier") return expr;
    if (expr.kind === "IndexExpression") return expr;
    if (expr.kind === "MemberExpression") {
      const path: Identifier[] = [];
      let current: Expression = expr;
      while (current.kind === "MemberExpression") {
        path.unshift(current.property as Identifier);
        current = current.object;
      }
      if (current.kind === "Identifier") path.unshift(current);
      return { kind: "DotPathExpression", path, span: expr.span };
    }
    throw new ParseError("Invalid assignment target", expr.span);
  }

  private collectPatternVariables(pat: Pattern | BindingTarget): string[] {
    if (pat.kind === "Identifier" || pat.kind === "UpperIdentifier") {
      return [pat.name];
    }
    if (pat.kind === "VariablePattern") {
      return [pat.name.name];
    }
    if (pat.kind === "RecordPattern") {
      const vars: string[] = [];
      for (const f of pat.fields) {
        if (!f.pattern) {
          vars.push(f.key.name);
        } else {
          vars.push(...this.collectPatternVariables(f.pattern));
        }
      }
      return vars;
    }
    if (pat.kind === "ArrayPattern") {
      const vars: string[] = [];
      for (const el of pat.elements) {
        vars.push(...this.collectPatternVariables(el));
      }
      return vars;
    }
    if (pat.kind === "RestPattern") {
      return this.collectPatternVariables(pat.argument);
    }
    return [];
  }

  private isDestructuringBindingStart(): boolean {
    if (!this.check(TokenType.LBRACE) && !this.check(TokenType.LBRACKET)) return false;
    const stack: TokenType[] = [];
    for (let i = 0; i < 512; i++) {
      const tok = this.peekAhead(i);
      if (tok.type === TokenType.EOF) return false;
      if (tok.type === TokenType.LBRACE) {
        stack.push(TokenType.RBRACE);
      } else if (tok.type === TokenType.LBRACKET) {
        stack.push(TokenType.RBRACKET);
      } else if (tok.type === TokenType.RBRACE || tok.type === TokenType.RBRACKET) {
        if (stack.length === 0 || stack[stack.length - 1] !== tok.type) {
          return false;
        }
        stack.pop();
        if (stack.length === 0) {
          let nextIdx = i + 1;
          while (this.peekAhead(nextIdx).type === TokenType.NEWLINE) {
            nextIdx++;
          }
          const next = this.peekAhead(nextIdx).type;
          return next === TokenType.EQ || next === TokenType.COLON;
        }
      }
    }
    return false;
  }

  private isDestructuringEffectBindStart(): boolean {
    if (!this.check(TokenType.LBRACE) && !this.check(TokenType.LBRACKET)) return false;
    const stack: TokenType[] = [];
    for (let i = 0; i < 512; i++) {
      const tok = this.peekAhead(i);
      if (tok.type === TokenType.EOF) return false;
      if (tok.type === TokenType.LBRACE) {
        stack.push(TokenType.RBRACE);
      } else if (tok.type === TokenType.LBRACKET) {
        stack.push(TokenType.RBRACKET);
      } else if (tok.type === TokenType.RBRACE || tok.type === TokenType.RBRACKET) {
        if (stack.length === 0 || stack[stack.length - 1] !== tok.type) {
          return false;
        }
        stack.pop();
        if (stack.length === 0) {
          let nextIdx = i + 1;
          while (this.peekAhead(nextIdx).type === TokenType.NEWLINE) {
            nextIdx++;
          }
          return this.peekAhead(nextIdx).type === TokenType.LARROW;
        }
      }
    }
    return false;
  }

  private parseFunctionBody(requireExplicitReturn = false): FunctionBody {
    this.functionDepth++;
    try {
      if (this.isBraceBlock()) {
        this.consume(TokenType.LBRACE, "Expected '{'");
        return this.parseBraceBlock(requireExplicitReturn);
      }
      if (this.match(TokenType.NEWLINE)) {
        // A multiline `match` or `effect` is still one expression-bodied
        // lambda. Its enclosing arrow supplies the return, rather than making
        // the match/effect's final expression an implicit function return.
        if (this.check(TokenType.MATCH) || this.check(TokenType.EFFECT)) {
          return this.parseExpression();
        }
        this.consume(TokenType.INDENT, "Expected indent for function body block");
        return this.parseIndentedBlock(requireExplicitReturn);
      }
      return this.parseExpression();
    } finally {
      this.functionDepth--;
    }
  }

  private parseBraceBlock(requireExplicitReturn = false): BlockStatement {
    const start = this.previous().span.start;
    const statements: Statement[] = [];
    let finalExpression: Expression | undefined;

    this.skipNewlines();
    const hasIndent = this.match(TokenType.INDENT);

    while (!this.check(TokenType.RBRACE) && !this.check(TokenType.DEDENT) && !this.isAtEnd()) {
      this.skipNewlines();
      if (this.check(TokenType.RBRACE) || this.check(TokenType.DEDENT)) break;

      try {
        if (this.check(TokenType.WHEN)) {
          statements.push(this.parseWhenStatement());
          this.skipNewlines();
          continue;
        }

        if (this.match(TokenType.ARROW)) {
          const retStart = this.previous().span.start;
          const retExpr = this.parseExpression();
          this.consumeNewlineOrEof();
          statements.push({
            kind: "ReturnStatement",
            argument: retExpr,
            span: { start: retStart, end: retExpr.span.end },
          });
          this.skipNewlines();
          continue;
        }

        if (this.check(TokenType.IDENTIFIER) && this.peek().value === "fn") {
          statements.push(this.parseFunctionDeclaration(false));
          this.skipNewlines();
          continue;
        }

        if (this.isAssignmentStart()) {
          const target = this.parseAssignmentTarget();
          this.consume(TokenType.EQ, "Expected '=' in assignment");
          const val = this.parseExpression();
          this.consumeNewlineOrEof();
          statements.push({
            kind: "AssignmentStatement",
            target,
            value: val,
            span: { start: target.span.start, end: val.span.end },
          });
          this.skipNewlines();
          continue;
        }

        if (
          this.check(TokenType.MUT) ||
          (this.check(TokenType.IDENTIFIER) && (this.peekAhead(1).type === TokenType.EQ || this.peekAhead(1).type === TokenType.COLON)) ||
          (this.check(TokenType.UNDERSCORE) && this.peekAhead(1).type === TokenType.EQ) ||
          this.isDestructuringBindingStart()
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
            statements.push(bind);
          }
          this.skipNewlines();
          continue;
        }

        const expr = this.parseExpression();
        this.skipNewlines();

        if (this.check(TokenType.RBRACE) || this.check(TokenType.DEDENT)) {
          const isAllowedImplicitReturn = statements.length === 0;
          if (
            requireExplicitReturn &&
            !isAllowedImplicitReturn &&
            expr.kind !== "MatchExpression" &&
            expr.kind !== "EffectBlockExpression"
          ) {
            throw new ParseError(FUNCTION_RETURN_DIAGNOSTIC, expr.span);
          }
          finalExpression = expr;
          break;
        } else {
          statements.push({
            kind: "ExpressionStatement",
            expression: expr,
            span: expr.span,
          });
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

    if (requireExplicitReturn && !finalExpression && statements.at(-1)?.kind !== "ReturnStatement") {
      throw new ParseError(FUNCTION_RETURN_DIAGNOSTIC, { start, end: this.previous().span.end });
    }
    if (hasIndent) {
      this.consume(TokenType.DEDENT, "Expected unindent after brace block");
    }
    this.skipNewlines();
    const end = this.consume(TokenType.RBRACE, "Expected '}' after block").span.end;
    return {
      kind: "BlockStatement",
      statements,
      finalExpression,
      span: { start, end },
    };
  }

  private parseIndentedBlock(requireExplicitReturn = false): BlockStatement {
    const start = this.previous().span.start;
    const statements: Statement[] = [];
    let finalExpression: Expression | undefined;

    while (!this.check(TokenType.DEDENT) && !this.isAtEnd()) {
      this.skipNewlines();
      if (this.check(TokenType.DEDENT)) break;

      try {
        if (this.check(TokenType.WHEN)) {
          statements.push(this.parseWhenStatement());
          this.skipNewlines();
          continue;
        }


        if (this.match(TokenType.ARROW)) {
          const retStart = this.previous().span.start;
          const retExpr = this.parseExpression();
          this.consumeNewlineOrEof();
          statements.push({
            kind: "ReturnStatement",
            argument: retExpr,
            span: { start: retStart, end: retExpr.span.end },
          });
          this.skipNewlines();
          continue;
        }
        if (this.check(TokenType.IDENTIFIER) && this.peek().value === "fn") {
          statements.push(this.parseFunctionDeclaration(false));
          this.skipNewlines();
          continue;
        }

        if (this.isAssignmentStart()) {
          const target = this.parseAssignmentTarget();
          this.consume(TokenType.EQ, "Expected '=' in assignment");
          const val = this.parseExpression();
          this.consumeNewlineOrEof();
          statements.push({
            kind: "AssignmentStatement",
            target,
            value: val,
            span: { start: target.span.start, end: val.span.end },
          });
          this.skipNewlines();
          continue;
        }

        if (
          this.check(TokenType.MUT) ||
          (this.check(TokenType.IDENTIFIER) && (this.peekAhead(1).type === TokenType.EQ || this.peekAhead(1).type === TokenType.COLON)) ||
          (this.check(TokenType.UNDERSCORE) && this.peekAhead(1).type === TokenType.EQ) ||
          this.isDestructuringBindingStart()
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
              if (requireExplicitReturn) throw new ParseError(FUNCTION_RETURN_DIAGNOSTIC, bind.span);
              (bind as any).isTrailingBinding = true;
              statements.push(bind);
              if (bind.id.kind === "Identifier" || bind.id.kind === "UpperIdentifier") {
                finalExpression = bind.id;
              }
              break;
            } else {
              statements.push(bind);
            }
          }
        } else {
          const expr = this.parseExpression();
          this.skipNewlines();

          if (this.check(TokenType.DEDENT)) {
            const isAllowedImplicitReturn = statements.length === 0;
            if (
              requireExplicitReturn &&
              !isAllowedImplicitReturn &&
              expr.kind !== "MatchExpression" &&
              expr.kind !== "EffectBlockExpression"
            ) {
              throw new ParseError(FUNCTION_RETURN_DIAGNOSTIC, expr.span);
            }
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

    if (requireExplicitReturn && !finalExpression && statements.at(-1)?.kind !== "ReturnStatement") {
      throw new ParseError(FUNCTION_RETURN_DIAGNOSTIC, { start, end: this.previous().span.end });
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
      finalExpression: finalExpression ?? (statements.length === 0 ? fallbackExpr : undefined),
      span: {
        start: statements[0]?.span.start || (finalExpression ? finalExpression.span.start : this.previous().span.start),
        end: (finalExpression ?? fallbackExpr).span.end,
      },
    };
  }

  // --- Types ---

  private parseTypeNode(): TypeNode {
    return this.parseUnionType();
  }

  private parseUnionType(): TypeNode {
    const first = this.parseIntersectionType();
    if (!this.check(TokenType.BAR)) return first;

    const types: TypeNode[] = [first];
    while (this.match(TokenType.BAR)) {
      types.push(this.parseIntersectionType());
    }
    return {
      kind: "UnionTypeNode",
      types,
      span: { start: first.span.start, end: types[types.length - 1].span.end },
    };
  }

  private parseIntersectionType(): TypeNode {
    const first = this.parseFunctionTypeNode();
    if (!this.check(TokenType.AMP)) return first;

    const types: TypeNode[] = [first];
    while (this.match(TokenType.AMP)) {
      types.push(this.parseFunctionTypeNode());
    }
    return {
      kind: "IntersectionTypeNode",
      types,
      span: { start: first.span.start, end: types[types.length - 1].span.end },
    };
  }

  private parseFunctionTypeNode(): FunctionTypeNode {
    const start = this.peek().span.start;
    let typeParams: TypeParameter[] | undefined;
    if (this.check(TokenType.LT) && this.isGenericCallableStart()) {
      typeParams = this.parseTypeParameters();
    }
    if (this.check(TokenType.LPAREN)) {
      const isFunctionType =
        typeParams !== undefined ||
        (this.peekAhead(1).type === TokenType.RPAREN && this.peekAhead(2).type === TokenType.ARROW) ||
        this.peekAhead(1).type === TokenType.DOTDOTDOT ||
        (this.peekAhead(1).type === TokenType.IDENTIFIER &&
          (this.peekAhead(2).type === TokenType.COLON ||
            (this.peekAhead(2).type === TokenType.QUESTION && this.peekAhead(3).type === TokenType.COLON)));

      if (isFunctionType) {
        this.advance(); // consume '('
        const params: Parameter[] = [];
        if (!this.check(TokenType.RPAREN)) {
          do {
            let isRest = false;
            let dotSpan: Span | undefined;
            if (this.match(TokenType.DOTDOTDOT)) {
              isRest = true;
              dotSpan = this.previous().span;
            }
            let pTarget: BindingTarget;
            if (this.check(TokenType.LBRACE) || this.check(TokenType.LBRACKET)) {
              pTarget = this.parsePattern() as RecordPattern | ArrayPattern;
            } else {
              pTarget = this.parseIdentifier();
            }
            const optional = this.match(TokenType.QUESTION);
            this.consume(TokenType.COLON, "Expected ':' after param name");
            const pType = this.parseTypeNode();
            params.push({
              kind: "Parameter",
              name: pTarget,
              typeAnnotation: pType,
              optional: optional ? true : undefined,
              isRest: isRest ? true : undefined,
              span: { start: dotSpan ? dotSpan.start : pTarget.span.start, end: pType.span.end },
            });
          } while (this.match(TokenType.COMMA) && !this.check(TokenType.RPAREN));
        }
        this.consume(TokenType.RPAREN, "Expected ')'");
        this.validateValueParameters(params);
        if (!this.match(TokenType.ARROW)) {
          throw new ParseError("Expected '=>' in function type", this.peek().span);
        }
        const ret = this.parseTypeNode();
        return {
          kind: "FunctionTypeNode",
          typeParams,
          params,
          returnType: ret,
          span: { start, end: ret.span.end },
        };
      } else {
        const pStart = this.advance().span.start; // consume '('
        const inner = this.parseTypeNode();
        const pEnd = this.consume(TokenType.RPAREN, "Expected ')'").span.end;
        let resultType: TypeNode = {
          kind: "ParenthesizedTypeNode",
          typeNode: inner,
          span: { start: pStart, end: pEnd },
        };
        while (this.match(TokenType.LBRACKET)) {
          const indexType = this.parseTypeNode();
          const bracketEnd = this.consume(TokenType.RBRACKET, "Expected ']' after index type").span.end;
          resultType = {
            kind: "IndexedAccessTypeNode",
            objectType: resultType,
            indexType,
            span: { start: resultType.span.start, end: bracketEnd },
          };
        }
        return resultType as any;
      }
    }

    if (typeParams) {
      throw new ParseError("Expected '(' after generic type parameters", this.peek().span);
    }
    return this.parsePrimaryType() as any;
  }

  private parsePrimaryType(): TypeNode {
    if (this.match(TokenType.STRING, TokenType.NUMBER, TokenType.TRUE, TokenType.FALSE)) {
      const token = this.previous();
      const value = token.type === TokenType.STRING ? token.value : token.type === TokenType.NUMBER ? Number(token.value) : token.type === TokenType.TRUE;
      return { kind: "LiteralTypeNode", value, span: token.span };
    }
    if (this.match(TokenType.LBRACE)) {
      const start = this.previous().span.start;
      const fields: RecordTypeField[] = [];
      this.recordTypeDepth++;
      try {
        this.skipNewlines();
        const hasIndent = this.match(TokenType.INDENT);
        while (!this.check(TokenType.RBRACE) && !this.check(TokenType.DEDENT) && !this.isAtEnd()) {
          this.skipNewlines();
          if (this.check(TokenType.RBRACE) || this.check(TokenType.DEDENT)) break;
          const fName: Identifier = this.parseRecordKeyIdentifier();
          const optional = this.match(TokenType.QUESTION);
          this.consume(TokenType.COLON, "Expected ':' after field name");
          const fType = this.parseTypeNode();
          const defaultValue = this.match(TokenType.EQ) ? this.parseExpression() : undefined;
          if (defaultValue && (!this.allowOptionalRecordFields || this.recordTypeDepth !== 1)) {
            throw new ParseError("Defaulted record fields are supported only on direct function parameters", fName.span);
          }
          if (optional && defaultValue) throw new ParseError("A record field cannot be both optional and defaulted", fName.span);
          fields.push({ kind: "RecordTypeField", name: fName, typeAnnotation: fType, optional, defaultValue, span: { start: fName.span.start, end: (defaultValue ?? fType).span.end } });
          this.match(TokenType.COMMA);
          this.skipNewlines();
        }
        if (hasIndent) this.consume(TokenType.DEDENT, "Expected unindent in record type");
        this.skipNewlines();
        const end = this.consume(TokenType.RBRACE, "Expected '}'").span.end;
        return { kind: "RecordTypeNode", fields, span: { start, end } };
      } finally {
        this.recordTypeDepth--;
      }
    }

    // TS escape hatch for types: ts { Record<string, unknown> }
    if (this.match(TokenType.TS)) {
      const start = this.previous().span.start;
      const code = this.consumeTsCode();
      return {
        kind: "TsEscapeTypeNode",
        code: code.value,
        span: { start, end: code.span.end },
      };
    }

    if (this.check(TokenType.UPPER_IDENTIFIER) && this.peek().value === "Effect" && this.peekAhead(1).type === TokenType.LT) {
      return this.parseEffectTypeNode();
    }

    if (this.check(TokenType.IDENTIFIER) && this.peek().value === "typeof") {
      const start = this.advance().span.start;
      let expr: Expression = this.parsePrimary();
      while (this.match(TokenType.DOT)) {
        const prop = this.parsePropertyIdentifier();
        expr = {
          kind: "MemberExpression",
          object: expr,
          property: prop as any,
          span: { start: expr.span.start, end: prop.span.end },
        };
      }
      let resultType: TypeNode = {
        kind: "TypeQueryNode",
        expr,
        span: { start, end: expr.span.end },
      };
      while (this.match(TokenType.LBRACKET)) {
        const indexType = this.parseTypeNode();
        const bracketEnd = this.consume(TokenType.RBRACKET, "Expected ']' after index type").span.end;
        resultType = {
          kind: "IndexedAccessTypeNode",
          objectType: resultType,
          indexType,
          span: { start: resultType.span.start, end: bracketEnd },
        };
      }
      return resultType;
    }

    if (!this.check(TokenType.UPPER_IDENTIFIER)) {
      throw new ParseError("Type names must begin with an uppercase letter (for example String or Number); use ts for TypeScript types", this.peek().span);
    }
    const typeId = this.parseUpperIdentifier();
    const parts: (Identifier | UpperIdentifier)[] = [typeId];
    while (this.match(TokenType.DOT)) parts.push(this.parsePropertyIdentifier());
    let typeArgs: TypeNode[] | undefined;

    if (this.match(TokenType.LT)) {
      typeArgs = [];
      do {
        typeArgs.push(this.parseTypeNode());
      } while (this.match(TokenType.COMMA) && !this.check(TokenType.GT));
      this.consume(TokenType.GT, "Expected '>' after type arguments");
    }

    let resultType: TypeNode = parts.length > 1
      ? { kind: "QualifiedTypeReferenceNode", parts, typeArgs, span: { start: typeId.span.start, end: this.previous().span.end } }
      : { kind: "TypeReferenceNode", name: typeId as any, typeArgs, span: { start: typeId.span.start, end: this.previous().span.end } };

    while (this.match(TokenType.LBRACKET)) {
      const indexType = this.parseTypeNode();
      const bracketEnd = this.consume(TokenType.RBRACKET, "Expected ']' after index type").span.end;
      resultType = {
        kind: "IndexedAccessTypeNode",
        objectType: resultType,
        indexType,
        span: { start: resultType.span.start, end: bracketEnd },
      };
    }
    return resultType;
  }

  private parseEffectTypeNode(): EffectTypeNode {
    const start = this.advance().span.start; // consume 'Effect'
    this.consume(TokenType.LT, "Expected '<' after Effect");
    const success = this.parseTypeNode();
    let error: TypeNode | undefined;
    let requirements: TypeNode | undefined;

    if (this.match(TokenType.COMMA)) {
      error = this.parseTypeNode();
      if (this.match(TokenType.COMMA)) {
        requirements = this.parseTypeNode();
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

  private parseGenericFunctionExpression(): FunctionExpression {
    const start = this.peek().span.start;
    const typeParams = this.parseTypeParameters();
    const expression = this.parsePrimary();
    if (expression.kind !== "FunctionExpression") {
      throw new ParseError("Expected a function after generic type parameters", expression.span);
    }
    if (expression.typeParams?.length) {
      throw new ParseError("Generic type parameters may be declared only once", typeParams[0].span);
    }
    expression.typeParams = typeParams;
    expression.span = { start, end: expression.span.end };
    return expression;
  }

  private isGenericCallableStart(): boolean {
    if (!this.check(TokenType.LT)) return false;

    let angleDepth = 1;
    for (let i = 1; i < 512; i++) {
      const token = this.peekAhead(i);
      if (token.type === TokenType.EOF || token.type === TokenType.NEWLINE) return false;
      if (token.type === TokenType.LT) {
        angleDepth++;
      } else if (token.type === TokenType.GT) {
        angleDepth--;
        if (angleDepth === 0) {
          if (this.peekAhead(i + 1).type !== TokenType.LPAREN) return false;
          let parenDepth = 1;
          for (let j = i + 2; j < 1024; j++) {
            const param = this.peekAhead(j);
            if (param.type === TokenType.EOF || param.type === TokenType.NEWLINE) return false;
            if (param.type === TokenType.LPAREN) {
              parenDepth++;
            } else if (param.type === TokenType.RPAREN) {
              parenDepth--;
              if (parenDepth === 0) return this.peekAhead(j + 1).type === TokenType.ARROW || this.peekAhead(j + 1).type === TokenType.COLON;
            }
          }
          return false;
        }
      }
    }
    return false;
  }

  private parseTypeParameters(): TypeParameter[] {
    this.consume(TokenType.LT, "Expected '<'");
    const params: TypeParameter[] = [];
    do {
      const id = this.parseUpperIdentifier();
      let constraint: TypeNode | undefined;
      if (this.check(TokenType.IDENTIFIER) && this.peek().value === "extends") {
        this.advance();
        constraint = this.parseTypeNode();
      }
      params.push({
        kind: "TypeParameter",
        name: id,
        constraint,
        span: { start: id.span.start, end: constraint?.span.end ?? id.span.end },
      });
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
      const prop = this.parsePropertyIdentifier();
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
    if (this.match(TokenType.LBRACE)) {
      const start = this.previous().span.start;
      this.consume(TokenType.DOTDOTDOT, "Expected '...' in JSX spread attribute");
      const argument = this.parseExpression();
      const end = this.consume(TokenType.RBRACE, "Expected '}' after JSX spread").span.end;
      return { kind: "JSXSpreadAttribute", argument, span: { start, end } };
    }
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
    if (this.check(TokenType.ERROR)) {
      const token = this.advance();
      return { kind: "Identifier", name: token.value, span: token.span };
    }
    if (this.check(TokenType.UPPER_IDENTIFIER)) return this.parseUpperIdentifier();
    return this.parseIdentifier();
  }

  private parsePropertyIdentifier(): Identifier | UpperIdentifier {
    if (this.check(TokenType.ERROR)) {
      const token = this.advance();
      return { kind: "Identifier", name: token.value, span: token.span };
    }
    if (this.check(TokenType.UPPER_IDENTIFIER)) {
      return this.parseUpperIdentifier();
    }
    if (this.check(TokenType.IDENTIFIER)) {
      return this.parseIdentifier();
    }
    const peek = this.peek();
    if (Object.values(KEYWORDS).includes(peek.type)) {
      const tok = this.advance();
      return { kind: "Identifier", name: tok.value, span: tok.span };
    }
    return this.parseIdentifier();
  }

  private parseRecordKeyIdentifier(): Identifier {
    if (this.match(TokenType.STRING)) {
      const tok = this.previous();
      return { kind: "Identifier", name: tok.value, span: tok.span };
    }
    const prop = this.parsePropertyIdentifier();
    return { kind: "Identifier", name: prop.name, span: prop.span };
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

  private consumeNewlineOrEof(message = "Expected newline"): void {
    if (
      this.isAtEnd() ||
      this.check(TokenType.DEDENT) ||
      this.check(TokenType.RBRACE) ||
      this.previous().type === TokenType.DEDENT ||
      this.previous().type === TokenType.RBRACE ||
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
