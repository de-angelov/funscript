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

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function findHoverInTokens(
  tokens: Token[],
  posLine: number,
  posCol: number,
  currentLine: string,
  lineIndex: number,
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

  return null;
}

function findHoverInLineText(
  currentLine: string,
  lineIndex: number,
  charIndex: number,
): Hover | null {
  // 1. Check multi-character operators first (e.g. `???`, `|>`, `<-`, `->`, and banned symbols)
  const bannedOps = Object.keys(BANNED_SYMBOLS);
  const operators = ["???", "|>", "<-", "->", ...bannedOps];
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
    const hoverFromTokens = findHoverInTokens(
      tokens,
      posLine,
      posCol,
      currentLine,
      lineIndex,
    );
    if (hoverFromTokens) {
      return hoverFromTokens;
    }
  }

  // 2. Fallback to line text-based inspection (e.g. if lexer threw or comments/unparsed code)
  return findHoverInLineText(currentLine, lineIndex, charIndex);
}
