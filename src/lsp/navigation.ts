import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DocumentSymbol,
  Location,
  LocationLink,
  PrepareRenameResult,
  SymbolInformation,
  TextDocumentItem,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver/node";
import type { Program } from "../ast/types.js";
import { isExpectedSyntaxError, isExpectedUriError } from "../errors.js";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { DefinitionFinder, findDefinition, spanToRange } from "./definition.js";
import {
  ParsedDocumentCache,
  type Occurrence,
  type ParsedDocument,
} from "./parsed-documents.js";

type Doc = Pick<TextDocumentItem, "uri" | "text">;
type AnalyzedDocument = ParsedDocument;

function parse(source: string, uri: string): Program | null {
  try {
    return new Parser(new Lexer(source, uri).tokenize(), uri, source).parse();
  } catch (error) {
    if (!isExpectedSyntaxError(error)) throw error;
    return null;
  }
}

/** A request-scoped snapshot: each open document is lexed and parsed at most once. */
class NavigationAnalysis {
  private readonly analyzed = new Map<string, AnalyzedDocument>();
  private readonly identities = new Map<string, string>();
  private readonly documents: Doc[];

  constructor(
    source: string,
    uri: string,
    docs: Doc[],
    private readonly cache = new ParsedDocumentCache(),
  ) {
    this.documents = [
      ...docs.filter((doc) => doc.uri !== uri),
      { uri, text: source },
    ];
  }

  document(doc: Doc): AnalyzedDocument {
    const existing = this.analyzed.get(doc.uri);
    if (existing) return existing;
    const analyzed = this.cache.get(doc);
    this.analyzed.set(doc.uri, analyzed);
    return analyzed;
  }

  selected(
    uri: string,
    position: { line: number; character: number },
  ): Occurrence | undefined {
    const doc = this.documents.find((item) => item.uri === uri);
    return (
      doc &&
      this.document(doc).occurrences.find(
        (occ) =>
          occ.line === position.line &&
          position.character >= occ.character &&
          position.character <= occ.character + occ.name.length,
      )
    );
  }

  private moduleDocument(
    doc: Doc,
    source: import("../ast/types.js").StringLiteral,
  ): Doc | undefined {
    const modulePath = source.parts
      .map((part) => (part.kind === "StringRawPart" ? part.value : ""))
      .join("");
    if (!modulePath.startsWith(".")) return undefined;
    if (!doc.uri.startsWith("file:")) return undefined;
    let base: string;
    try {
      base = resolve(dirname(fileURLToPath(doc.uri)), modulePath);
    } catch (error) {
      if (!isExpectedUriError(error)) throw error;
      return undefined;
    }
    const stem = base.endsWith(".js") ? base.slice(0, -3) : base;
    const candidates = new Set([
      base,
      ...[".fun", ".funs", ".funx", ".ts", ".tsx"].map((ext) => stem + ext),
      ...["index.fun", "index.funs", "index.funx"].map((file) =>
        resolve(base, file),
      ),
    ]);
    const matches = this.documents.filter((candidate) => {
      if (!candidate.uri.startsWith("file:")) return false;
      try {
        return candidates.has(fileURLToPath(candidate.uri));
      } catch (error) {
        if (!isExpectedUriError(error)) throw error;
        return false;
      }
    });
    return matches.length === 1 ? matches[0] : undefined;
  }

  private importedTarget(
    doc: Doc,
    identifierOffset: number,
  ): { doc: Doc; exportedName: string } | undefined {
    for (const item of this.document(doc).ast?.body ?? []) {
      if (
        item.kind !== "ImportDeclaration" &&
        item.kind !== "ExportFromDeclaration"
      )
        continue;
      const spec = item.specifiers.find(
        (part) =>
          part.local.span.start.offset === identifierOffset ||
          part.imported.span.start.offset === identifierOffset,
      );
      if (!spec) continue;
      const target = this.moduleDocument(doc, item.source);
      return target
        ? { doc: target, exportedName: spec.imported.name }
        : undefined;
    }
    return undefined;
  }

