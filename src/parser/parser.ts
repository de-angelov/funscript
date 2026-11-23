import {
  type Program,
  type TopLevelDeclaration,
  type ImportDeclaration,
  type ImportSpecifier,
  ExportDeclaration,
  type ExportDefaultDeclaration,
  type ExportFromDeclaration,
  type BindingDeclaration,
  type BindingTarget,
  type SchemaDeclaration,
  type SchemaBody,
  type RecordSchema,
  type RecordFieldSchema,
  type TaggedUnionSchema,
  type StructuralUnionSchema,
  type ImportedTsSchema,
  type VariantDeclaration,
  type VariantField,
  type TsDerivedSchema,
  type ErrorDeclaration,
  type ErrorField,
  type ServiceDeclaration,
  type ServiceMember,
  type Expression,
  Literal,
  NumberLiteral,
  type StringLiteral,
  type TemplateLiteral,
  TaggedTemplateExpression,
  type StringPart,
  BooleanLiteral,
  type Identifier,
  type UpperIdentifier,
  Placeholder,
  TypedHole,
  PipelineExpression,
  BinaryExpression,
  UnaryExpression,
  CallExpression,
  MemberExpression,
  type IndexExpression,
  type DotPathExpression,
  type RecordExpression,
  type RecordEntry,
  SpreadEntry,
  SpreadElement,
  FieldEntry,
  DotPathEntry,
  ShorthandEntry,
  type ArrayExpression,
  type FunctionExpression,
  type FunctionBody,
  type BlockStatement,
  type Statement,
  AssignmentStatement,
  ExpressionStatement,
  ReturnStatement,
  type WhenStatement,
  type MutBlockExpression,
  type MatchExpression,
  type MatchArm,
  type Pattern,
  ConstructorPattern,
  type RecordPattern,
  type RecordPatternField,
  type ArrayPattern,
  RestPattern,
  OrPattern,
  type EffectBlockExpression,
  type ParBlockExpression,
  type EffectStatement,
  type EffectBindStatement,
  EffectDiscardStatement,
  EffectControlFlowStatement,
  type TypeNode,
  TypeReferenceNode,
  type TypeParameter,
  type Parameter,
  type FunctionTypeNode,
  type EffectTypeNode,
  RecordTypeNode,
  type RecordTypeField,
  ArrayTypeNode,
  UnionTypeNode,
  IntersectionTypeNode,
  TsEscapeDeclaration,
  JsExpression,
  TsEscapeExpression,
  TsEscapeTypeNode,
  type Span,
  type Position,
  type JSXElement,
  type JSXSelfClosingElement,
  type JSXOpeningElement,
  type JSXClosingElement,
  type JSXAttribute,
  type JSXAttributeValue,
  type JSXExpressionContainer,
  JSXText,
  type JSXChild,
  type JSXTagName,
} from "../ast/types.js";
import { type Token, TokenType, KEYWORDS } from "../lexer/tokens.js";
import { FunScriptError } from "../errors.js";
import { ScopeStack } from "./scope.js";
import {
  parseJsxElement,
  parseJsxTagName,
  parseJsxAttribute,
  parseJsxExpressionContainer,
  formatTagName,
  areTagNamesEqual,
} from "./jsx.js";
import {
  parseTypeNode,
  parseUnionType,
  parseIntersectionType,
  parseFunctionTypeNode,
  parsePrimaryType,
  parseEffectTypeNode,
  parseGenericFunctionExpression,
  isGenericCallableStart,
  parseTypeParameters,
} from "./types.js";
import {
  parsePattern as parsePatternImpl,
  parsePrimaryPattern as parsePrimaryPatternImpl,
  parseBindingPattern as parseBindingPatternImpl,
  collectPatternVariables as collectPatternVariablesImpl,
  isDestructuringBindingStart as isDestructuringBindingStartImpl,
  isDestructuringEffectBindStart as isDestructuringEffectBindStartImpl,
} from "./patterns.js";
import {
  parseTopLevelDeclaration as parseTopLevelDeclarationImpl,
  isExportFrom as isExportFromImpl,
  parseExportFrom as parseExportFromImpl,
  parseExportDefaultDeclaration as parseExportDefaultDeclarationImpl,
  parseDeclaration as parseDeclarationImpl,
  parseImportDeclaration as parseImportDeclarationImpl,
  parseImportSource as parseImportSourceImpl,
  parseSchemaDeclaration as parseSchemaDeclarationImpl,
  parseTsDerivedSchema as parseTsDerivedSchemaImpl,
  parseSchemaBody as parseSchemaBodyImpl,
  parseImportedTsSchema as parseImportedTsSchemaImpl,
  parseRecordSchema as parseRecordSchemaImpl,
  parseStructuralUnionSchema as parseStructuralUnionSchemaImpl,
  parseTaggedUnionSchema as parseTaggedUnionSchemaImpl,
  parseErrorDeclaration as parseErrorDeclarationImpl,
  parseServiceDeclaration as parseServiceDeclarationImpl,
  parseBindingDeclaration as parseBindingDeclarationImpl,
} from "./declarations.js";

