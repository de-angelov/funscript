import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DefinitionFinder, findDefinition, spanToRange } from "./definition.js";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { TokenType } from "../lexer/tokens.js";
import type { Program } from "../ast/types.js";
import type { TextDocumentItem, Location, LocationLink, DocumentSymbol, SymbolInformation, PrepareRenameResult, WorkspaceEdit, TextEdit } from "vscode-languageserver/node";

type Doc = Pick<TextDocumentItem, "uri" | "text">;
type Occurrence = { name: string; start: number; end: number; line: number; character: number };

type AnalyzedDocument = { doc: Doc; ast: Program | null; occurrences: Occurrence[] };

function parse(source: string, uri: string): Program | null {
  try { return new Parser(new Lexer(source, uri).tokenize(), uri, source).parse(); } catch { return null; }
}

/** A request-scoped snapshot: each open document is lexed and parsed at most once. */
class NavigationAnalysis {
  private readonly analyzed = new Map<string, AnalyzedDocument>();
  private readonly identities = new Map<string, string>();
  private readonly documents: Doc[];

  constructor(source: string, uri: string, docs: Doc[]) {
    this.documents = [...docs.filter((doc) => doc.uri !== uri), { uri, text: source }];
  }

  document(doc: Doc): AnalyzedDocument {
    const existing = this.analyzed.get(doc.uri);
    if (existing) return existing;
    let ast: Program | null = null;
    let occurrences: Occurrence[] = [];
    try {
      const tokens = new Lexer(doc.text, doc.uri).tokenize();
      occurrences = tokens.filter((token) => token.type === TokenType.IDENTIFIER || token.type === TokenType.UPPER_IDENTIFIER)
        .map((token) => ({ name: token.value, start: token.span.start.offset, end: token.span.end.offset, line: token.span.start.line - 1, character: token.span.start.column - 1 }));
      ast = new Parser(tokens, doc.uri, doc.text).parse();
    } catch { /* Invalid source cannot be resolved safely. */ }
    const analyzed = { doc, ast, occurrences };
    this.analyzed.set(doc.uri, analyzed);
    return analyzed;
  }

  selected(uri: string, position: { line: number; character: number }): Occurrence | undefined {
    const doc = this.documents.find((item) => item.uri === uri);
    return doc && this.document(doc).occurrences.find((occ) => occ.line === position.line && position.character >= occ.character && position.character <= occ.character + occ.name.length);
  }

  private importedTarget(doc: Doc, identifierOffset: number): { doc: Doc; exportedName: string } | undefined {
    const ast = this.document(doc).ast;
    for (const item of ast?.body ?? []) {
      if (item.kind !== "ImportDeclaration") continue;
      const spec = item.specifiers.find((specifier) => (specifier.local.span.start.offset === identifierOffset || specifier.imported.span.start.offset === identifierOffset));
      const modulePath = item.source.parts.map((part) => part.kind === "StringRawPart" ? part.value : "").join("");
      if (!spec || !modulePath.startsWith(".")) continue;
      let base: string;
      try { base = resolve(dirname(fileURLToPath(doc.uri)), modulePath); } catch { continue; }
      const candidates = [base, ...[".fun", ".funs", ".funx", ".ts"].map((ext) => base + ext), ...["index.fun", "index.funs"].map((file) => resolve(base, file))];
      const target = this.documents.find((candidate) => { try { return candidates.includes(fileURLToPath(candidate.uri)); } catch { return false; } });
      if (target) return { doc: target, exportedName: spec.imported.name };
    }
    return undefined;
  }

  importedForOccurrence(doc: Doc, occurrence: Occurrence): { doc: Doc; exportedName: string } | undefined {
    const ast = this.document(doc).ast;
    if (!ast) return undefined;
    const match = new DefinitionFinder(occurrence.line + 1, occurrence.character + 1).find(ast);
    return match ? this.importedTarget(doc, match.targetIdentifierNode.span.start.offset) : undefined;
  }