  /** Resolve named re-exports without guessing through missing, duplicate or cyclic paths. */
  resolveExport(
    doc: Doc,
    name: string,
    seen = new Set<string>(),
  ):
    | {
        doc: Doc;
        declaration: import("../ast/types.js").ExportDeclaration;
        surface: string;
      }
    | undefined {
    const key = `${doc.uri}:${name}`;
    if (seen.has(key)) return undefined;
    const next = new Set(seen).add(key);
    const candidates: Array<
      | {
          kind: "declaration";
          item: import("../ast/types.js").ExportDeclaration;
        }
      | {
          kind: "reexport";
          item: import("../ast/types.js").ExportFromDeclaration;
          spec: import("../ast/types.js").ImportSpecifier;
        }
    > = [];
    for (const item of this.document(doc).ast?.body ?? []) {
      if (
        item.kind === "ExportDeclaration" &&
        "id" in item.declaration &&
        "name" in item.declaration.id &&
        item.declaration.id.name === name
      )
        candidates.push({ kind: "declaration", item });
      if (item.kind === "ExportFromDeclaration")
        for (const spec of item.specifiers)
          if (spec.local.name === name)
            candidates.push({ kind: "reexport", item, spec });
    }
    if (candidates.length !== 1) return undefined;
    const candidate = candidates[0];
    if (candidate.kind === "declaration") {
      const id = candidate.item.declaration.id;
      if (!("name" in id)) return undefined;
      return {
        doc,
        declaration: candidate.item,
        surface: `${doc.uri}:${id.span.start.offset}`,
      };
    }
    const target = this.moduleDocument(doc, candidate.item.source);
    const resolved =
      target && this.resolveExport(target, candidate.spec.imported.name, next);
    if (!resolved) return undefined;
    const aliased = candidate.spec.local.name !== candidate.spec.imported.name;
    return {
      ...resolved,
      surface: aliased
        ? `${doc.uri}:${candidate.spec.local.span.start.offset}`
        : resolved.surface,
    };
  }

  /** Identity of a renameable binding, retaining each explicit alias boundary. */
  renameIdentity(doc: Doc, occurrence: Occurrence): string {
    const ast = this.document(doc).ast;
    if (!ast) return "";
    const match = new DefinitionFinder(
      occurrence.line + 1,
      occurrence.character + 1,
    ).find(ast);
    if (!match) return "";
    const targetOffset = match.targetIdentifierNode.span.start.offset;
    for (const item of ast.body) {
      if (
        item.kind !== "ImportDeclaration" &&
        item.kind !== "ExportFromDeclaration"
      )
        continue;
      for (const spec of item.specifiers) {
        const isImported = occurrence.start === spec.imported.span.start.offset;
        const isLocal =
          occurrence.start === spec.local.span.start.offset ||
          targetOffset === spec.local.span.start.offset;
        if (!isImported && !isLocal) continue;
        const target = this.moduleDocument(doc, item.source);
        const resolved =
          target && this.resolveExport(target, spec.imported.name);
        if (!resolved) return "";
        if (!isImported && spec.local.name !== spec.imported.name)
          return `${doc.uri}:${spec.local.span.start.offset}`;
        return resolved.surface;
      }
    }
    return `${doc.uri}:${targetOffset}`;
  }

  importedForOccurrence(
    doc: Doc,
    occurrence: Occurrence,
  ): { doc: Doc; exportedName: string } | undefined {
    const ast = this.document(doc).ast;
    if (!ast) return undefined;
    const match = new DefinitionFinder(
      occurrence.line + 1,
      occurrence.character + 1,
    ).find(ast);
    return match
      ? this.importedTarget(doc, match.targetIdentifierNode.span.start.offset)
      : undefined;
  }

