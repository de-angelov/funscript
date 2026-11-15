import ts from "typescript";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TextDocumentItem, TextEdit, WorkspaceEdit } from "vscode-languageserver/node";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";

type Doc = Pick<TextDocumentItem, "uri" | "text">;
type Exported = { name: string; line: number; character: number };

/** Collect exported bindings; the FunScript rename has already resolved aliases. */
function exportsOf(doc: Doc): Exported[] | undefined {
  try {
    const ast = new Parser(new Lexer(doc.text, doc.uri).tokenize(), doc.uri, doc.text).parse();
    const result: Exported[] = [];
    const add = (id: { name: string; span: { start: { line: number; column: number } } }) =>
      result.push({ name: id.name, line: id.span.start.line - 1, character: id.span.start.column - 1 });
    for (const item of ast.body) {
      if (item.kind === "ExportDeclaration" && "id" in item.declaration && "name" in item.declaration.id) add(item.declaration.id);
      if (item.kind === "ExportFromDeclaration") for (const spec of item.specifiers) add(spec.local);
    }
    return result;
  } catch { return undefined; }
}

/** Resolve TypeScript references using declaration stubs, without writing generated files. */
export function renameInterop(fun: Doc[], interop: Doc[], edit: WorkspaceEdit, oldName: string, newName: string, roots: string[]): WorkspaceEdit | null {
  if (!interop.length) return edit;
  const texts = new Map<string, string>();
  const stubs = new Map<string, string>();
  const targets: Array<{ file: string; offset: number }> = [];
  const originalPaths = new Map<string, string>();
  for (const doc of fun) {
    let file: string;
    try { file = resolve(fileURLToPath(doc.uri)); } catch { continue; }
    const exported = exportsOf(doc);
    if (!exported) {
      if (doc.text.includes(oldName)) return null;
      continue;
    }
    const stub = file + ".d.ts";
    let content = "";
    const seen = new Set<string>();
    for (const symbol of exported) {
      if (seen.has(symbol.name)) return null;
      seen.add(symbol.name);
      const offset = content.length + "export declare const ".length;
      content += `export declare const ${symbol.name}: any;\nexport type ${symbol.name} = any;\n`;
      if (edit.changes?.[doc.uri]?.some(change => change.range.start.line === symbol.line && change.range.start.character === symbol.character)) targets.push({ file: stub, offset });
    }
    texts.set(stub, content);
    stubs.set(file, stub);
  }
  if (!targets.length) return edit;
  for (const doc of interop) {
    try { const file = resolve(fileURLToPath(doc.uri)); texts.set(file, doc.text); originalPaths.set(file, doc.uri); }
    catch { return null; }
  }
  const configPath = roots.length === 1 ? ts.findConfigFile(roots[0], ts.sys.fileExists) : undefined;
  const config = configPath ? ts.readConfigFile(configPath, ts.sys.readFile) : undefined;
  if (config?.error) return null;
  const parsed = configPath && config ? ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath)) : undefined;
  if (parsed?.errors.length) return null;
  const options: ts.CompilerOptions = { ...parsed?.options, allowJs: true, noEmit: true, allowArbitraryExtensions: true };
  const moduleHost: ts.ModuleResolutionHost = {
    fileExists: file => texts.has(resolve(file)) || ts.sys.fileExists(file),
    readFile: file => texts.get(resolve(file)) ?? ts.sys.readFile(file),
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    getCurrentDirectory: () => roots[0] ?? ts.sys.getCurrentDirectory(),
  };
  const resolveModule = (name: string, containingFile: string): ts.ResolvedModuleFull | undefined => {
    const normal = ts.resolveModuleName(name, containingFile, options, moduleHost).resolvedModule;
    if (normal) {
      const resolved = resolve(normal.resolvedFileName);
      for (const root of roots) {
        const view = resolve(root, ".funscript/types");
        const child = relative(view, resolved);
        if (child.startsWith("..") || !child) continue;
        const source = resolve(root, child.replace(/\.d\.(funx?)\.ts$/, ".$1").replace(/\.tsx$/, ".funx").replace(/\.ts$/, ".fun"));
        const stub = stubs.get(source);
        if (stub) return { resolvedFileName: stub, extension: ts.Extension.Dts };
      }
      return normal;
    }
    if (!name.startsWith(".")) return undefined;
    const base = resolve(dirname(containingFile), name);
    const stem = base.endsWith(".js") ? base.slice(0, -3) : base;
    const candidates = [base, ...[".fun", ".funx", ".funs"].map(ext => stem + ext), ...["index.fun", "index.funx", "index.funs"].map(file => resolve(base, file))];
    const matches = [...new Set(candidates)].filter(file => stubs.has(file));
    return matches.length === 1 ? { resolvedFileName: stubs.get(matches[0])!, extension: ts.Extension.Dts } : undefined;
  };
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...texts.keys()],
    getScriptVersion: () => "0",
    getScriptSnapshot: file => { const text = texts.get(resolve(file)) ?? ts.sys.readFile(file); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text); },
    getCurrentDirectory: () => roots[0] ?? ts.sys.getCurrentDirectory(),
    getDefaultLibFileName: opts => ts.getDefaultLibFilePath(opts),
    fileExists: moduleHost.fileExists,
    readFile: moduleHost.readFile,
    directoryExists: moduleHost.directoryExists,
    getDirectories: moduleHost.getDirectories,
    resolveModuleNames: (names, containingFile) => names.map(name => resolveModule(name, containingFile)),
  };
  const service = ts.createLanguageService(host);
  try {
    // An unresolved import or re-export could hide an affected symbol.
    for (const [file] of originalPaths) {
      const text = texts.get(file)!;
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length && text.includes(oldName)) return null;
      const namespaces = new Set<string>();
      for (const statement of source.statements) {
        if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamespaceImport(statement.importClause.namedBindings)) {
          namespaces.add(statement.importClause.namedBindings.name.text);
        }
        if (resolveModule(statement.moduleSpecifier.text, file)) continue;
        const clause = ts.isImportDeclaration(statement) ? statement.importClause : statement.exportClause;
        if (!clause) {
          if (ts.isExportDeclaration(statement)) return null;
          continue;
        }
        if (ts.isNamespaceExport(clause) || ts.isImportClause(clause) && clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) return null;
        if (clause.getText(source).includes(oldName)) return null;
      }
      let unsafe = false;
      const visit = (node: ts.Node): void => {
        if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && namespaces.has(node.expression.text) && node.argumentExpression && !ts.isStringLiteral(node.argumentExpression)) unsafe = true;
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal) && !resolveModule(node.argument.literal.text, file) && text.includes(oldName)) unsafe = true;
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
          const arg = node.arguments[0];
          if (arg && ts.isStringLiteral(arg)) {
            const target = resolveModule(arg.text, file);
            const resolved = target && resolve(target.resolvedFileName);
            if (resolved && [...stubs.values()].includes(resolved) || text.includes(oldName) && (!resolved || originalPaths.has(resolved))) unsafe = true;
          } else unsafe = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (unsafe) return null;
    }
    const additions: Record<string, TextEdit[]> = {};
    const used = new Set<string>();
    for (const target of targets) {
      const locations = service.findRenameLocations(target.file, target.offset, false, false, true);
      if (!locations) return null;
      for (const location of locations) {
        const file = resolve(location.fileName);
        const uri = originalPaths.get(file);
        if (!uri) {
          if ([...stubs.values()].includes(file)) continue;
          return null;
        }
        const content = texts.get(file)!;
        const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
        const start = source.getLineAndCharacterOfPosition(location.textSpan.start);
        const end = source.getLineAndCharacterOfPosition(location.textSpan.start + location.textSpan.length);
        const key = `${uri}:${location.textSpan.start}:${location.textSpan.length}`;
        if (used.has(key)) continue;
        used.add(key);
        (additions[uri] ??= []).push({ range: { start, end }, newText: `${location.prefixText ?? ""}${newName}${location.suffixText ?? ""}` });
      }
    }
    // Reject possible captures in affected files rather than silently changing bindings.
    if (oldName !== newName) for (const uri of Object.keys(additions)) {
      const file = resolve(fileURLToPath(uri));
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, texts.get(file)!);
      for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
        if (token === ts.SyntaxKind.Identifier && scanner.getTokenText() === newName) return null;
      }
    }
    return { ...edit, changes: { ...edit.changes, ...additions } };
  } finally { service.dispose(); }
}
