import {
  type Hover,
  type Position,
  type Range,
  MarkupKind,
} from "vscode-languageserver/node";
import { Lexer } from "../lexer/lexer.js";
import {
  TokenType,
  type Token,
  BANNED_KEYWORDS,
  BANNED_SYMBOLS,
} from "../lexer/tokens.js";
import { getDocItem, getHoverDocumentation } from "./docs.js";
import { spanToRange } from "./definition.js";
import { pipelineCompanionCandidates } from "../emitter/pipeline-catalog.js";
import { Parser } from "../parser/parser.js";
import { Emitter } from "../emitter/emitter.js";
import { TypeScriptCompilationContext } from "../compiler/typescript-context.js";
import { resolveImportedSchemas } from "../compiler/imported-schemas.js";
import { inferPipelineCompanions } from "../compiler/pipeline-companions.js";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { compileString } from "../compiler.js";
import ts from "typescript";

function symbolHover(source: string, uri: string, token: Token): Hover | null {
  if (token.type !== TokenType.IDENTIFIER && token.type !== TokenType.UPPER_IDENTIFIER) return null;
  try {
    const filename = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
    const context = new TypeScriptCompilationContext(filename);
    const result = Effect.runSync(compileString(source, filename, { context, sourcemap: false }));
    const checked = context.check(result.typescript);
    if (!checked) return null;
    const found = new Map<ts.Symbol, ts.Identifier>();
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === token.value) {
        const symbol = checked.checker.getSymbolAtLocation(node);
        if (symbol) found.set(symbol, node);
      }
      ts.forEachChild(node, visit);
    };
    visit(checked.sourceFile);
    // Without precise source mappings, never guess across shadowed symbols.
    if (found.size !== 1) return null;
    const [symbol, node] = [...found.entries()][0];
    const type = checked.checker.typeToString(
      checked.checker.getTypeOfSymbolAtLocation(symbol, node), node,
      ts.TypeFormatFlags.NoTruncation,
    );
    const documented = symbol.flags & ts.SymbolFlags.Alias ? checked.checker.getAliasedSymbol(symbol) : symbol;
    let docs = ts.displayPartsToString(documented.getDocumentationComment(checked.checker));
    // FunScript comments are not emitted into TypeScript; recover a doc block
    // only when this name has one unambiguous top-level declaration.
    const declarations = result.ast.body.flatMap((entry) => {
      const decl = entry.kind === "ExportDeclaration" ? entry.declaration : entry;
      return decl.kind === "BindingDeclaration" && decl.id.name === token.value ? [entry] : [];
    });
    if (declarations.length === 1) {
      const before = source.slice(0, declarations[0].span.start.offset);
      const comment = before.match(/(?:^|\n)((?:[ \t]*\/\/\/[^\n]*\n)+)[ \t]*$/);
      if (comment) docs = comment[1].split("\n").map((line) => line.replace(/^\s*\/\/\/ ?/, "")).join("\n").trim();
    }
    const tags = documented.getJsDocTags(checked.checker).map((tag) => `@${tag.name}${tag.text ? ` ${ts.displayPartsToString(tag.text)}` : ""}`).join("\n");
    const details = [docs, tags].filter(Boolean).join("\n\n");
    return { contents: { kind: MarkupKind.Markdown, value: `\`\`\`ts\n${token.value}: ${type}\n\`\`\`${details ? `\n\n${details}` : ""}` }, range: spanToRange(token.span) };
  } catch {
    return null;
  }
}