  identity(doc: Doc, occurrence: Occurrence): string {
    const cacheKey = `${doc.uri}:${occurrence.start}`;
    const cached = this.identities.get(cacheKey);
    if (cached !== undefined) return cached;
    const ast = this.document(doc).ast;
    if (!ast) return "";
    const match = new DefinitionFinder(
      occurrence.line + 1,
      occurrence.character + 1,
    ).find(ast);
    if (!match) return "";
    const identifier = match.targetIdentifierNode.span.start;
    const linked = this.importedTarget(doc, identifier.offset);
    if (linked) {
      const exported = this.resolveExport(linked.doc, linked.exportedName);
      if (exported && "id" in exported.declaration.declaration) {
        const start = exported.declaration.declaration.id.span.start;
        const result = `${exported.doc.uri}:${start.line - 1}:${start.column - 1}`;
        this.identities.set(cacheKey, result);
        return result;
      }
    }
    const result = `${doc.uri}:${identifier.line - 1}:${identifier.column - 1}`;
    this.identities.set(cacheKey, result);
    return result;
  }

  references(
    uri: string,
    selected: Occurrence,
    includeDeclaration: boolean,
  ): Location[] {
    const current = this.documents.find((doc) => doc.uri === uri);
    if (!current) return [];
    const key = this.identity(current, selected);
    if (!key) return [];
    const results: Location[] = [];
    let declarationName: string | undefined;
    for (const doc of this.documents) {
      const declaration = this.document(doc).occurrences.find(
        (occ) => `${doc.uri}:${occ.line}:${occ.character}` === key,
      );
      if (declaration) {
        declarationName = declaration.name;
        break;
      }
    }
    for (const doc of this.documents) {
      const analysis = this.document(doc);
      const names = new Set([
        selected.name,
        ...(declarationName ? [declarationName] : []),
      ]);
      for (const item of analysis.ast?.body ?? []) {
        if (
          item.kind !== "ImportDeclaration" &&
          item.kind !== "ExportFromDeclaration"
        )
          continue;
        for (const spec of item.specifiers) {
          const occurrence = analysis.occurrences.find(
            (token) => token.start === spec.local.span.start.offset,
          );
          if (occurrence && this.identity(doc, occurrence) === key) {
            names.add(spec.local.name);
            names.add(spec.imported.name);
          }
        }
      }
      for (const occ of analysis.occurrences) {
        if (!names.has(occ.name) || this.identity(doc, occ) !== key) continue;
        if (
          !includeDeclaration &&
          `${doc.uri}:${occ.line}:${occ.character}` === key
        )
          continue;
        results.push({
          uri: doc.uri,
          range: {
            start: { line: occ.line, character: occ.character },
            end: { line: occ.line, character: occ.character + occ.name.length },
          },
        });
      }
    }
    return results;
  }
}

export function references(
  source: string,
  uri: string,
  position: { line: number; character: number },
  docs: Doc[],
  includeDeclaration: boolean,
): Location[] {
  const analysis = new NavigationAnalysis(source, uri, docs);
  const selected = analysis.selected(uri, position);
  return selected ? analysis.references(uri, selected, includeDeclaration) : [];
}

const reserved = new Set(
  "as async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new return switch this throw try typeof var void while with yield schema service error match when effect mut fn type number string boolean null undefined".split(
    " ",
  ),
);
export function prepareRename(
  source: string,
  uri: string,
  position: { line: number; character: number },
  docs: Doc[],
  cache?: ParsedDocumentCache,
): PrepareRenameResult | null {
  const analysis = new NavigationAnalysis(source, uri, docs, cache);
  const occ = analysis.selected(uri, position);
  if (
    !occ ||
    reserved.has(occ.name) ||
    occ.name.startsWith("__") ||
    occ.name.startsWith("$")
  )
    return null;
  if (!analysis.renameIdentity({ uri, text: source }, occ)) return null;
  return {
    range: {
      start: { line: occ.line, character: occ.character },
      end: { line: occ.line, character: occ.character + occ.name.length },
    },
    placeholder: occ.name,
  };
}