  identity(doc: Doc, occurrence: Occurrence): string {
    const cacheKey = `${doc.uri}:${occurrence.start}`;
    const cached = this.identities.get(cacheKey);
    if (cached !== undefined) return cached;
    const ast = this.document(doc).ast;
    if (!ast) return "";
    const match = new DefinitionFinder(occurrence.line + 1, occurrence.character + 1).find(ast);
    if (!match) return "";
    const identifier = match.targetIdentifierNode.span.start;
    const linked = this.importedTarget(doc, identifier.offset);
    if (linked) {
      const exported = this.document(linked.doc).ast?.body.find((entry) => entry.kind === "ExportDeclaration" && "id" in entry.declaration && "name" in entry.declaration.id && entry.declaration.id.name === linked.exportedName);
      if (exported?.kind === "ExportDeclaration" && "id" in exported.declaration) {
        const start = exported.declaration.id.span.start;
        const result = `${linked.doc.uri}:${start.line - 1}:${start.column - 1}`;
        this.identities.set(cacheKey, result);
        return result;
      }
    }
    const result = `${doc.uri}:${identifier.line - 1}:${identifier.column - 1}`;
    this.identities.set(cacheKey, result);
    return result;
  }

  isUnresolvedImport(doc: Doc, occurrence: Occurrence): boolean {
    const ast = this.document(doc).ast;
    if (!ast) return false;
    const match = new DefinitionFinder(occurrence.line + 1, occurrence.character + 1).find(ast);
    if (!match) return false;
    const identifier = match.targetIdentifierNode.span.start;
    const isImport = ast.body.some((item) => item.kind === "ImportDeclaration" && item.specifiers.some((spec) =>
      spec.local.span.start.offset === identifier.offset || spec.imported.span.start.offset === identifier.offset));
    return isImport && this.identity(doc, occurrence) === `${doc.uri}:${identifier.line - 1}:${identifier.column - 1}`;
  }

  /** Return the local binding offset when an occurrence resolves to an import alias. */
  localAlias(doc: Doc, occurrence: Occurrence): number | undefined {
    const ast = this.document(doc).ast;
    if (!ast) return undefined;
    const match = new DefinitionFinder(occurrence.line + 1, occurrence.character + 1).find(ast);
    if (!match) return undefined;
    const offset = match.targetIdentifierNode.span.start.offset;
    for (const item of ast.body) {
      if (item.kind !== "ImportDeclaration") continue;
      for (const spec of item.specifiers) {
        if (spec.imported.name !== spec.local.name && spec.local.span.start.offset === offset) return offset;
      }
    }
    return undefined;
  }

  references(uri: string, selected: Occurrence, includeDeclaration: boolean): Location[] {
    const current = this.documents.find((doc) => doc.uri === uri);
    if (!current) return [];
    const key = this.identity(current, selected);
    if (!key) return [];
    const results: Location[] = [];
    let declarationName: string | undefined;
    for (const doc of this.documents) {
      const declaration = this.document(doc).occurrences.find((occ) => `${doc.uri}:${occ.line}:${occ.character}` === key);
      if (declaration) { declarationName = declaration.name; break; }
    }
    for (const doc of this.documents) {
      const analysis = this.document(doc);
      const names = new Set([selected.name, ...(declarationName ? [declarationName] : [])]);
      for (const item of analysis.ast?.body ?? []) {
        if (item.kind !== "ImportDeclaration") continue;
        for (const spec of item.specifiers) {
          const occurrence = analysis.occurrences.find((token) => token.start === spec.local.span.start.offset);
          if (occurrence && this.identity(doc, occurrence) === key) {
            names.add(spec.local.name);
            names.add(spec.imported.name);
          }
        }
      }
      for (const occ of analysis.occurrences) {
        if (!names.has(occ.name) || this.identity(doc, occ) !== key) continue;
        if (!includeDeclaration && `${doc.uri}:${occ.line}:${occ.character}` === key) continue;
        results.push({ uri: doc.uri, range: { start: { line: occ.line, character: occ.character }, end: { line: occ.line, character: occ.character + occ.name.length } } });
      }
    }
    return results;
  }
}

export function references(source: string, uri: string, position: {line:number; character:number}, docs: Doc[], includeDeclaration: boolean): Location[] {
  const analysis = new NavigationAnalysis(source, uri, docs);
  const selected = analysis.selected(uri, position);
  return selected ? analysis.references(uri, selected, includeDeclaration) : [];
}

const reserved = new Set("as async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new return switch this throw try typeof var void while with yield schema service error match when effect mut fn type number string boolean null undefined".split(" "));
export function prepareRename(source: string, uri: string, position: {line:number; character:number}, docs: Doc[]): PrepareRenameResult | null {
  const analysis = new NavigationAnalysis(source, uri, docs);
  const occ = analysis.selected(uri, position);
  if (!occ || reserved.has(occ.name) || occ.name.startsWith("__") || occ.name.startsWith("$")) return null;
  if (!analysis.identity({ uri, text: source }, occ)) return null;
  return { range: { start:{line:occ.line,character:occ.character}, end:{line:occ.line,character:occ.character+occ.name.length} }, placeholder: occ.name };
}

