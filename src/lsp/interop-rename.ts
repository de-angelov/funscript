import { createHash } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type {
  TextDocumentItem,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver/node";
import { isExpectedSyntaxError, isExpectedUriError } from "../errors.js";
import { type ParsedDocumentCache } from "./parsed-documents.js";

type Doc = Pick<TextDocumentItem, "uri" | "text">;
type Exported = { name: string; line: number; character: number };

type ServiceState = {
  texts: Map<string, string>;
  options: ts.CompilerOptions;
  moduleHost: ts.ModuleResolutionHost;
  resolveModule: (
    name: string,
    containingFile: string,
  ) => ts.ResolvedModuleFull | undefined;
  currentDirectory: string;
};

/** Reuse TypeScript's parsed files, while taking a fresh, content-versioned view per request. */
export class InteropRenameSession {
  private state?: ServiceState;
  private projectVersion = 0;
  private snapshots = new Map<string, string | undefined>();
  private versions = new Map<string, string>();
  private service?: ts.LanguageService;

  private get current(): ServiceState {
    return this.state!;
  }

  update(state: ServiceState): ts.LanguageService {
    this.state = state;
    this.projectVersion++;
    this.snapshots.clear();
    this.versions.clear();
    if (!this.service) {
      const read = (file: string): string | undefined => {
        file = resolve(file);
        if (!this.snapshots.has(file))
          this.snapshots.set(
            file,
            this.current.texts.get(file) ?? ts.sys.readFile(file),
          );
        return this.snapshots.get(file);
      };
      const host: ts.LanguageServiceHost & {
        hasInvalidatedResolutions: () => boolean;
      } = {
        getCompilationSettings: () => this.current.options,
        getScriptFileNames: () => [...this.current.texts.keys()],
        getScriptVersion: (file) => {
          file = resolve(file);
          if (!this.versions.has(file))
            this.versions.set(
              file,
              createHash("sha256")
                .update(read(file) ?? "")
                .digest("hex"),
            );
          return this.versions.get(file)!;
        },
        getScriptSnapshot: (file) => {
          const text = read(file);
          return text === undefined
            ? undefined
            : ts.ScriptSnapshot.fromString(text);
        },
        getProjectVersion: () => String(this.projectVersion),
        // A new file, removed file, changed tsconfig, or package update can alter resolution.
        hasInvalidatedResolutions: () => true,
        getCurrentDirectory: () => this.current.currentDirectory,
        getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
        fileExists: (file) => this.current.moduleHost.fileExists(file),
        readFile: (file) => this.current.moduleHost.readFile?.(file),
        directoryExists: (directory) =>
          this.current.moduleHost.directoryExists?.(directory) ?? true,
        getDirectories: (directory) =>
          this.current.moduleHost.getDirectories?.(directory) ?? [],
        resolveModuleNames: (names, containingFile) =>
          names.map((name) => this.current.resolveModule(name, containingFile)),
      };
      this.service = ts.createLanguageService(host);
    }
    return this.service;
  }

  dispose(): void {
    this.service?.dispose();
    this.service = undefined;
    this.state = undefined;
    this.snapshots.clear();
    this.versions.clear();
  }
}

/** Collect exported bindings; the FunScript rename has already resolved aliases. */
function exportsOf(
  doc: Doc,
  cache: ParsedDocumentCache,
): Exported[] | undefined {
  try {
    const ast = cache.get(doc).ast;
    if (!ast) return undefined;
    const result: Exported[] = [];
    const add = (id: {
      name: string;
      span: { start: { line: number; column: number } };
    }) =>
      result.push({
        name: id.name,
        line: id.span.start.line - 1,
        character: id.span.start.column - 1,
      });
    for (const item of ast.body) {
      if (
        item.kind === "ExportDeclaration" &&
        "id" in item.declaration &&
        "name" in item.declaration.id
      )
        add(item.declaration.id);
      if (item.kind === "ExportFromDeclaration")
        for (const spec of item.specifiers) add(spec.local);
    }
    return result;
  } catch (error) {
    if (!isExpectedSyntaxError(error)) throw error;
    return undefined;
  }
}

/** Resolve TypeScript references using declaration stubs, without writing generated files. */
export function renameInterop(
  fun: Doc[],
  interop: Doc[],
  edit: WorkspaceEdit,
  oldName: string,
  newName: string,
  roots: string[],
  session: InteropRenameSession,
  cache: ParsedDocumentCache,
): WorkspaceEdit | null {
  if (!interop.length) return edit;
  const texts = new Map<string, string>();
  const stubs = new Map<string, string>();
  const targets: Array<{ file: string; offset: number }> = [];
  const originalPaths = new Map<string, string>();
  for (const doc of fun) {
    if (!doc.uri.startsWith("file:")) continue;
    let file: string;
    try {
      file = resolve(fileURLToPath(doc.uri));
    } catch (error) {
      if (!isExpectedUriError(error)) throw error;
      continue;
    }
    const exported = exportsOf(doc, cache);
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
      if (
        edit.changes?.[doc.uri]?.some(
          (change) =>
            change.range.start.line === symbol.line &&
            change.range.start.character === symbol.character,
        )
      )
        targets.push({ file: stub, offset });
    }
    texts.set(stub, content);
    stubs.set(file, stub);
  }
  if (!targets.length) return edit;
  for (const doc of interop) {
    try {
      const file = resolve(fileURLToPath(doc.uri));
      texts.set(file, doc.text);
      originalPaths.set(file, doc.uri);
    } catch (error) {
      if (!isExpectedUriError(error)) throw error;
      return null;
    }
  }
  const configPath =
    roots.length === 1
      ? ts.findConfigFile(roots[0], ts.sys.fileExists)
      : undefined;
  const config = configPath
    ? ts.readConfigFile(configPath, ts.sys.readFile)
    : undefined;
  if (config?.error) return null;
  const parsed =
    configPath && config
      ? ts.parseJsonConfigFileContent(
          config.config,
          ts.sys,
          dirname(configPath),
        )
      : undefined;
  if (parsed?.errors.length) return null;
  const options: ts.CompilerOptions = {
    ...parsed?.options,
    allowJs: true,
    noEmit: true,
    allowArbitraryExtensions: true,
  };
  const moduleHost: ts.ModuleResolutionHost = {
    fileExists: (file) => texts.has(resolve(file)) || ts.sys.fileExists(file),
    readFile: (file) => texts.get(resolve(file)) ?? ts.sys.readFile(file),
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    getCurrentDirectory: () => roots[0] ?? ts.sys.getCurrentDirectory(),
  };
  const moduleCache = ts.createModuleResolutionCache(
    roots[0] ?? ts.sys.getCurrentDirectory(),
    (file) => (ts.sys.useCaseSensitiveFileNames ? file : file.toLowerCase()),
    options,
  );
  const resolvedModules = new Map<string, ts.ResolvedModuleFull | undefined>();
  const resolveModuleUncached = (
    name: string,
    containingFile: string,
  ): ts.ResolvedModuleFull | undefined => {
    const normal = ts.resolveModuleName(
      name,
      containingFile,
      options,
      moduleHost,
      moduleCache,
    ).resolvedModule;
    if (normal) {
      const resolved = resolve(normal.resolvedFileName);
      for (const root of roots) {
        const view = resolve(root, ".funscript/types");
        const child = relative(view, resolved);
        if (child.startsWith("..") || !child) continue;
        const source = resolve(
          root,
          child
            .replace(/\.d\.(funx?)\.ts$/, ".$1")
            .replace(/\.tsx$/, ".funx")
            .replace(/\.ts$/, ".fun"),
        );
        const stub = stubs.get(source);
        if (stub)
          return { resolvedFileName: stub, extension: ts.Extension.Dts };
      }
      return normal;
    }
    if (!name.startsWith(".")) return undefined;
    const base = resolve(dirname(containingFile), name);
    const stem = base.endsWith(".js") ? base.slice(0, -3) : base;
    const candidates = [
      base,
      ...[".fun", ".funx", ".funs"].map((ext) => stem + ext),
      ...["index.fun", "index.funx", "index.funs"].map((file) =>
        resolve(base, file),
      ),
    ];
    const matches = [...new Set(candidates)].filter((file) => stubs.has(file));
    return matches.length === 1
      ? {
          resolvedFileName: stubs.get(matches[0])!,
          extension: ts.Extension.Dts,
        }
      : undefined;
  };
  const resolveModule = (
    name: string,
    containingFile: string,
  ): ts.ResolvedModuleFull | undefined => {
    const key = `${containingFile}\0${name}`;
    if (!resolvedModules.has(key))
      resolvedModules.set(key, resolveModuleUncached(name, containingFile));
    return resolvedModules.get(key);
  };
  const service = session.update({
    texts,
    options,
    moduleHost,
    resolveModule,
    currentDirectory: roots[0] ?? ts.sys.getCurrentDirectory(),
  });
  // An unresolved import or re-export could hide an affected symbol.
  for (const [file] of originalPaths) {
    const text = texts.get(file)!;
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    if (
      (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
        .parseDiagnostics.length &&
      text.includes(oldName)
    )
      return null;
    const namespaces = new Set<string>();
    for (const statement of source.statements) {
      if (
        (!ts.isImportDeclaration(statement) &&
          !ts.isExportDeclaration(statement)) ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      if (
        ts.isImportDeclaration(statement) &&
        statement.importClause?.namedBindings &&
        ts.isNamespaceImport(statement.importClause.namedBindings)
      ) {
        namespaces.add(statement.importClause.namedBindings.name.text);
      }
      if (resolveModule(statement.moduleSpecifier.text, file)) continue;
      const clause = ts.isImportDeclaration(statement)
        ? statement.importClause
        : statement.exportClause;
      if (!clause) {
        if (ts.isExportDeclaration(statement)) return null;
        continue;
      }
      if (
        ts.isNamespaceExport(clause) ||
        (ts.isImportClause(clause) &&
          clause.namedBindings &&
          ts.isNamespaceImport(clause.namedBindings))
      )
        return null;
      if (clause.getText(source).includes(oldName)) return null;
    }
    let unsafe = false;
    const visit = (node: ts.Node): void => {
      if (
        ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        namespaces.has(node.expression.text) &&
        node.argumentExpression &&
        !ts.isStringLiteral(node.argumentExpression)
      )
        unsafe = true;
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal) &&
        !resolveModule(node.argument.literal.text, file) &&
        text.includes(oldName)
      )
        unsafe = true;
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          const target = resolveModule(arg.text, file);
          const resolved = target && resolve(target.resolvedFileName);
          if (
            (resolved && [...stubs.values()].includes(resolved)) ||
            (text.includes(oldName) &&
              (!resolved || originalPaths.has(resolved)))
          )
            unsafe = true;
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
    const locations = service.findRenameLocations(
      target.file,
      target.offset,
      false,
      false,
      true,
    );
    if (!locations) return null;
    for (const location of locations) {
      const file = resolve(location.fileName);
      const uri = originalPaths.get(file);
      if (!uri) {
        if ([...stubs.values()].includes(file)) continue;
        return null;
      }
      const content = texts.get(file)!;
      const source = ts.createSourceFile(
        file,
        content,
        ts.ScriptTarget.Latest,
        true,
      );
      const start = source.getLineAndCharacterOfPosition(
        location.textSpan.start,
      );
      const end = source.getLineAndCharacterOfPosition(
        location.textSpan.start + location.textSpan.length,
      );
      const key = `${uri}:${location.textSpan.start}:${location.textSpan.length}`;
      if (used.has(key)) continue;
      used.add(key);
      (additions[uri] ??= []).push({
        range: { start, end },
        newText: `${location.prefixText ?? ""}${newName}${location.suffixText ?? ""}`,
      });
    }
  }
  // Reject possible captures in affected files rather than silently changing bindings.
  if (oldName !== newName)
    for (const uri of Object.keys(additions)) {
      const file = resolve(fileURLToPath(uri));
      const scanner = ts.createScanner(
        ts.ScriptTarget.Latest,
        true,
        ts.LanguageVariant.Standard,
        texts.get(file),
      );
      for (
        let token = scanner.scan();
        token !== ts.SyntaxKind.EndOfFileToken;
        token = scanner.scan()
      ) {
        if (
          token === ts.SyntaxKind.Identifier &&
          scanner.getTokenText() === newName
        )
          return null;
      }
    }
  return { ...edit, changes: { ...edit.changes, ...additions } };
}
