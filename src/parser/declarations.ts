import type {
  BindingDeclaration,
  BindingTarget,
  ErrorDeclaration,
  ErrorField,
  ExportDefaultDeclaration,
  ExportFromDeclaration,
  Expression,
  Identifier,
  ImportDeclaration,
  ImportedTsSchema,
  ImportSpecifier,
  Position,
  RecordFieldSchema,
  RecordSchema,
  SchemaBody,
  SchemaDeclaration,
  ServiceDeclaration,
  ServiceMember,
  StringLiteral,
  StructuralUnionSchema,
  TaggedUnionSchema,
  TopLevelDeclaration,
  TsDerivedSchema,
  TypeNode,
  TypeParameter,
  UpperIdentifier,
  VariantDeclaration,
  VariantField,
} from "../ast/types.js";
import { TokenType } from "../lexer/tokens.js";
import { ParseError } from "./errors.js";
import type { Parser } from "./parser.js";

export type DeclarationParserContext = Parser;

export function parseTopLevelDeclaration(
  ctx: DeclarationParserContext,
): TopLevelDeclaration {
  if (ctx.match(TokenType.EXPORT)) {
    const exportStart = ctx.previous().span.start;
    if (ctx.match(TokenType.DEFAULT)) {
      return parseExportDefaultDeclaration(ctx, exportStart);
    }
    if (isExportFrom(ctx)) return parseExportFrom(ctx, exportStart);
    const isJs = ctx.match(TokenType.JS);
    const isTs = !isJs && ctx.match(TokenType.TS);
    const decl = parseDeclaration(ctx, isJs, isTs);
    if (
      decl.kind !== "SchemaDeclaration" &&
      decl.kind !== "ErrorDeclaration" &&
      decl.kind !== "ServiceDeclaration" &&
      decl.kind !== "BindingDeclaration"
    ) {
      throw new ParseError("Invalid declaration for export", decl.span);
    }
    return {
      kind: "ExportDeclaration",
      declaration: decl,
      span: { start: exportStart, end: decl.span.end },
    };
  }
  return parseDeclaration(ctx);
}

export function isExportFrom(ctx: DeclarationParserContext): boolean {
  let offset =
    ctx.check(TokenType.IDENTIFIER) && ctx.peek().value === "type" ? 1 : 0;
  if (ctx.peekAhead(offset).type !== TokenType.LBRACE) return false;
  while (
    ctx.peekAhead(offset).type !== TokenType.RBRACE &&
    ctx.peekAhead(offset).type !== TokenType.NEWLINE &&
    ctx.peekAhead(offset).type !== TokenType.EOF
  )
    offset++;
  return (
    ctx.peekAhead(offset).type === TokenType.RBRACE &&
    ctx.peekAhead(offset + 1).type === TokenType.FROM
  );
}

export function parseExportFrom(
  ctx: DeclarationParserContext,
  start: Position,
): ExportFromDeclaration {
  const isTypeOnly =
    ctx.check(TokenType.IDENTIFIER) && ctx.peek().value === "type";
  if (isTypeOnly) ctx.advance();
  ctx.consume(TokenType.LBRACE, "Expected '{' in re-export");
  const specifiers: ImportSpecifier[] = [];
  if (!ctx.check(TokenType.RBRACE)) {
    do {
      let specTypeOnly = false;
      if (
        !isTypeOnly &&
        ctx.check(TokenType.IDENTIFIER) &&
        ctx.peek().value === "type" &&
        ctx.peekAhead(1).type !== TokenType.COMMA &&
        ctx.peekAhead(1).type !== TokenType.RBRACE &&
        ctx.peekAhead(1).value !== "as"
      ) {
        ctx.advance();
        specTypeOnly = true;
      }
      const imported = ctx.parseAnyIdentifier();
      let local = imported;
      if (ctx.check(TokenType.IDENTIFIER) && ctx.peek().value === "as") {
        ctx.advance();
        local = ctx.parseAnyIdentifier();
      }
      specifiers.push({
        kind: "ImportSpecifier",
        imported,
        local,
        isTypeOnly: specTypeOnly,
        span: { start: imported.span.start, end: local.span.end },
      });
    } while (ctx.match(TokenType.COMMA) && !ctx.check(TokenType.RBRACE));
  }
  ctx.consume(TokenType.RBRACE, "Expected '}' after re-export specifiers");
  ctx.consume(TokenType.FROM, "Expected 'from' after re-export specifiers");
  const source = parseImportSource(ctx);
  ctx.consumeNewlineOrEof("Expected newline after re-export");
  return {
    kind: "ExportFromDeclaration",
    isTypeOnly,
    specifiers,
    source,
    span: { start, end: source.span.end },
  };
}

