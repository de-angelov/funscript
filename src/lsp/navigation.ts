import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve, extname } from "node:path";
import { findDefinition, spanToRange } from "./definition.js";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import type { TextDocumentItem, Location, LocationLink, DocumentSymbol, SymbolInformation, PrepareRenameResult, WorkspaceEdit, TextEdit } from "vscode-languageserver/node";

type Doc = Pick<TextDocumentItem, "uri" | "text">;
type Occurrence = { name: string; start: number; end: number; line: number; character: number };

function occurrences(source: string): Occurrence[] {
  const out: Occurrence[] = [];
  for (const match of source.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const start = match.index!;
    const before = source.slice(0, start);
    const line = (before.match(/\n/g) ?? []).length;
    const character = start - (before.lastIndexOf("\n") + 1);
    out.push({ name: match[0], start, end: start + match[0].length, line, character });
  }
  return out;
}

function parse(source: string, uri: string) {
  try { return new Parser(new Lexer(source, uri).tokenize(), uri).parse(); } catch { return null; }
}

function resolveImported(uri: string, name: string, docs: Doc[]): { doc: Doc; exportedName: string } | undefined {
  const current = docs.find((doc) => doc.uri === uri);
  if (!current) return undefined;
  const ast = parse(current.text, uri);
  for (const item of ast?.body ?? []) {
    if (item.kind !== "ImportDeclaration") continue;
    const spec = item.specifiers.find((s) => s.local.name === name);
    const modulePath = item.source.parts.map((part) => part.kind === "StringRawPart" ? part.value : "").join("");
    if (!spec || !modulePath.startsWith(".")) continue;
    let base: string;
    try { base = resolve(dirname(fileURLToPath(uri)), modulePath); } catch { continue; }
    const candidates = [base, ...[".fun", ".funs", ".funx", ".ts"].map((ext) => base + ext), ...["index.fun", "index.funs"].map((file) => resolve(base, file))];
    const target = docs.find((doc) => { try { return candidates.includes(fileURLToPath(doc.uri)); } catch { return false; } });
    if (target) {
      const exported = parse(target.text, target.uri)?.body.some((entry) => {
        const declaration = entry.kind === "ExportDeclaration" ? entry.declaration : undefined;
        return declaration && "id" in declaration && declaration.id.name === spec.imported.name;
      });
      if (exported) return { doc: target, exportedName: spec.imported.name };
    }
  }
  return undefined;
}

function identity(doc: Doc, occurrence: Occurrence, docs: Doc[]): string {
  const linked = resolveImported(doc.uri, occurrence.name, docs);
  if (linked) {
    const program = parse(linked.doc.text, linked.doc.uri);
    const exported = program?.body.find((entry) => entry.kind === "ExportDeclaration" && "id" in entry.declaration && entry.declaration.id.name === linked.exportedName);
    if (exported?.kind === "ExportDeclaration" && "id" in exported.declaration) {
      const span = spanToRange(exported.declaration.id.span).start;
      return `${linked.doc.uri}:${span.line}:${span.character}`;
    }
  }
  const ast = parse(doc.text, doc.uri);
  const declared = ast?.body.some((item) => {
    const declaration = item.kind === "ExportDeclaration" ? item.declaration : item;
    return "id" in declaration && declaration.id.name === occurrence.name && declaration.id.span.start.line - 1 === occurrence.line && declaration.id.span.start.column - 1 === occurrence.character;
  });
  if (declared) return `${doc.uri}:${occurrence.line}:${occurrence.character}`;
  const definition = findDefinition(doc.text, doc.uri, { line: occurrence.line, character: occurrence.character });
  if (definition && !Array.isArray(definition)) return `${definition.uri}:${definition.range.start.line}:${definition.range.start.character}`;
  return "";
}