import {
  ParseError,
  FUNCTION_RETURN_DIAGNOSTIC,
  EFFECT_RETURN_DIAGNOSTIC,
  EFFECT_BARE_EXPR_DIAGNOSTIC,
} from "./errors.js";
export {
  ParseError,
  FUNCTION_RETURN_DIAGNOSTIC,
  EFFECT_RETURN_DIAGNOSTIC,
  EFFECT_BARE_EXPR_DIAGNOSTIC,
};

export interface ParserOptions {
  throwOnError?: boolean;
  isFunx?: boolean;
}

export class Parser {
  private current = 0;
  public diagnostics: ParseError[] = [];
  private functionDepth = 0;
  private scopeStack = new ScopeStack();

  private enterScope(): void {
    this.scopeStack.enterScope();
  }

  private exitScope(): void {
    this.scopeStack.exitScope();
  }

  public addMutableVariable(name: string): void {
    this.scopeStack.addMutableVariable(name);
  }

  private addMutDraftVariable(name: string): void {
    this.scopeStack.addMutDraftVariable(name);
  }

  private isMutableVariable(name: string): boolean {
    return this.scopeStack.isMutableVariable(name);
  }

  private isMutDraftVariable(name: string): boolean {
    return this.scopeStack.isMutDraftVariable(name);
  }

  public parseBindingPattern(): RecordPattern | ArrayPattern {
    return parseBindingPatternImpl(this);
  }

  private parsingBraceEffect = false;
  public hasDefaultExport = false;
  public allowOptionalRecordFields = false;
  public recordTypeDepth = 0;
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
    if (opts.isFunx !== undefined) {
      this.isFunx = opts.isFunx;
    }
    this.hasDefaultExport = false;
    this.scopeStack.reset();

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

  public parseTopLevelDeclaration(): TopLevelDeclaration {
    return parseTopLevelDeclarationImpl(this);
  }

  public isExportFrom(): boolean {
    return isExportFromImpl(this);
  }

  public parseExportFrom(start: Position): ExportFromDeclaration {
    return parseExportFromImpl(this, start);
  }

  public parseExportDefaultDeclaration(
    start: Position,
  ): ExportDefaultDeclaration {
    return parseExportDefaultDeclarationImpl(this, start);
  }

  public parseDeclaration(isJs = false, isTs = false): TopLevelDeclaration {
    return parseDeclarationImpl(this, isJs, isTs);
  }

  /** Consumes the raw TypeScript payload the lexer captured after 'ts'. */
  public consumeTsCode(): Token {
    return this.consume(TokenType.TS_CODE, "Expected '{ ... }' after 'ts'");
  }

  public parseImportDeclaration(): ImportDeclaration {
    return parseImportDeclarationImpl(this);
  }

  public parseImportSource(): StringLiteral {
    return parseImportSourceImpl(this);
  }

  public parseSchemaDeclaration(
    isTs = false,
    tsStart?: Position,
  ): SchemaDeclaration {
    return parseSchemaDeclarationImpl(this, isTs, tsStart);
  }

  public parseTsDerivedSchema(): TsDerivedSchema {
    return parseTsDerivedSchemaImpl(this);
  }

  public parseSchemaBody(): SchemaBody {
    return parseSchemaBodyImpl(this);
  }

  public parseImportedTsSchema(): ImportedTsSchema {
    return parseImportedTsSchemaImpl(this);
  }

  public parseRecordSchema(): RecordSchema {
    return parseRecordSchemaImpl(this);
  }

  public parseStructuralUnionSchema(): StructuralUnionSchema {
    return parseStructuralUnionSchemaImpl(this);
  }

  public parseTaggedUnionSchema(): TaggedUnionSchema {
    return parseTaggedUnionSchemaImpl(this);
  }

  public parseErrorDeclaration(): ErrorDeclaration {
    return parseErrorDeclarationImpl(this);
  }

  public parseServiceDeclaration(): ServiceDeclaration {
    return parseServiceDeclarationImpl(this);
  }