export function parseExportDefaultDeclaration(
  ctx: DeclarationParserContext,
  start: Position,
): ExportDefaultDeclaration {
  if (ctx.hasDefaultExport) {
    throw new ParseError("Multiple default exports are not allowed", {
      start,
      end: ctx.previous().span.end,
    });
  }
  ctx.hasDefaultExport = true;
  let hasIndent = false;
  if (ctx.match(TokenType.NEWLINE)) {
    hasIndent = ctx.match(TokenType.INDENT);
  }
  const expression = ctx.parseExpression();
  if (hasIndent) {
    ctx.skipNewlines();
    if (!ctx.isAtEnd() && !ctx.check(TokenType.EOF)) {
      ctx.consume(TokenType.DEDENT, "Expected unindent after default export");
    }
  }
  ctx.consumeNewlineOrEof("Expected newline after default export");
  return {
    kind: "ExportDefaultDeclaration",
    expression,
    span: { start, end: expression.span.end },
  };
}

export function parseDeclaration(
  ctx: DeclarationParserContext,
  isJs = false,
  isTs = false,
): TopLevelDeclaration {
  if (ctx.check(TokenType.IMPORT)) {
    return parseImportDeclaration(ctx);
  }
  if (isTs) {
    if (ctx.check(TokenType.SCHEMA)) {
      return parseSchemaDeclaration(ctx, true);
    }
    throw new ParseError(
      "Expected 'schema' after 'export ts'",
      ctx.peek().span,
    );
  }
  if (ctx.match(TokenType.AS)) {
    const start = ctx.previous().span.start;
    const code = ctx.consume(
      TokenType.AS_CODE,
      "Expected '{ ... }' after 'as'",
    );
    ctx.consumeNewlineOrEof("Expected newline after as declaration");
    return {
      kind: "AsDeclaration",
      code: code.value,
      codeStart: code.contentStart,
      span: { start, end: code.span.end },
    };
  }
  if (ctx.match(TokenType.TS)) {
    const start = ctx.previous().span.start;
    if (ctx.check(TokenType.SCHEMA)) {
      return parseSchemaDeclaration(ctx, true, start);
    }
    const code = ctx.consumeTsCode();
    ctx.consumeNewlineOrEof("Expected newline after ts declaration");
    return {
      kind: "TsEscapeDeclaration",
      code: code.value,
      span: { start, end: code.span.end },
    };
  }
  if (ctx.match(TokenType.JS)) {
    return parseBindingDeclaration(ctx, true);
  }
  if (ctx.check(TokenType.SCHEMA)) {
    return parseSchemaDeclaration(ctx);
  }
  if (ctx.check(TokenType.ERROR)) {
    return parseErrorDeclaration(ctx);
  }
  if (ctx.check(TokenType.SERVICE)) {
    return parseServiceDeclaration(ctx);
  }
  if (ctx.check(TokenType.WHEN)) {
    return ctx.parseWhenStatement();
  }
  return parseBindingDeclaration(ctx, isJs);
}