function importedSchemaHover(source: string, uri: string, position: Position): Hover | null {
  try {
    const program = new Parser(new Lexer(source, uri).tokenize(), uri, source).parse();
    const decls = program.body.flatMap((item) => {
      const decl = item.kind === "ExportDeclaration" ? item.declaration : item;
      return decl.kind === "SchemaDeclaration" && decl.body.kind === "ImportedTsSchema" ? [decl] : [];
    });
    const target = decls.find((decl) => {
      const p = decl.id.span.start;
      const e = decl.id.span.end;
      return position.line === p.line - 1 && position.character >= p.column - 1 && position.character <= e.column - 1;
    });
    if (!target) return null;

    const context = new TypeScriptCompilationContext(uri);
    const schemas = resolveImportedSchemas(program, source, context);
    const checked = context.check(new Emitter(program, undefined, { importedSchemas: schemas }).emit());
    if (!checked) return null;
    const typeName = target.body.kind === "ImportedTsSchema" && target.body.typeNode.kind === "TypeReferenceNode"
      ? target.body.typeNode.name.name
      : target.id.name;
    const alias = checked.sourceFile.statements.find((node): node is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(node) && node.name.text === typeName,
    );
    const importedType = alias ? checked.checker.getTypeFromTypeNode(alias.type) : undefined;
    const structure = importedType && importedType.getProperties().length > 0
      ? `{ ${importedType.getProperties().map((property) => `${property.name}${property.flags & ts.SymbolFlags.Optional ? "?" : ""}: ${checked.checker.typeToString(checked.checker.getTypeOfSymbolAtLocation(property, alias!), alias!, ts.TypeFormatFlags.NoTruncation)}`).join("; ")} }`
      : importedType
        ? checked.checker.typeToString(importedType, alias, ts.TypeFormatFlags.NoTruncation)
        : "unknown";
    const schema = schemas.get(target.id.name);
    return {
      contents: { kind: MarkupKind.Markdown, value: `**${target.id.name}**\n\nTypeScript type:\n\n\`\`\`ts\n${structure}\n\`\`\`\n\nEffect Schema:\n\n\`\`\`ts\n${schema ?? "Schema.Unknown"}\n\`\`\`` },
      range: spanToRange(target.id.span),
    };
  } catch {
    return null;
  }
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function findHoverInTokens(
  tokens: Token[],
  posLine: number,
  posCol: number,
  currentLine: string,
  lineIndex: number,
  source: string,
  uri: string,
): Hover | null {
  // Find token on posLine that strictly or best matches posCol
  const lineTokens: { token: Token; index: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.span.start.line === posLine) {
      lineTokens.push({ token: t, index: i });
    }
  }

  if (lineTokens.length === 0) {
    return null;
  }

  // 1. Check for token that strictly encompasses posCol
  let matchedIndex = -1;
  for (const { token, index } of lineTokens) {
    if (posCol >= token.span.start.column && posCol < token.span.end.column) {
      matchedIndex = index;
      break;
    }
  }

  // 2. If no strict match, check if cursor is at token end boundary
  if (matchedIndex === -1) {
    for (const { token, index } of lineTokens) {
      if (posCol === token.span.end.column) {
        matchedIndex = index;
        break;
      }
    }
  }

  if (matchedIndex === -1) {
    return null;
  }

  const token = tokens[matchedIndex];

  // Case A: token is a member after a dot (e.g. `succeed` in `Effect.succeed` or `scoped` in `Layer.scoped`)
  if (
    matchedIndex >= 2 &&
    tokens[matchedIndex - 1].type === TokenType.DOT &&
    (tokens[matchedIndex - 2].type === TokenType.UPPER_IDENTIFIER ||
      tokens[matchedIndex - 2].type === TokenType.IDENTIFIER)
  ) {
    const prefix = tokens[matchedIndex - 2].value;
    const qualified = `${prefix}.${token.value}`;
    const doc = getHoverDocumentation(qualified);
    if (doc) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: doc,
        },
        range: spanToRange({
          start: tokens[matchedIndex - 2].span.start,
          end: token.span.end,
        }),
      };
    }
  }

  // Case B: cursor is directly on the DOT between prefix and member (e.g. `.` in `Effect.succeed`)
  if (
    token.type === TokenType.DOT &&
    matchedIndex >= 1 &&
    matchedIndex + 1 < tokens.length &&
    (tokens[matchedIndex - 1].type === TokenType.UPPER_IDENTIFIER ||
      tokens[matchedIndex - 1].type === TokenType.IDENTIFIER) &&
    (tokens[matchedIndex + 1].type === TokenType.UPPER_IDENTIFIER ||
      tokens[matchedIndex + 1].type === TokenType.IDENTIFIER)
  ) {
    const qualified = `${tokens[matchedIndex - 1].value}.${tokens[matchedIndex + 1].value}`;
    const doc = getHoverDocumentation(qualified);
    if (doc) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: doc,
        },
        range: spanToRange({
          start: tokens[matchedIndex - 1].span.start,
          end: tokens[matchedIndex + 1].span.end,
        }),
      };
    }
  }

  // Case C: cursor is on prefix followed by DOT and member (e.g. `Effect` in `Effect.succeed`)
  if (
    matchedIndex + 2 < tokens.length &&
    tokens[matchedIndex + 1].type === TokenType.DOT &&
    (tokens[matchedIndex + 2].type === TokenType.UPPER_IDENTIFIER ||
      tokens[matchedIndex + 2].type === TokenType.IDENTIFIER)
  ) {
    // If the token itself has documentation (like `Effect` or `Layer`), prioritize the token's own doc
    const ownDoc = getHoverDocumentation(token.value);
    if (ownDoc) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: ownDoc,
        },
        range: spanToRange(token.span),
      };
    }

    const qualified = `${token.value}.${tokens[matchedIndex + 2].value}`;
    const doc = getHoverDocumentation(qualified);
    if (doc) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: doc,
        },
        range: spanToRange({
          start: token.span.start,
          end: tokens[matchedIndex + 2].span.end,
        }),
      };
    }
  }

  // Check banned keywords
  if (BANNED_KEYWORDS[token.value]) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**Disallowed in FunScript**: ${BANNED_KEYWORDS[token.value]}`,
      },
      range: spanToRange(token.span),
    };
  }

  // A bare stage can be legal only when the source proves its companion. Give
  // the user the exact explicit alternatives before they invoke the compiler.
  if (currentLine.slice(0, token.span.start.column - 1).includes("|>")) {
    const candidates = pipelineCompanionCandidates(token.value);
    if (candidates.length > 1) {
      try {
        const filename = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
        const ast = new Parser(tokens, filename, source).parse();
        const resolution = inferPipelineCompanions(ast, new TypeScriptCompilationContext(filename))
          .stageResolutions.get(token.span.start.offset);
        if (resolution) {
          return {
            contents: { kind: MarkupKind.Markdown, value: `Resolves to \`${resolution.module}.${resolution.method}\`.` },
            range: spanToRange(token.span),
          };
        }
      } catch {
        // Incomplete or ambiguous documents still get the candidate guidance.
      }
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**Potentially ambiguous pipeline stage** \`${token.value}\` is provided by ${candidates.map((module) => `\`${module}.${token.value}\``).join(", ")}. If the pipeline source cannot prove one module, write an explicit namespace.`,
        },
        range: spanToRange(token.span),
      };
    }
  }

  // Case D: Individual keyword, operator, primitive, or Effect function
  const doc = getHoverDocumentation(token.value);
  if (doc) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: doc,
      },
      range: spanToRange(token.span),
    };
  }

  return posCol < token.span.end.column ? symbolHover(source, uri, token) : null;
}

function findHoverInLineText(
  currentLine: string,
  lineIndex: number,
  charIndex: number,
): Hover | null {
  // 1. Check multi-character operators first (e.g. `???`, `|>`, `<-`, `=>`, and banned symbols)
  const bannedOps = Object.keys(BANNED_SYMBOLS);
  const operators = ["???", "|>", "<-", "=>", "<=", ">=", "<", ">", ...bannedOps];
  for (const op of operators) {
    let searchIdx = 0;
    while (searchIdx < currentLine.length) {
      const idx = currentLine.indexOf(op, searchIdx);
      if (idx === -1) break;
      const opEnd = idx + op.length;
      if (charIndex >= idx && charIndex <= opEnd) {
        if (BANNED_SYMBOLS[op]) {
          return {
            contents: {
              kind: MarkupKind.Markdown,
              value: `**Disallowed in FunScript**: ${BANNED_SYMBOLS[op]}`,
            },
            range: {
              start: { line: lineIndex, character: idx },
              end: { line: lineIndex, character: opEnd },
            },
          };
        }
        const doc = getHoverDocumentation(op);
        if (doc) {
          return {
            contents: {
              kind: MarkupKind.Markdown,
              value: doc,
            },
            range: {
              start: { line: lineIndex, character: idx },
              end: { line: lineIndex, character: opEnd },
            },
          };
        }
      }
      searchIdx = idx + 1;
    }
  }

  // 2. Check if cursor is on a dot between two words (e.g. `Effect.succeed`)
  if (charIndex < currentLine.length && currentLine[charIndex] === ".") {
    let prefixStart = charIndex;
    while (prefixStart > 0 && isWordChar(currentLine[prefixStart - 1])) {
      prefixStart--;
    }
    let suffixEnd = charIndex + 1;
    while (suffixEnd < currentLine.length && isWordChar(currentLine[suffixEnd])) {
      suffixEnd++;
    }
    const prefix = currentLine.slice(prefixStart, charIndex);
    const suffix = currentLine.slice(charIndex + 1, suffixEnd);
    if (prefix.length > 0 && suffix.length > 0) {
      const qualified = `${prefix}.${suffix}`;
      const doc = getHoverDocumentation(qualified);
      if (doc) {
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: doc,
          },
          range: {
            start: { line: lineIndex, character: prefixStart },
            end: { line: lineIndex, character: suffixEnd },
          },
        };
      }
    }
  }

  // 3. Find word boundaries at cursor
  let start = charIndex;
  while (start > 0 && isWordChar(currentLine[start - 1])) {
    start--;
  }
  let end = charIndex;
  while (end < currentLine.length && isWordChar(currentLine[end])) {
    end++;
  }

  // If charIndex was right after a word boundary
  if (start === end && charIndex > 0 && isWordChar(currentLine[charIndex - 1])) {
    end = charIndex;
    start = charIndex - 1;
    while (start > 0 && isWordChar(currentLine[start - 1])) {
      start--;
    }
  }

  if (start < end) {
    const word = currentLine.slice(start, end);

    // Check banned keywords
    if (BANNED_KEYWORDS[word]) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**Disallowed in FunScript**: ${BANNED_KEYWORDS[word]}`,
        },
        range: {
          start: { line: lineIndex, character: start },
          end: { line: lineIndex, character: end },
        },
      };
    }

    // Check if preceded by a dot: `Prefix.Word`
    if (start > 1 && currentLine[start - 1] === ".") {
      let prefixStart = start - 1;
      while (prefixStart > 0 && isWordChar(currentLine[prefixStart - 1])) {
        prefixStart--;
      }
      const prefix = currentLine.slice(prefixStart, start - 1);
      if (prefix.length > 0) {
        const qualified = `${prefix}.${word}`;
        const doc = getHoverDocumentation(qualified);
        if (doc) {
          return {
            contents: {
              kind: MarkupKind.Markdown,
              value: doc,
            },
            range: {
              start: { line: lineIndex, character: prefixStart },
              end: { line: lineIndex, character: end },
            },
          };
        }
      }
    }

    // Check if the word itself has hover docs
    const ownDoc = getHoverDocumentation(word);
    if (ownDoc) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: ownDoc,
        },
        range: {
          start: { line: lineIndex, character: start },
          end: { line: lineIndex, character: end },
        },
      };
    }

    // Check if followed by a dot: `Word.Suffix`
    if (end < currentLine.length && currentLine[end] === ".") {
      let suffixEnd = end + 1;
      while (suffixEnd < currentLine.length && isWordChar(currentLine[suffixEnd])) {
        suffixEnd++;
      }
      const suffix = currentLine.slice(end + 1, suffixEnd);
      if (suffix.length > 0) {
        const qualified = `${word}.${suffix}`;
        const doc = getHoverDocumentation(qualified);
        if (doc) {
          return {
            contents: {
              kind: MarkupKind.Markdown,
              value: doc,
            },
            range: {
              start: { line: lineIndex, character: start },
              end: { line: lineIndex, character: suffixEnd },
            },
          };
        }
      }
    }
  }

  return null;
}

export function findHover(
  source: string,
  uri: string,
  position: Position,
): Hover | null {
  if (!source || source.trim().length === 0) {
    return null;
  }

  const lines = source.split("\n");
  const lineIndex = position.line;
  const charIndex = position.character;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    return null;
  }

  const currentLine = lines[lineIndex];
  if (charIndex < 0 || charIndex > currentLine.length) {
    return null;
  }

  const posLine = lineIndex + 1;
  const posCol = charIndex + 1;

  // 1. Try token-based hover first if the file lexes cleanly
  let tokens: Token[] | null = null;
  try {
    const lexer = new Lexer(source, uri);
    tokens = lexer.tokenize();
  } catch {
    tokens = null;
  }

  if (tokens && tokens.length > 0) {
    const importedHover = importedSchemaHover(source, uri, position);
    if (importedHover) return importedHover;
    const hoverFromTokens = findHoverInTokens(
      tokens,
      posLine,
      posCol,
      currentLine,
      lineIndex,
      source,
      uri,
    );
    if (hoverFromTokens) {
      return hoverFromTokens;
    }
  }

  // 2. Fallback to line text-based inspection (e.g. if lexer threw or comments/unparsed code)
  return findHoverInLineText(currentLine, lineIndex, charIndex);
}
