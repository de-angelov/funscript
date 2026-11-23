import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { TokenType } from "../lexer/tokens.js";
import type { Program } from "../ast/types.js";

export type NavigationDocument = { uri: string; text: string };
export type Occurrence = {
  name: string;
  start: number;
  end: number;
  line: number;
  character: number;
};
export type ParsedDocument = {
  doc: NavigationDocument;
  ast: Program | null;
  occurrences: Occurrence[];
};

/** Reuse parsing only when the full source text is identical. */
export class ParsedDocumentCache {
  private readonly entries = new Map<string, ParsedDocument>();

  get(doc: NavigationDocument): ParsedDocument {
    const existing = this.entries.get(doc.uri);
    if (existing?.doc.text === doc.text) return existing;
    let ast: Program | null = null;
    let occurrences: Occurrence[] = [];
    try {
      const tokens = new Lexer(doc.text, doc.uri).tokenize();
      occurrences = tokens
        .filter(
          (token) =>
            token.type === TokenType.IDENTIFIER ||
            token.type === TokenType.UPPER_IDENTIFIER,
        )
        .map((token) => ({
          name: token.value,
          start: token.span.start.offset,
          end: token.span.end.offset,
          line: token.span.start.line - 1,
          character: token.span.start.column - 1,
        }));
      ast = new Parser(tokens, doc.uri, doc.text).parse();
    } catch {
      /* Invalid documents are cached as invalid until their contents change. */
    }
    const parsed = { doc: { uri: doc.uri, text: doc.text }, ast, occurrences };
    this.entries.set(doc.uri, parsed);
    return parsed;
  }

  retain(docs: NavigationDocument[]): void {
    const keep = new Set(docs.map((doc) => doc.uri));
    for (const uri of this.entries.keys())
      if (!keep.has(uri)) this.entries.delete(uri);
  }

  clear(): void {
    this.entries.clear();
  }
}