export function parseImportDeclaration(
  ctx: DeclarationParserContext,
): ImportDeclaration {
  const start = ctx.consume(TokenType.IMPORT, "Expected 'import'").span.start;
  if (ctx.check(TokenType.STRING)) {
    const source = parseImportSource(ctx);
    ctx.consumeNewlineOrEof("Expected newline after import declaration");
    return {
      kind: "ImportDeclaration",
      isTypeOnly: false,
      isSideEffect: true,
      specifiers: [],
      source,
      span: { start, end: source.span.end },
    };
  }
  const isTypeOnly =
    ctx.check(TokenType.IDENTIFIER) &&
    ctx.peek().value === "type" &&
    ctx.peekAhead(1).type !== TokenType.FROM;
  if (isTypeOnly) ctx.advance();
  let defaultBinding: Identifier | UpperIdentifier | undefined;
  let namespaceBinding: Identifier | UpperIdentifier | undefined;
  const specifiers: ImportSpecifier[] = [];
  if (
    ctx.check(TokenType.IDENTIFIER) ||
    ctx.check(TokenType.UPPER_IDENTIFIER)
  ) {
    defaultBinding = ctx.parseAnyIdentifier();
    if (ctx.match(TokenType.COMMA)) {
      if (isTypeOnly)
        throw new ParseError(
          "A type-only import cannot combine a default binding with other bindings",
          ctx.peek().span,
        );
    } else {
      ctx.consume(TokenType.FROM, "Expected 'from' after import binding");
      const source = parseImportSource(ctx);
      ctx.consumeNewlineOrEof("Expected newline after import declaration");
      return {
        kind: "ImportDeclaration",
        isTypeOnly,
        isSideEffect: false,
        defaultBinding,
        specifiers,
        source,
        span: { start, end: source.span.end },
      };
    }
  }
  if (ctx.match(TokenType.STAR)) {
    if (!(ctx.check(TokenType.IDENTIFIER) && ctx.peek().value === "as")) {
      throw new ParseError(
        "Expected 'as' after '*' in namespace import",
        ctx.peek().span,
      );
    }
    ctx.advance();
    namespaceBinding = ctx.parseAnyIdentifier();
  } else {
    ctx.consume(TokenType.LBRACE, "Expected '{' or '*' in import declaration");
    if (!ctx.check(TokenType.RBRACE)) {
      do {
        let specTypeOnly = false;
        if (
          ctx.check(TokenType.IDENTIFIER) &&
          ctx.peek().value === "type" &&
          ctx.peekAhead(1).type !== TokenType.COMMA &&
          ctx.peekAhead(1).type !== TokenType.RBRACE &&
          ctx.peekAhead(1).value !== "as"
        ) {
          ctx.advance();
          specTypeOnly = true;
          if (isTypeOnly)
            throw new ParseError(
              "A type-only import cannot contain a type-only specifier",
              ctx.previous().span,
            );
        }
        let importedId: Identifier | UpperIdentifier;
        if (ctx.match(TokenType.DEFAULT)) {
          const token = ctx.previous();
          importedId = {
            kind: "Identifier",
            name: token.value,
            span: token.span,
          };
        } else importedId = ctx.parseAnyIdentifier();
        let localId = importedId;
        if (ctx.check(TokenType.IDENTIFIER) && ctx.peek().value === "as") {
          ctx.advance();
          localId = ctx.parseAnyIdentifier();
        } else if (importedId.name === "default") {
          throw new ParseError(
            "A default import specifier requires an alias",
            importedId.span,
          );
        }
        specifiers.push({
          kind: "ImportSpecifier",
          isTypeOnly: specTypeOnly,
          imported: importedId,
          local: localId,
          span: { start: importedId.span.start, end: localId.span.end },
        });
      } while (ctx.match(TokenType.COMMA) && !ctx.check(TokenType.RBRACE));
    }
    ctx.consume(TokenType.RBRACE, "Expected '}' after import specifiers");
  }
  ctx.consume(TokenType.FROM, "Expected 'from' after import specifiers");
  const source = parseImportSource(ctx);
  ctx.consumeNewlineOrEof("Expected newline after import declaration");
  return {
    kind: "ImportDeclaration",
    isTypeOnly,
    isSideEffect: false,
    defaultBinding,
    namespaceBinding,
    specifiers,
    source,
    span: { start, end: source.span.end },
  };
}

export function parseImportSource(
  ctx: DeclarationParserContext,
): StringLiteral {
  if (!ctx.check(TokenType.STRING)) {
    throw new ParseError(
      "Expected a non-interpolated string module specifier",
      ctx.peek().span,
    );
  }
  return ctx.parseStringLiteral();
}

export function parseSchemaDeclaration(
  ctx: DeclarationParserContext,
  isTs = false,
  tsStart?: Position,
): SchemaDeclaration {
  const start =
    tsStart ?? ctx.consume(TokenType.SCHEMA, "Expected 'schema'").span.start;
  if (tsStart) {
    ctx.consume(TokenType.SCHEMA, "Expected 'schema'");
  }
  const id = ctx.parseUpperIdentifier();
  let typeParams: TypeParameter[] | undefined;

  if (ctx.check(TokenType.LT)) {
    typeParams = ctx.parseTypeParameters();
  }

  ctx.consume(TokenType.EQ, "Expected '=' after schema name");

  const body = isTs ? parseTsDerivedSchema(ctx) : parseSchemaBody(ctx);
  ctx.consumeNewlineOrEof("Expected newline after schema declaration");

  return {
    kind: "SchemaDeclaration",
    id,
    typeParams,
    body,
    isTs: isTs ? true : undefined,
    span: { start, end: body.span.end },
  };
}