export function rename(source: string, uri: string, position: {line:number; character:number}, newName: string, docs: Doc[]): WorkspaceEdit | null {
  if (!/^[A-Za-z_$][\w$]*$/.test(newName) || reserved.has(newName) || newName.startsWith("$") || newName.startsWith("__")) return null;
  const analysis = new NavigationAnalysis(source, uri, docs);
  const selected = analysis.selected(uri, position);
  if (!selected || reserved.has(selected.name) || selected.name.startsWith("__") || selected.name.startsWith("$")) return null;
  const current = { uri, text: source };
  const key = analysis.identity(current, selected);
  if (!key) return null;
  const selectedAlias = analysis.localAlias(current, selected);
  if (selectedAlias === undefined && analysis.isUnresolvedImport(current, selected)) return null;
  const allDocs = [...docs.filter((doc) => doc.uri !== uri), current];
  const locations = analysis.references(uri, selected, true).filter((location) => {
    const doc = allDocs.find((item) => item.uri === location.uri);
    const occurrence = doc && analysis.document(doc).occurrences.find((item) => item.line === location.range.start.line && item.character === location.range.start.character);
    if (!doc || !occurrence) return false;
    const alias = analysis.localAlias(doc, occurrence);
    return selectedAlias === undefined ? alias === undefined : doc.uri === uri && alias === selectedAlias;
  });
  if (!locations.length) return null;
  // Conservatively reject a name already used in any affected document; this
  // prevents captures even when the existing occurrence is in a nested scope.
  const files = allDocs.filter((doc) => locations.some((location) => location.uri === doc.uri));
  for (const doc of files) {
    if (newName !== selected.name && analysis.document(doc).occurrences.some((occ) => occ.name === newName)) return null;
  }
  const changes: Record<string, TextEdit[]> = {};
  for (const loc of locations) (changes[loc.uri] ??= []).push({ range: loc.range, newText: newName });
  return { changes };
}

export function documentSymbols(source: string, uri: string): DocumentSymbol[] {
  const ast = parse(source, uri);
  if (!ast) return [];
  const symbols: DocumentSymbol[] = [];
  for (const top of ast.body) {
    const decl = top.kind === "ExportDeclaration" ? top.declaration : top;
    if (!("id" in decl) || !("name" in decl.id)) continue;
    const id = decl.id;
    const kind = decl.kind === "SchemaDeclaration" ? 5 : decl.kind === "ServiceDeclaration" ? 11 : decl.kind === "ErrorDeclaration" ? 5 : 12;
    symbols.push({ name:id.name, kind, range:spanToRange(top.span), selectionRange:spanToRange(id.span) });
  }
  return symbols;
}

export function workspaceSymbols(docs: Doc[], query: string): SymbolInformation[] {
  const needle = query.toLowerCase();
  return docs.flatMap((doc) => documentSymbols(doc.text, doc.uri).filter((symbol) => symbol.name.toLowerCase().includes(needle)).map((symbol) => ({ name:symbol.name, kind:symbol.kind, location:{uri:doc.uri,range:symbol.selectionRange}, containerName:doc.uri.split(/[\\/]/).pop() })));
}

export function findWorkspaceDefinition(source: string, uri: string, position: { line: number; character: number }, docs: Doc[], linkSupport = false): Location | LocationLink[] | null {
  const analysis = new NavigationAnalysis(source, uri, docs);
  const occ = analysis.selected(uri, position);
  if (!occ) return null;
  const imported = analysis.importedForOccurrence({ uri, text: source }, occ);
  if (!imported) return findDefinition(source, uri, position, linkSupport);
  const target = imported.doc;
  const targetAst = analysis.document(target).ast;
  const declaration = targetAst?.body.find((entry) => {
    if (entry.kind !== "ExportDeclaration") return false;
    return "id" in entry.declaration && "name" in entry.declaration.id && entry.declaration.id.name === imported.exportedName;
  });
  if (!declaration || declaration.kind !== "ExportDeclaration" || !("id" in declaration.declaration)) return null;
  const range = spanToRange(declaration.span);
  const selectionRange = spanToRange(declaration.declaration.id.span);
  if (linkSupport) return [{ originSelectionRange: { start: { line: occ.line, character: occ.character }, end: { line: occ.line, character: occ.character + occ.name.length } }, targetUri: target.uri, targetRange: range, targetSelectionRange: selectionRange }];
  return { uri: target.uri, range: selectionRange };
}