export function references(source: string, uri: string, position: {line:number; character:number}, docs: Doc[], includeDeclaration: boolean): Location[] {
  const current = docs.find((d) => d.uri === uri) ?? { uri, text: source };
  const selected = occurrences(source).find((o) => o.line === position.line && position.character >= o.character && position.character <= o.character + o.name.length);
  if (!selected) return [];
  const key = identity(current, selected, docs);
  if (!key) return [];
  const results: Location[] = [];
  for (const doc of docs) for (const occ of occurrences(doc.text)) {
    if (occ.name !== selected.name || identity(doc, occ, docs) !== key) continue;
    if (!includeDeclaration && findDefinition(doc.text, doc.uri, {line:occ.line, character:occ.character}) && occ.name === selected.name) {
      const def = findDefinition(doc.text, doc.uri, {line:occ.line, character:occ.character});
      if (def && !Array.isArray(def) && def.uri === doc.uri && def.range.start.line === occ.line && def.range.start.character === occ.character) continue;
    }
    results.push({ uri: doc.uri, range: { start:{line:occ.line,character:occ.character}, end:{line:occ.line,character:occ.character+occ.name.length} } });
  }
  return results;
}

const reserved = new Set("as async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new return switch this throw try typeof var void while with yield schema service error match when effect mut fn type number string boolean null undefined".split(" "));
export function prepareRename(source: string, uri: string, position: {line:number; character:number}, docs: Doc[]): PrepareRenameResult | null {
  const occ = occurrences(source).find((o) => o.line === position.line && position.character >= o.character && position.character <= o.character + o.name.length);
  if (!occ || reserved.has(occ.name) || occ.name.startsWith("__") || occ.name.startsWith("$")) return null;
  if (!identity({ uri, text: source }, occ, docs)) return null;
  return { range: { start:{line:occ.line,character:occ.character}, end:{line:occ.line,character:occ.character+occ.name.length} }, placeholder: occ.name };
}

export function rename(source: string, uri: string, position: {line:number; character:number}, newName: string, docs: Doc[]): WorkspaceEdit | null {
  if (!/^[A-Za-z_$][\w$]*$/.test(newName) || reserved.has(newName) || newName.startsWith("$") || newName.startsWith("__")) return null;
  const prepared = prepareRename(source, uri, position, docs);
  if (!prepared) return null;
  if (!("placeholder" in prepared)) return null;
  const oldName = prepared.placeholder;
  const files = docs.filter((doc) => occurrences(doc.text).some((o) => o.name === oldName && identity(doc, o, docs) === identity({uri,text:source}, occurrences(source).find((o) => o.line === position.line && position.character >= o.character && position.character <= o.character+o.name.length)!, docs)));
  for (const doc of files) if (occurrences(doc.text).some((o) => o.name === newName && o.name !== oldName && /(?:^|\n)\s*(?:export\s+)?(?:schema\s+|service\s+|error\s+)?/.test(doc.text.slice(Math.max(0,o.start-16),o.start)))) return null;
  const changes: Record<string, TextEdit[]> = {};
  for (const doc of files) {
    const edits = references(source, uri, position, docs, true).filter((loc) => loc.uri === doc.uri).map((loc) => ({ range: loc.range, newText: newName }));
    if (edits.length) changes[doc.uri] = edits;
  }
  return Object.keys(changes).length ? { changes } : null;
}

export function documentSymbols(source: string, uri: string): DocumentSymbol[] {
  const ast = parse(source, uri);
  if (!ast) return [];
  const symbols: DocumentSymbol[] = [];
  for (const top of ast.body) {
    const decl = top.kind === "ExportDeclaration" ? top.declaration : top;
    if (!("id" in decl)) continue;
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
  const occ = occurrences(source).find((item) => item.line === position.line && position.character >= item.character && position.character <= item.character + item.name.length);
  if (!occ) return null;
  const imported = resolveImported(uri, occ.name, docs);
  if (!imported) return findDefinition(source, uri, position, linkSupport);
  const target = imported.doc;
  const targetAst = parse(target.text, target.uri);
  const declaration = targetAst?.body.find((entry) => {
    if (entry.kind !== "ExportDeclaration") return false;
    return "id" in entry.declaration && entry.declaration.id.name === imported.exportedName;
  });
  if (!declaration || declaration.kind !== "ExportDeclaration" || !("id" in declaration.declaration)) return null;
  const range = spanToRange(declaration.span);
  const selectionRange = spanToRange(declaration.declaration.id.span);
  if (linkSupport) return [{ originSelectionRange: { start: { line: occ.line, character: occ.character }, end: { line: occ.line, character: occ.character + occ.name.length } }, targetUri: target.uri, targetRange: range, targetSelectionRange: selectionRange }];
  return { uri: target.uri, range: selectionRange };
}