export function parseTsDerivedSchema(
  ctx: DeclarationParserContext,
): TsDerivedSchema {
  ctx.skipNewlines();
  const targetType = ctx.parseTypeNode();
  return {
    kind: "TsDerivedSchema",
    targetType,
    span: targetType.span,
  };
}

export function parseSchemaBody(ctx: DeclarationParserContext): SchemaBody {
  ctx.skipNewlines();

  // 0. Imported TypeScript Schema: from ts<Type>
  if (ctx.check(TokenType.FROM)) {
    return parseImportedTsSchema(ctx);
  }

  // 1. Tagged Union: | Variant(...)
  if (
    ctx.check(TokenType.BAR) ||
    (ctx.check(TokenType.INDENT) && ctx.peekAhead(1).type === TokenType.BAR)
  ) {
    const first = ctx.check(TokenType.INDENT)
      ? ctx.peekAhead(2)
      : ctx.peekAhead(1);
    if (
      [
        TokenType.STRING,
        TokenType.NUMBER,
        TokenType.TRUE,
        TokenType.FALSE,
        TokenType.LBRACE,
      ].includes(first.type)
    ) {
      return parseStructuralUnionSchema(ctx);
    }
    return parseTaggedUnionSchema(ctx);
  }

  // 2. Struct Schema: { ... }
  if (ctx.check(TokenType.LBRACE)) {
    return parseRecordSchema(ctx);
  }

  // 3. Function / Effect type alias or Refinement
  const typeNode = ctx.parseTypeNode();
  if (ctx.match(TokenType.PIPE)) {
    const refinement = ctx.parseExpression();
    return {
      kind: "RefinementSchema",
      baseType: typeNode,
      refinement,
      span: { start: typeNode.span.start, end: refinement.span.end },
    };
  }

  return {
    kind: "TypeSignatureSchema",
    signature: typeNode,
    span: typeNode.span,
  };
}

export function parseImportedTsSchema(
  ctx: DeclarationParserContext,
): ImportedTsSchema {
  const fromToken = ctx.consume(TokenType.FROM, "Expected 'from'");
  ctx.consume(TokenType.TS, "Expected 'ts' after 'from'");
  ctx.consume(TokenType.LT, "Expected '<' after 'ts'");

  if (ctx.check(TokenType.GT)) {
    throw new ParseError(
      "Expected type argument inside 'ts<...>'",
      ctx.peek().span,
    );
  }

  const typeArgs: TypeNode[] = [];
  do {
    typeArgs.push(ctx.parseTypeNode());
  } while (ctx.match(TokenType.COMMA) && !ctx.check(TokenType.GT));

  const gtToken = ctx.consume(TokenType.GT, "Expected '>' after type argument");

  return {
    kind: "ImportedTsSchema",
    typeNode: typeArgs[0],
    typeArgs,
    typeArguments: typeArgs,
    span: { start: fromToken.span.start, end: gtToken.span.end },
  };
}

export function parseRecordSchema(ctx: DeclarationParserContext): RecordSchema {
  const start = ctx.consume(TokenType.LBRACE, "Expected '{'").span.start;
  const fields: RecordFieldSchema[] = [];

  ctx.skipNewlines();
  const hasIndent = ctx.match(TokenType.INDENT);

  while (
    !ctx.check(TokenType.RBRACE) &&
    !ctx.check(TokenType.DEDENT) &&
    !ctx.isAtEnd()
  ) {
    ctx.skipNewlines();
    if (ctx.check(TokenType.RBRACE) || ctx.check(TokenType.DEDENT)) break;

    const fieldName: Identifier = ctx.parseRecordKeyIdentifier();
    const optional = ctx.match(TokenType.QUESTION);
    ctx.consume(TokenType.COLON, "Expected ':' after field name");
    const previous = ctx.allowOptionalRecordFields;
    ctx.allowOptionalRecordFields = true;
    let fieldType: TypeNode;
    try {
      fieldType = ctx.parseTypeNode();
    } finally {
      ctx.allowOptionalRecordFields = previous;
    }
    let defaultValue: Expression | undefined;

    if (ctx.match(TokenType.EQ)) {
      if (optional)
        throw new ParseError(
          "A schema field cannot be both optional and defaulted",
          fieldName.span,
        );
      defaultValue = ctx.parseExpression();
    }

    fields.push({
      kind: "RecordFieldSchema",
      name: fieldName,
      typeAnnotation: fieldType,
      optional,
      defaultValue,
      span: {
        start: fieldName.span.start,
        end: (defaultValue || fieldType).span.end,
      },
    });

    ctx.match(TokenType.COMMA);
    ctx.skipNewlines();
  }

  if (hasIndent) {
    ctx.consume(TokenType.DEDENT, "Expected unindent after schema fields");
  }
  ctx.skipNewlines();
  const end = ctx.consume(TokenType.RBRACE, "Expected '}' after record schema")
    .span.end;

  return {
    kind: "RecordSchema",
    fields,
    span: { start, end },
  };
}