export function rename(
  source: string,
  uri: string,
  position: { line: number; character: number },
  newName: string,
  docs: Doc[],
  cache?: ParsedDocumentCache,
): WorkspaceEdit | null {
  if (
    !/^[A-Za-z_$][\w$]*$/.test(newName) ||
    reserved.has(newName) ||
    newName.startsWith("$") ||
    newName.startsWith("__")
  )
    return null;
  const analysis = new NavigationAnalysis(source, uri, docs, cache);
  const selected = analysis.selected(uri, position);
  if (
    !selected ||
    reserved.has(selected.name) ||
    selected.name.startsWith("__") ||
    selected.name.startsWith("$")
  )
    return null;
  const current = { uri, text: source };
  const key = analysis.renameIdentity(current, selected);
  if (!key) return null;
  const allDocs = [...docs.filter((doc) => doc.uri !== uri), current];
  const locations: Location[] = [];
  for (const doc of allDocs) {
    const analyzed = analysis.document(doc);
    for (const item of analyzed.ast?.body ?? []) {
      if (
        item.kind !== "ImportDeclaration" &&
        item.kind !== "ExportFromDeclaration"
      )
        continue;
      for (const spec of item.specifiers) {
        if (spec.imported.name !== selected.name) continue;
        const occurrence = analyzed.occurrences.find(
          (token) => token.start === spec.imported.span.start.offset,
        );
        if (occurrence && !analysis.renameIdentity(doc, occurrence))
          return null;
      }
    }
    for (const occurrence of analyzed.occurrences) {
      if (analysis.renameIdentity(doc, occurrence) !== key) continue;
      locations.push({
        uri: doc.uri,
        range: {
          start: { line: occurrence.line, character: occurrence.character },
          end: {
            line: occurrence.line,
            character: occurrence.character + occurrence.name.length,
          },
        },
      });
    }
  }
  if (!locations.length) return null;
  // Conservatively reject a name already used in any affected document; this
  // prevents captures even when the existing occurrence is in a nested scope.
  const files = allDocs.filter((doc) =>
    locations.some((location) => location.uri === doc.uri),
  );
  for (const doc of files) {
    if (
      newName !== selected.name &&
      analysis.document(doc).occurrences.some((occ) => occ.name === newName)
    )
      return null;
  }
  const changes: Record<string, TextEdit[]> = {};
  for (const loc of locations)
    (changes[loc.uri] ??= []).push({ range: loc.range, newText: newName });
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
    const kind =
      decl.kind === "SchemaDeclaration"
        ? 5
        : decl.kind === "ServiceDeclaration"
          ? 11
          : decl.kind === "ErrorDeclaration"
            ? 5
            : 12;
    symbols.push({
      name: id.name,
      kind,
      range: spanToRange(top.span),
      selectionRange: spanToRange(id.span),
    });
  }
  return symbols;
}

export function workspaceSymbols(
  docs: Doc[],
  query: string,
): SymbolInformation[] {
  const needle = query.toLowerCase();
  return docs.flatMap((doc) =>
    documentSymbols(doc.text, doc.uri)
      .filter((symbol) => symbol.name.toLowerCase().includes(needle))
      .map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        location: { uri: doc.uri, range: symbol.selectionRange },
        containerName: doc.uri.split(/[\\/]/).pop(),
      })),
  );
}

export function findWorkspaceDefinition(
  source: string,
  uri: string,
  position: { line: number; character: number },
  docs: Doc[],
  linkSupport = false,
): Location | LocationLink[] | null {
  const analysis = new NavigationAnalysis(source, uri, docs);
  const occ = analysis.selected(uri, position);
  if (!occ) return null;
  const imported = analysis.importedForOccurrence({ uri, text: source }, occ);
  if (!imported) return findDefinition(source, uri, position, linkSupport);
  const resolved = analysis.resolveExport(imported.doc, imported.exportedName);
  if (!resolved) return null;
  const target = resolved.doc;
  const declaration = resolved.declaration;
  const range = spanToRange(declaration.span);
  const selectionRange = spanToRange(declaration.declaration.id.span);
  if (linkSupport)
    return [
      {
        originSelectionRange: {
          start: { line: occ.line, character: occ.character },
          end: { line: occ.line, character: occ.character + occ.name.length },
        },
        targetUri: target.uri,
        targetRange: range,
        targetSelectionRange: selectionRange,
      },
    ];
  return { uri: target.uri, range: selectionRange };
}