  public parseBindingDeclaration(isJs = false): BindingDeclaration {
    return parseBindingDeclarationImpl(this, isJs);
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
          const subPattern: Pattern =
            subTarget.kind === "Identifier" ||
            subTarget.kind === "UpperIdentifier"
              ? {
                  kind: "VariablePattern",
                  name: subTarget,
                  span: subTarget.span,
                }
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
            argument:
              subTarget.kind === "Identifier" ||
              subTarget.kind === "UpperIdentifier"
                ? {
                    kind: "VariablePattern",
                    name: subTarget,
                    span: subTarget.span,
                  }
                : subTarget,
            span: el.span,
          });
        } else {
          const subTarget = this.expressionToBindingTarget(el);
          if (!subTarget) return null;
          elements.push(
            subTarget.kind === "Identifier" ||
              subTarget.kind === "UpperIdentifier"
              ? {
                  kind: "VariablePattern",
                  name: subTarget,
                  span: subTarget.span,
                }
              : subTarget,
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

  private parseValueParameter(
    name: BindingTarget,
    nameOnlySpan = false,
    isRest = false,
  ): Parameter {
    const optional = this.match(TokenType.QUESTION);
    let typeAnnotation: TypeNode | undefined;
    if (this.match(TokenType.COLON)) {
      const previous = this.allowOptionalRecordFields;
      this.allowOptionalRecordFields = this.check(TokenType.LBRACE);
      try {
        typeAnnotation = this.parseTypeNode();
      } finally {
        this.allowOptionalRecordFields = previous;
      }
    }
    if (optional && !typeAnnotation)
      throw new ParseError(
        "Optional parameters require a type annotation",
        name.span,
      );
    const defaultValue = this.match(TokenType.EQ)
      ? this.parseExpression()
      : undefined;
    if (optional && defaultValue)
      throw new ParseError(
        "A parameter cannot be both optional and defaulted",
        name.span,
      );
    return {
      kind: "Parameter",
      name,
      typeAnnotation,
      optional,
      defaultValue,
      isRest: isRest ? true : undefined,
      span: nameOnlySpan
        ? name.span
        : {
            start: name.span.start,
            end: (defaultValue ?? typeAnnotation ?? name).span.end,
          },
    };
  }

  public validateValueParameters(params: Parameter[]): void {
    for (let i = 0; i < params.length; i++) {
      if (
        params[i].optional &&
        params.slice(i + 1).some((p) => !p.optional && !p.isRest)
      ) {
        throw new ParseError(
          "Only optional parameters may follow an optional parameter",
          params[i].span,
        );
      }
      if (params[i].isRest) {
        if (i !== params.length - 1) {
          throw new ParseError(
            "A rest parameter must be the last parameter in a parameter list",
            params[i].span,
          );
        }
        if (params[i].optional) {
          throw new ParseError(
            "A rest parameter cannot be optional",
            params[i].span,
          );
        }
        if (params[i].defaultValue) {
          throw new ParseError(
            "A rest parameter cannot have a default value",
            params[i].span,
          );
        }
      }
    }
  }

  public parseWhenStatement(): WhenStatement {
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
        throw new ParseError(
          "Early return 'when (...) =>' is rejected outside function context",
          this.previous().span,
        );
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

    throw new ParseError(
      "Expected '=>' or conditional block '{ ... }' after when condition",
      this.peek().span,
    );
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

    this.enterScope();
    this.addMutDraftVariable(draftParam.name);
    let body: FunctionBody;
    try {
      body = this.parseFunctionBody();
    } finally {
      this.exitScope();
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
    if (
      expr.kind === "UnaryExpression" &&
      this.isPrimitiveLiteral(expr.argument)
    ) {
      return true;
    }
    if (expr.kind === "BinaryExpression") {
      return true;
    }
    return false;
  }

  private parseEquality(): Expression {
    let expr = this.parseComparison();
    while (
      this.match(
        TokenType.VALUE_EQ,
        TokenType.VALUE_NEQ,
        TokenType.REF_EQ,
        TokenType.REF_NEQ,
      )
    ) {
      const opTok = this.previous();
      const op = opTok.value as "#=" | "#!" | "@=" | "@!";
      const right = this.parseComparison();
      if (op === "@=" || op === "@!") {
        if (this.isPrimitiveLiteral(expr) || this.isPrimitiveLiteral(right)) {
          throw new ParseError(
            `Reference identity operator '${op}' cannot be used with primitive values; use '#=' or '#!' for value equality`,
            opTok.span,
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
    while (
      this.match(TokenType.LT, TokenType.LTE, TokenType.GT, TokenType.GTE)
    ) {
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
      if (
        this.check(TokenType.TEMPLATE_STRING) ||
        this.check(TokenType.TEMPLATE_PART)
      ) {
        const template = this.parseTemplateLiteral();
        expr = {
          kind: "TaggedTemplateExpression",
          tag: expr,
          template,
          span: { start: expr.span.start, end: template.span.end },
        };
      } else if (
        this.check(TokenType.LT) &&
        this.isTypeArgumentListBeforeTemplate()
      ) {
        const typeArgs = this.parseTypeArguments();
        const template = this.parseTemplateLiteral();
        expr = {
          kind: "TaggedTemplateExpression",
          tag: expr,
          typeArguments: typeArgs,
          template,
          span: { start: expr.span.start, end: template.span.end },
        };
      } else if (this.match(TokenType.LPAREN)) {
        this.skipNewlines();
        while (this.match(TokenType.INDENT) || this.match(TokenType.DEDENT)) {}
        this.skipNewlines();
        const args: Expression[] = [];
        if (!this.check(TokenType.RPAREN)) {
          do {
            this.skipNewlines();
            while (
              this.match(TokenType.INDENT) ||
              this.match(TokenType.DEDENT)
            ) {}
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
            while (
              this.match(TokenType.INDENT) ||
              this.match(TokenType.DEDENT)
            ) {}
            this.skipNewlines();
          } while (
            this.match(TokenType.COMMA) &&
            !this.check(TokenType.RPAREN)
          );
        }
        this.skipNewlines();
        while (this.match(TokenType.INDENT) || this.match(TokenType.DEDENT)) {}
        this.skipNewlines();
        const end = this.consume(
          TokenType.RPAREN,
          "Expected ')' after call arguments",
        ).span.end;
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
          property: prop,
          span: { start: expr.span.start, end: prop.span.end },
        };
      } else if (
        this.check(TokenType.LBRACKET) &&
        this.peek().span.start.line === expr.span.end.line
      ) {
        this.advance();
        const index = this.parseExpression();
        const end = this.consume(TokenType.RBRACKET, "Expected ']' after index")
          .span.end;
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

  public parsePrimary(): Expression {
    if (this.parsingBraceEffect && this.isAtEnd()) {
      throw new ParseError(
        "Expected '}' to close effect block",
        this.peek().span,
      );
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
        label = this.parseStringLiteral()
          .parts.map((p) => (p.kind === "StringRawPart" ? p.value : ""))
          .join("");
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
    if (
      this.check(TokenType.TEMPLATE_STRING) ||
      this.check(TokenType.TEMPLATE_PART)
    ) {
      return this.parseTemplateLiteral();
    }
    if (this.match(TokenType.TRUE)) {
      return {
        kind: "BooleanLiteral",
        value: true,
        span: this.previous().span,
      };
    }
    if (this.match(TokenType.FALSE)) {
      return {
        kind: "BooleanLiteral",
        value: false,
        span: this.previous().span,
      };
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
          this.advance();
          arrowConsumed = true;
          returnType = this.parseTypeNode();
          this.match(TokenType.ARROW);
        }
        if (arrowConsumed || this.match(TokenType.ARROW)) {
          const body = this.parseFunctionBody(true);
          return {
            kind: "FunctionExpression",
            params: [],
            returnType,
            body,
            span: { start, end: body.span.end },
          };
        }
        throw new ParseError(
          "Empty parentheses '()' must be followed by '=>'",
          this.previous().span,
        );
      }

      // Check if this looks like function params (param: Type, ...) => or (...rest) =>
      let firstIsRest = false;
      let firstDotSpan: Span | undefined;
      if (this.match(TokenType.DOTDOTDOT)) {
        firstIsRest = true;
        firstDotSpan = this.previous().span;
      }

      const firstExpr = firstIsRest
        ? this.parseIdentifier()
        : this.parseExpression();

      if (
        firstIsRest ||
        this.check(TokenType.COLON) ||
        this.check(TokenType.COMMA) ||
        this.check(TokenType.QUESTION) ||
        this.check(TokenType.EQ)
      ) {
        const firstTarget = this.expressionToBindingTarget(firstExpr);
        if (!firstTarget)
          throw new ParseError(
            "Expected a parameter name or pattern",
            firstExpr.span,
          );
        const firstParam = this.parseValueParameter(
          firstTarget,
          true,
          firstIsRest,
        );
        if (firstDotSpan) {
          firstParam.span = {
            start: firstDotSpan.start,
            end: firstParam.span.end,
          };
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
            pTarget = this.parseBindingPattern();
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
          throw new ParseError(
            "Expected '=>' after parameters",
            this.peek().span,
          );
        }
        const body = this.parseFunctionBody(true);
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
        const body = this.parseFunctionBody(true);
        const paramTarget = this.expressionToBindingTarget(firstExpr);
        if (!paramTarget)
          throw new ParseError(
            "Expected parameter name or pattern",
            firstExpr.span,
          );
        return {
          kind: "FunctionExpression",
          params: [
            { kind: "Parameter", name: paramTarget, span: firstExpr.span },
          ],
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
      const body = this.parseFunctionBody(true);
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

    // 10b. Par Block: par ...
    if (this.match(TokenType.PAR)) {
      return this.parseParBlock();
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
      if (this.match(TokenType.DOT)) {
        throw new ParseError(
          "FunScript has no 'js.try'; use 'js <expr>' (or '<- js <expr>') directly.",
          this.previous().span,
        );
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

    throw new ParseError(
      `Unexpected token '${this.peek().value}' (${this.peek().type})`,
      this.peek().span,
    );
  }

  private parseRecordLiteral(): RecordExpression {
    const start = this.consume(TokenType.LBRACE, "Expected '{'").span.start;
    const entries: RecordEntry[] = [];

    this.skipNewlines();
    const hasIndent = this.match(TokenType.INDENT);

    while (
      !this.check(TokenType.RBRACE) &&
      !this.check(TokenType.DEDENT) &&
      !this.isAtEnd()
    ) {
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
          const path: (Identifier | UpperIdentifier)[] = [firstId];
          do {
            path.push(this.parsePropertyIdentifier());
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
    if (
      !isPipeline &&
      !this.check(TokenType.BAR) &&
      !this.check(TokenType.NEWLINE) &&
      !this.check(TokenType.INDENT)
    ) {
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
            },
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

  public parsePattern(): Pattern {
    return parsePatternImpl(this);
  }

  // --- Effect Blocks ---

  private parseEffectBlock(): EffectBlockExpression {
    const start = this.previous().span.start;
    let unscoped = false;
    if (this.match(TokenType.LPAREN)) {
      if (
        this.check(TokenType.IDENTIFIER) &&
        this.peek().value === "unscoped"
      ) {
        this.advance();
        unscoped = true;
      }
      this.consume(TokenType.RPAREN, "Expected ')' after effect options");
    }
    this.consume(
      TokenType.LBRACE,
      "Expected '{' after 'effect' (effect blocks require braces)",
    );
    this.parsingBraceEffect = true;
    this.enterScope();

    try {
      const body: EffectStatement[] = [];
      let finalExpression: Expression | undefined;

      const atEnd = () => this.check(TokenType.RBRACE);
      while (!atEnd() && !this.isAtEnd()) {
        this.skipNewlines();
        while (this.match(TokenType.INDENT) || this.match(TokenType.DEDENT)) {}
        if (atEnd()) break;

        if (this.match(TokenType.ARROW)) {
          finalExpression = this.parseExpression();
          this.skipNewlines();
          while (
            this.match(TokenType.INDENT) ||
            this.match(TokenType.DEDENT)
          ) {}
          if (!atEnd() && !this.isAtEnd())
            throw new ParseError(
              "Effect block return must be the final statement",
              finalExpression.span,
            );
          break;
        } else if (this.check(TokenType.WHEN)) {
          body.push(this.parseWhenStatement());
          // Check for effect bind: x <- eff or _ <- eff
        } else if (
          this.check(TokenType.UNDERSCORE) &&
          this.peekAhead(1).type === TokenType.LARROW
        ) {
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
          (this.check(TokenType.IDENTIFIER) &&
            this.peekAhead(1).type === TokenType.LARROW) ||
          this.isDestructuringEffectBindStart()
        ) {
          const id =
            this.check(TokenType.LBRACE) || this.check(TokenType.LBRACKET)
              ? this.parseBindingPattern()
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
        } else if (
          this.check(TokenType.IDENTIFIER) &&
          this.peekAhead(1).type === TokenType.EQ &&
          this.isMutableVariable(this.peek().value)
        ) {
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
          (this.check(TokenType.IDENTIFIER) &&
            (this.peekAhead(1).type === TokenType.EQ ||
              this.peekAhead(1).type === TokenType.COLON)) ||
          (this.check(TokenType.UNDERSCORE) &&
            this.peekAhead(1).type === TokenType.EQ) ||
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
          while (
            this.match(TokenType.INDENT) ||
            this.match(TokenType.DEDENT)
          ) {}
          if (atEnd()) {
            throw new ParseError(EFFECT_RETURN_DIAGNOSTIC, expr.span);
          } else {
            throw new ParseError(EFFECT_BARE_EXPR_DIAGNOSTIC, expr.span);
          }
        }
      }

      this.consume(TokenType.RBRACE, "Expected '}' to close effect block");
      this.parsingBraceEffect = false;

      if (!finalExpression) {
        throw new ParseError(EFFECT_RETURN_DIAGNOSTIC, {
          start,
          end: this.previous().span.end,
        });
      }

      return {
        kind: "EffectBlockExpression",
        body,
        finalExpression,
        unscoped,
        span: { start, end: finalExpression.span.end },
      };
    } finally {
      this.exitScope();
    }
  }

  private parseParBlock(): ParBlockExpression {
    this.enterScope();
    try {
      const start = this.previous().span.start;
      let concurrency: Expression | undefined;
      if (this.match(TokenType.LPAREN)) {
        if (
          this.check(TokenType.IDENTIFIER) &&
          this.peek().value === "concurrency" &&
          this.peekAhead(1).type === TokenType.EQ
        ) {
          this.advance(); // consume 'concurrency'
          this.advance(); // consume '='
          concurrency = this.parseExpression();
        } else if (!this.check(TokenType.RPAREN)) {
          concurrency = this.parseExpression();
        }
        this.consume(TokenType.RPAREN, "Expected ')' after par options");
      }

      const braced = this.match(TokenType.LBRACE);
      if (!braced) {
        this.consume(TokenType.NEWLINE, "Expected newline or '{' after 'par'");
        this.consume(TokenType.INDENT, "Expected indent after 'par'");
      }

      const body: EffectStatement[] = [];
      let finalExpression: Expression | undefined;
      let hasExplicitReturn = false;

      const atEnd = () =>
        braced ? this.check(TokenType.RBRACE) : this.check(TokenType.DEDENT);
      while (!atEnd() && !this.isAtEnd()) {
        this.skipNewlines();
        if (braced)
          while (
            this.match(TokenType.INDENT) ||
            this.match(TokenType.DEDENT)
          ) {}
        if (atEnd()) break;

        if (this.match(TokenType.ARROW)) {
          finalExpression = this.parseExpression();
          hasExplicitReturn = true;
          this.skipNewlines();
          if (braced)
            while (
              this.match(TokenType.INDENT) ||
              this.match(TokenType.DEDENT)
            ) {}
          if (!atEnd())
            throw new ParseError(
              "Par block return must be the final statement",
              finalExpression.span,
            );
          break;
        } else if (this.check(TokenType.WHEN)) {
          const whenToken = this.advance();
          throw new ParseError(
            "Early return 'when (...) =>' is rejected inside 'par' blocks because it leaves sibling fibers in an ambiguous state",
            whenToken.span,
          );
        } else if (
          this.check(TokenType.UNDERSCORE) &&
          this.peekAhead(1).type === TokenType.LARROW
        ) {
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
          (this.check(TokenType.IDENTIFIER) &&
            this.peekAhead(1).type === TokenType.LARROW) ||
          this.isDestructuringEffectBindStart()
        ) {
          const id =
            this.check(TokenType.LBRACE) || this.check(TokenType.LBRACKET)
              ? this.parseBindingPattern()
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
        } else if (
          this.check(TokenType.IDENTIFIER) &&
          this.peekAhead(1).type === TokenType.EQ
        ) {
          const id = this.parseIdentifier();
          this.consume(TokenType.EQ, "Expected '=' in assignment");
          const value = this.parseExpression();
          this.consumeNewlineOrEof("Expected newline after assignment");
          body.push({
            kind: "BindingDeclaration",
            isMut: false,
            id,
            init: value,
            span: { start: id.span.start, end: value.span.end },
          });
        } else {
          const eff = this.parseExpression();
          this.consumeNewlineOrEof("Expected newline after effect statement");
          body.push({
            kind: "EffectDiscardStatement",
            effect: eff,
            span: { start: eff.span.start, end: eff.span.end },
          });
        }
      }

      if (braced) {
        this.consume(TokenType.RBRACE, "Expected '}' to close par block");
      } else {
        this.consume(TokenType.DEDENT, "Expected dedent to close par block");
      }

      const resolvedFinalExpression: Expression = finalExpression ?? {
        kind: "RecordExpression",
        entries: body
          .filter(
            (s): s is EffectBindStatement =>
              s.kind === "EffectBindStatement" && s.id.kind === "Identifier",
          )
          .map((s) => ({
            kind: "ShorthandEntry" as const,
            key: s.id as Identifier,
            span: s.id.span,
          })),
        span: { start, end: this.previous().span.end },
      };

      return {
        kind: "ParBlockExpression",
        concurrency,
        body,
        finalExpression: resolvedFinalExpression,
        hasExplicitReturn,
        span: { start, end: resolvedFinalExpression.span.end },
      };
    } finally {
      this.exitScope();
    }
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
    if (
      firstTok.type === TokenType.WHEN ||
      firstTok.type === TokenType.MUT ||
      firstTok.type === TokenType.ARROW
    )
      return true;
    if (
      this.current + i + 1 < this.tokens.length &&
      this.tokens[this.current + i + 1].type === TokenType.EQ
    )
      return true;

    while (this.current + i < this.tokens.length) {
      const tok = this.tokens[this.current + i];
      if (tok.type === TokenType.RBRACE || tok.type === TokenType.DEDENT) break;
      if (tok.type === TokenType.ARROW) return true;
      if (tok.type === TokenType.WHEN || tok.type === TokenType.MUT)
        return true;
      if (tok.type === TokenType.DOTDOTDOT) return false;
      if (tok.type === TokenType.COLON) {
        let j = i + 1;
        let hasEq = false;
        while (this.current + j < this.tokens.length) {
          const t = this.tokens[this.current + j];
          if (
            t.type === TokenType.NEWLINE ||
            t.type === TokenType.COMMA ||
            t.type === TokenType.RBRACE ||
            t.type === TokenType.DEDENT
          )
            break;
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
      if (type === TokenType.DOT) {
        member = true;
        i += 2;
        continue;
      }
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
    return (
      this.peekAhead(i).type === TokenType.EQ &&
      (this.isMutableVariable(this.peek().value) ||
        (member && this.isMutDraftVariable(this.peek().value)))
    );
  }

  private parseAssignmentTarget():
    Identifier | DotPathExpression | IndexExpression {
    const expr = this.parsePostfix();
    if (expr.kind === "Identifier") return expr;
    if (expr.kind === "IndexExpression") return expr;
    if (expr.kind === "MemberExpression") {
      const path: (Identifier | UpperIdentifier)[] = [];
      let current: Expression = expr;
      while (current.kind === "MemberExpression") {
        path.unshift(current.property);
        current = current.object;
      }
      if (current.kind === "Identifier" || current.kind === "UpperIdentifier") {
        path.unshift(current);
      }
      return { kind: "DotPathExpression", path, span: expr.span };
    }
    throw new ParseError("Invalid assignment target", expr.span);
  }

  public collectPatternVariables(pat: Pattern | BindingTarget): string[] {
    return collectPatternVariablesImpl(pat);
  }

  public isDestructuringBindingStart(): boolean {
    return isDestructuringBindingStartImpl(this);
  }

  public isDestructuringEffectBindStart(): boolean {
    return isDestructuringEffectBindStartImpl(this);
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
        this.consume(
          TokenType.INDENT,
          "Expected indent for function body block",
        );
        return this.parseIndentedBlock(requireExplicitReturn);
      }
      return this.parseExpression();
    } finally {
      this.functionDepth--;
    }
  }

  private parseBraceBlock(requireExplicitReturn = false): BlockStatement {
    this.enterScope();
    try {
      const start = this.previous().span.start;
      const statements: Statement[] = [];
      let finalExpression: Expression | undefined;

      this.skipNewlines();
      const hasIndent = this.match(TokenType.INDENT);

      while (
        !this.check(TokenType.RBRACE) &&
        !this.check(TokenType.DEDENT) &&
        !this.isAtEnd()
      ) {
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
            (this.check(TokenType.IDENTIFIER) &&
              (this.peekAhead(1).type === TokenType.EQ ||
                this.peekAhead(1).type === TokenType.COLON)) ||
            (this.check(TokenType.UNDERSCORE) &&
              this.peekAhead(1).type === TokenType.EQ) ||
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

      if (
        requireExplicitReturn &&
        !finalExpression &&
        statements.at(-1)?.kind !== "ReturnStatement"
      ) {
        throw new ParseError(FUNCTION_RETURN_DIAGNOSTIC, {
          start,
          end: this.previous().span.end,
        });
      }
      if (hasIndent) {
        this.consume(TokenType.DEDENT, "Expected unindent after brace block");
      }
      this.skipNewlines();
      const end = this.consume(TokenType.RBRACE, "Expected '}' after block")
        .span.end;
      return {
        kind: "BlockStatement",
        statements,
        finalExpression,
        span: { start, end },
      };
    } finally {
      this.exitScope();
    }
  }

  private parseIndentedBlock(requireExplicitReturn = false): BlockStatement {
    this.enterScope();
    try {
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
            (this.check(TokenType.IDENTIFIER) &&
              (this.peekAhead(1).type === TokenType.EQ ||
                this.peekAhead(1).type === TokenType.COLON)) ||
            (this.check(TokenType.UNDERSCORE) &&
              this.peekAhead(1).type === TokenType.EQ) ||
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
                if (requireExplicitReturn)
                  throw new ParseError(FUNCTION_RETURN_DIAGNOSTIC, bind.span);
                bind.isTrailingBinding = true;
                statements.push(bind);
                if (
                  bind.id.kind === "Identifier" ||
                  bind.id.kind === "UpperIdentifier"
                ) {
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

      if (
        requireExplicitReturn &&
        !finalExpression &&
        statements.at(-1)?.kind !== "ReturnStatement"
      ) {
        throw new ParseError(FUNCTION_RETURN_DIAGNOSTIC, {
          start,
          end: this.previous().span.end,
        });
      }
      this.consume(TokenType.DEDENT, "Expected unindent after function body");
      const fallbackExpr: Expression = {
        kind: "Identifier",
        name: "_error",
        span: {
          start: this.previous().span.start,
          end: this.previous().span.end,
        },
      };
      return {
        kind: "BlockStatement",
        statements,
        finalExpression:
          finalExpression ??
          (statements.length === 0 ? fallbackExpr : undefined),
        span: {
          start:
            statements[0]?.span.start ||
            (finalExpression
              ? finalExpression.span.start
              : this.previous().span.start),
          end: (finalExpression ?? fallbackExpr).span.end,
        },
      };
    } finally {
      this.exitScope();
    }
  }

  // --- Types ---

  public parseTypeNode(): TypeNode {
    return parseTypeNode(this);
  }

  public parseUnionType(): TypeNode {
    return parseUnionType(this);
  }

  public parseIntersectionType(): TypeNode {
    return parseIntersectionType(this);
  }

  public parseFunctionTypeNode(): TypeNode {
    return parseFunctionTypeNode(this);
  }

  public parsePrimaryType(): TypeNode {
    return parsePrimaryType(this);
  }

  public parseEffectTypeNode(): EffectTypeNode {
    return parseEffectTypeNode(this);
  }

  public parseGenericFunctionExpression(): FunctionExpression {
    return parseGenericFunctionExpression(this);
  }

  public isGenericCallableStart(): boolean {
    return isGenericCallableStart(this);
  }

  public parseTypeParameters(): TypeParameter[] {
    return parseTypeParameters(this);
  }

  // --- JSX Parsing ---

  public parseJsxElement(): JSXElement | JSXSelfClosingElement {
    return parseJsxElement(this);
  }

  private parseJsxTagName(): JSXTagName {
    return parseJsxTagName(this);
  }

  private parseJsxAttribute(): JSXAttribute {
    return parseJsxAttribute(this);
  }

  private parseJsxExpressionContainer(): JSXExpressionContainer {
    return parseJsxExpressionContainer(this);
  }

  private formatTagName(name: JSXTagName): string {
    return formatTagName(name);
  }

  private areTagNamesEqual(a: JSXTagName, b: JSXTagName): boolean {
    return areTagNamesEqual(a, b);
  }

  // --- Helpers ---

  public parseIdentifier(): Identifier {
    const tok = this.consume(
      TokenType.IDENTIFIER,
      "Expected lowercase identifier",
    );
    return { kind: "Identifier", name: tok.value, span: tok.span };
  }

  public parseUpperIdentifier(): UpperIdentifier {
    const tok = this.consume(
      TokenType.UPPER_IDENTIFIER,
      "Expected UpperCamel identifier",
    );
    return { kind: "UpperIdentifier", name: tok.value, span: tok.span };
  }

  public parseAnyIdentifier(): Identifier | UpperIdentifier {
    if (this.check(TokenType.ERROR)) {
      const token = this.advance();
      return { kind: "Identifier", name: token.value, span: token.span };
    }
    if (this.check(TokenType.UPPER_IDENTIFIER))
      return this.parseUpperIdentifier();
    return this.parseIdentifier();
  }

  public parsePropertyIdentifier(): Identifier | UpperIdentifier {
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

  public parseRecordKeyIdentifier(): Identifier {
    if (this.match(TokenType.STRING)) {
      const tok = this.previous();
      return { kind: "Identifier", name: tok.value, span: tok.span };
    }
    const prop = this.parsePropertyIdentifier();
    return { kind: "Identifier", name: prop.name, span: prop.span };
  }

  public parseStringLiteral(): StringLiteral {
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

    while (
      this.check(TokenType.STRING_PART) ||
      this.check(TokenType.INTERPOLATION_START)
    ) {
      if (this.match(TokenType.STRING_PART)) {
        parts.push({ kind: "StringRawPart", value: this.previous().value });
      } else if (this.match(TokenType.INTERPOLATION_START)) {
        const expr = this.parseExpression();
        this.consume(
          TokenType.INTERPOLATION_END,
          "Expected '}' to close interpolation",
        );
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

  private parseTemplateLiteral(): TemplateLiteral {
    const start = this.peek().span.start;
    const parts: StringPart[] = [];

    if (this.match(TokenType.TEMPLATE_STRING)) {
      return {
        kind: "TemplateLiteral",
        parts: [{ kind: "StringRawPart", value: this.previous().value }],
        raw: `\`${this.previous().value}\``,
        span: this.previous().span,
      };
    }

    while (
      this.check(TokenType.TEMPLATE_PART) ||
      this.check(TokenType.INTERPOLATION_START)
    ) {
      if (this.match(TokenType.TEMPLATE_PART)) {
        parts.push({ kind: "StringRawPart", value: this.previous().value });
      } else if (this.match(TokenType.INTERPOLATION_START)) {
        const expr = this.parseExpression();
        this.consume(
          TokenType.INTERPOLATION_END,
          "Expected '}' to close interpolation",
        );
        parts.push({ kind: "StringInterpolationPart", expression: expr });
      }
    }

    return {
      kind: "TemplateLiteral",
      parts,
      raw: "",
      span: { start, end: this.previous().span.end },
    };
  }

  private isTypeArgumentListBeforeTemplate(): boolean {
    if (!this.check(TokenType.LT)) return false;
    let angleDepth = 1;
    for (let i = 1; i < 512; i++) {
      const token = this.peekAhead(i);
      if (token.type === TokenType.EOF || token.type === TokenType.NEWLINE)
        return false;
      if (token.type === TokenType.LT) {
        angleDepth++;
      } else if (token.type === TokenType.GT) {
        angleDepth--;
        if (angleDepth === 0) {
          const next = this.peekAhead(i + 1);
          return (
            next.type === TokenType.TEMPLATE_STRING ||
            next.type === TokenType.TEMPLATE_PART
          );
        }
      }
    }
    return false;
  }

  private parseTypeArguments(): TypeNode[] {
    this.consume(TokenType.LT, "Expected '<'");
    const args: TypeNode[] = [];
    do {
      args.push(this.parseTypeNode());
    } while (this.match(TokenType.COMMA) && !this.check(TokenType.GT));
    this.consume(TokenType.GT, "Expected '>'");
    return args;
  }

  public skipNewlines(): void {
    while (this.match(TokenType.NEWLINE)) {}
  }

  public consumeNewlineOrEof(message = "Expected newline"): void {
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
    throw new ParseError(
      `${message} (got '${this.peek().value}', expected NEWLINE)`,
      this.peek().span,
    );
  }

  public match(...types: TokenType[]): boolean {
    for (const type of types) {
      if (this.check(type)) {
        this.advance();
        return true;
      }
    }
    return false;
  }

  public check(type: TokenType): boolean {
    if (this.isAtEnd()) return type === TokenType.EOF;
    return this.peek().type === type;
  }

  public advance(): Token {
    if (!this.isAtEnd()) this.current++;
    return this.previous();
  }

  public isAtEnd(): boolean {
    return this.peek().type === TokenType.EOF;
  }

  public peek(): Token {
    return this.tokens[this.current] || this.tokens[this.tokens.length - 1];
  }

  public peekAhead(n: number): Token {
    return this.tokens[this.current + n] || this.tokens[this.tokens.length - 1];
  }

  public previous(): Token {
    return this.tokens[this.current - 1];
  }

  public consume(type: TokenType, message: string): Token {
    if (this.check(type)) return this.advance();
    throw new ParseError(
      `${message} (got '${this.peek().value}', expected ${type})`,
      this.peek().span,
    );
  }
}