export function parseStructuralUnionSchema(
  ctx: DeclarationParserContext,
): StructuralUnionSchema {
  const start = ctx.peek().span.start;
  const hasIndent = ctx.match(TokenType.INDENT);
  const members: TypeNode[] = [];
  while (ctx.match(TokenType.BAR)) {
    const previous = ctx.allowOptionalRecordFields;
    ctx.allowOptionalRecordFields = true;
    try {
      members.push(ctx.parsePrimaryType());
    } finally {
      ctx.allowOptionalRecordFields = previous;
    }
    ctx.skipNewlines();
  }
  if (hasIndent)
    ctx.consume(TokenType.DEDENT, "Expected unindent after union members");
  return {
    kind: "StructuralUnionSchema",
    members,
    span: { start, end: members[members.length - 1].span.end },
  };
}

export function parseTaggedUnionSchema(
  ctx: DeclarationParserContext,
): TaggedUnionSchema {
  const start = ctx.peek().span.start;
  const variants: VariantDeclaration[] = [];
  const hasIndent = ctx.match(TokenType.INDENT);

  while (
    ctx.match(TokenType.BAR) ||
    (variants.length === 0 && ctx.check(TokenType.UPPER_IDENTIFIER))
  ) {
    const varStart = ctx.previous().span.start;
    const varName = ctx.parseUpperIdentifier();
    const fields: VariantField[] = [];

    if (ctx.match(TokenType.LPAREN)) {
      if (!ctx.check(TokenType.RPAREN)) {
        do {
          const fName = ctx.parseIdentifier();
          ctx.consume(TokenType.COLON, "Expected ':' after variant field name");
          const fType = ctx.parseTypeNode();
          fields.push({
            kind: "VariantField",
            name: fName,
            typeAnnotation: fType,
            span: { start: fName.span.start, end: fType.span.end },
          });
        } while (ctx.match(TokenType.COMMA) && !ctx.check(TokenType.RPAREN));
      }
      ctx.consume(TokenType.RPAREN, "Expected ')' after variant fields");
    }

    variants.push({
      kind: "VariantDeclaration",
      name: varName,
      fields,
      span: { start: varStart, end: ctx.previous().span.end },
    });

    ctx.skipNewlines();
    if (!ctx.check(TokenType.BAR)) break;
  }

  if (hasIndent) {
    ctx.consume(
      TokenType.DEDENT,
      "Expected unindent after tagged union variants",
    );
  }

  return {
    kind: "TaggedUnionSchema",
    variants,
    span: { start, end: variants[variants.length - 1].span.end },
  };
}

export function parseErrorDeclaration(
  ctx: DeclarationParserContext,
): ErrorDeclaration {
  const start = ctx.consume(TokenType.ERROR, "Expected 'error'").span.start;
  const id = ctx.parseUpperIdentifier();
  const fields: ErrorField[] = [];

  if (ctx.match(TokenType.LPAREN)) {
    if (!ctx.check(TokenType.RPAREN)) {
      do {
        const fName = ctx.parseIdentifier();
        ctx.consume(TokenType.COLON, "Expected ':' after error field name");
        const fType = ctx.parseTypeNode();
        fields.push({
          kind: "ErrorField",
          name: fName,
          typeAnnotation: fType,
          span: { start: fName.span.start, end: fType.span.end },
        });
      } while (ctx.match(TokenType.COMMA) && !ctx.check(TokenType.RPAREN));
    }
    ctx.consume(TokenType.RPAREN, "Expected ')' after error fields");
  }

  ctx.consumeNewlineOrEof("Expected newline after error declaration");

  return {
    kind: "ErrorDeclaration",
    id,
    fields,
    span: { start, end: ctx.previous().span.end },
  };
}

export function parseServiceDeclaration(
  ctx: DeclarationParserContext,
): ServiceDeclaration {
  const start = ctx.consume(TokenType.SERVICE, "Expected 'service'").span.start;
  const id = ctx.parseUpperIdentifier();
  let customTag: StringLiteral | undefined;

  if (ctx.check(TokenType.STRING)) {
    customTag = ctx.parseStringLiteral();
  }

  ctx.consume(TokenType.NEWLINE, "Expected newline before service members");
  ctx.consume(TokenType.INDENT, "Expected indent before service members");

  const members: ServiceMember[] = [];
  while (!ctx.check(TokenType.DEDENT) && !ctx.isAtEnd()) {
    ctx.skipNewlines();
    if (ctx.check(TokenType.DEDENT)) break;

    const mStart = ctx.peek().span.start;
    const mName = ctx.parseIdentifier();
    ctx.consume(TokenType.COLON, "Expected ':' after service member name");
    const sig = ctx.parseFunctionTypeNode();
    if (sig.kind !== "FunctionTypeNode") {
      throw new ParseError(
        "Expected function type signature for service member",
        sig.span,
      );
    }

    members.push({
      kind: "ServiceMember",
      name: mName,
      signature: sig,
      span: { start: mStart, end: sig.span.end },
    });

    ctx.skipNewlines();
  }

  ctx.consume(TokenType.DEDENT, "Expected unindent after service members");

  return {
    kind: "ServiceDeclaration",
    id,
    customTag,
    members,
    span: { start, end: ctx.previous().span.end },
  };
}

export function parseBindingDeclaration(
  ctx: DeclarationParserContext,
  isJs = false,
): BindingDeclaration {
  const start = ctx.peek().span.start;
  const isMut = ctx.match(TokenType.MUT);
  let id: BindingTarget;
  if (ctx.check(TokenType.LBRACE) || ctx.check(TokenType.LBRACKET)) {
    id = ctx.parseBindingPattern();
    if (isMut) {
      for (const name of ctx.collectPatternVariables(id)) {
        ctx.addMutableVariable(name);
      }
    }
  } else {
    id = ctx.parseAnyIdentifier();
    if (isMut) {
      ctx.addMutableVariable(id.name);
    }
  }
  let typeParams: TypeParameter[] | undefined;
  if (
    (id.kind === "Identifier" || id.kind === "UpperIdentifier") &&
    ctx.check(TokenType.LT)
  ) {
    typeParams = ctx.parseTypeParameters();
  }
  let typeAnnotation: TypeNode | undefined;

  if (ctx.match(TokenType.COLON)) {
    typeAnnotation = ctx.parseTypeNode();
  }

  ctx.consume(TokenType.EQ, "Expected '=' in binding declaration");
  let hasIndent = false;
  if (ctx.match(TokenType.NEWLINE)) {
    hasIndent = ctx.match(TokenType.INDENT);
  }
  const init = ctx.parseExpression();
  if (typeParams) {
    if (init.kind !== "FunctionExpression") {
      throw new ParseError(
        "Generic type parameters require a function initializer",
        typeParams[0].span,
      );
    }
    if (init.typeParams?.length) {
      throw new ParseError(
        "Generic type parameters may be declared either after the binding name or before the parameter list, not both",
        typeParams[0].span,
      );
    }
    init.typeParams = typeParams;
    init.span = { start: typeParams[0].span.start, end: init.span.end };
  }
  if (
    isJs &&
    init.kind === "FunctionExpression" &&
    init.params.some(
      (p) =>
        p.typeAnnotation?.kind === "RecordTypeNode" &&
        p.typeAnnotation.fields.some((field) => field.defaultValue),
    )
  ) {
    throw new ParseError(
      "Defaulted parameters inside record contracts are not yet supported on js entry bindings",
      init.span,
    );
  }
  if (hasIndent) {
    ctx.skipNewlines();
    if (!ctx.isAtEnd() && !ctx.check(TokenType.EOF)) {
      ctx.consume(
        TokenType.DEDENT,
        "Expected unindent after binding expression",
      );
    }
  }
  ctx.consumeNewlineOrEof("Expected newline after binding");

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
