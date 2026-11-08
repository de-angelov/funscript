import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import ts from "typescript";
import { compileString } from "../compiler.js";
import { TypeScriptCompilationContext } from "../compiler/typescript-context.js";

export interface TypeViewOptions {
  /** Project-relative source directories or files. Defaults to ["app"]. */
  include?: string[];
  /** Project-relative generated directory. Defaults to ".funscript/types". */
  outDir?: string;
}


/** Resolve relative imports from their real source location before rootDirs overlays. */
export function rewriteRelativeImports(source: string, parsed: ts.SourceFile, originalFile: string, generatedFile: string): string {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    let specifier: ts.Expression | ts.TypeNode | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0];
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
    if (specifier && ts.isStringLiteral(specifier) && /^\.{1,2}\//.test(specifier.text)) {
      const target = path.resolve(path.dirname(originalFile), specifier.text);
      let relative = path.relative(path.dirname(generatedFile), target).split(path.sep).join("/");
      if (!relative.startsWith(".")) relative = `./${relative}`;
      edits.push({ start: specifier.getStart(parsed), end: specifier.end, text: JSON.stringify(relative) });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}

/** A disk-backed TS view for tools such as tsc that cannot access Vite's virtual modules. */
export class TypeView {
  private readonly root: string;
  private readonly outDir: string;
  private readonly inputs: string[];
  private readonly known = new Set<string>();
  private readonly manifest: string;
  private readonly context: TypeScriptCompilationContext;
  private readonly hashes = new Map<string, string>();

  constructor(root: string, options: TypeViewOptions = {}) {
    this.root = path.resolve(root);
    this.outDir = path.resolve(this.root, options.outDir ?? ".funscript/types");
    this.inputs = (options.include ?? ["app"]).map((input) => path.resolve(this.root, input));
    this.manifest = path.join(this.outDir, ".funscript-type-view.json");
    this.context = new TypeScriptCompilationContext(path.join(this.root, "__funscript_type_view__.fun"));
    for (const input of this.inputs) {
      if (!this.inside(this.root, input)) throw new Error(`FunScript type view input must be inside project root: ${input}`);
    }
    if (!this.inside(this.root, this.outDir) || this.outDir === this.root || this.inputs.some((input) => this.inside(input, this.outDir) || this.inside(this.outDir, input))) {
      throw new Error("FunScript type view output must be a separate directory inside the project root");
    }
  }

  private inside(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  }

  private async collect(entry: string): Promise<string[]> {
    let stat;
    try { stat = await fs.lstat(entry); } catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
    if (stat.isSymbolicLink()) return [];
    if (stat.isFile()) return /\.funx?$/.test(entry) ? [entry] : [];
    if (!stat.isDirectory()) return [];
    const entries = await fs.readdir(entry, { withFileTypes: true });
    const nested = entries.filter((item) => !item.name.startsWith(".") && item.name !== "node_modules").map((item) => this.collect(path.join(entry, item.name)));
    return (await Promise.all(nested)).flat();
  }

  private paths(file: string): { compiled: string; shim: string } {
    const rel = path.relative(this.root, file);
    const isFunx = rel.endsWith(".funx");
    const stem = rel.replace(/\.funx?$/, "");
    return { compiled: path.join(this.outDir, `${stem}${isFunx ? ".tsx" : ".ts"}`), shim: path.join(this.outDir, `${stem}.d.${isFunx ? "funx" : "fun"}.ts`) };
  }

  async update(file: string): Promise<void> {
    file = path.resolve(file);
    if (!/\.funx?$/.test(file) || !this.inputs.some((input) => this.inside(input, file))) return;
    const other = file.endsWith(".funx") ? file.slice(0, -5) + ".fun" : file.slice(0, -4) + ".funx";
    if (this.inputs.some((input) => this.inside(input, other))) {
      const exists = await fs.stat(other).then((stat) => stat.isFile(), (error: any) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      if (exists) throw new Error(`FunScript type view cannot represent both ${file} and ${other}; rename one of them`);
    }
    const source = await fs.readFile(file, "utf8");
    const { compiled, shim } = this.paths(file);
    const relative = path.relative(this.root, file);
    const hash = createHash("sha256").update(source).digest("hex");
    if (this.hashes.get(relative) === hash && await Promise.all([compiled, shim].map((output) => fs.stat(output).then(() => true, () => false))).then((exists) => exists.every(Boolean))) {
      this.known.add(file);
      return;
    }
    const output = await Effect.runPromise(compileString(source, file, { sourcemap: true, context: this.context }));
    const basename = path.basename(file).replace(/\.funx?$/, "");
    const parsed = ts.createSourceFile(compiled, output.typescript, ts.ScriptTarget.Latest, true, compiled.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const hasDefault = parsed.statements.some((statement) =>
      (ts.isExportAssignment(statement) && !statement.isExportEquals) ||
      (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) ||
      (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.some((element) => element.name.text === "default"))
    );
    const shimText = `export * from ${JSON.stringify(`./${basename}.js`)};\n${hasDefault ? `export { default } from ${JSON.stringify(`./${basename}.js`)};\n` : ""}`;
    await fs.mkdir(path.dirname(compiled), { recursive: true });
    await fs.writeFile(compiled, rewriteRelativeImports(output.typescript, parsed, file, compiled));
    await fs.writeFile(shim, shimText);
    this.known.add(file);
    this.hashes.set(relative, hash);
  }

  async remove(file: string): Promise<void> {
    file = path.resolve(file);
    if (!this.known.has(file)) return;
    const { compiled, shim } = this.paths(file);
    await Promise.all([fs.rm(compiled, { force: true }), fs.rm(shim, { force: true })]);
    this.known.delete(file);
    this.hashes.delete(path.relative(this.root, file));
  }

  private async writeManifest(): Promise<void> {
    await fs.mkdir(this.outDir, { recursive: true });
    await fs.writeFile(this.manifest, JSON.stringify(Object.fromEntries([...this.known].map((file) => [path.relative(this.root, file), this.hashes.get(path.relative(this.root, file))]).sort(([a], [b]) => String(a).localeCompare(String(b)))), null, 2) + "\n");
  }

  async generate(): Promise<void> {
    try {
      const saved: unknown = JSON.parse(await fs.readFile(this.manifest, "utf8"));
      const entries: Array<[string, string | undefined]> = Array.isArray(saved)
        ? saved.map((item) => [item, undefined])
        : saved && typeof saved === "object" ? Object.entries(saved as Record<string, unknown>).map(([file, hash]) => [file, typeof hash === "string" ? hash : undefined]) : [];
      if (!entries.every(([item]) => typeof item === "string")) throw new Error("invalid file list");
      for (const [item, hash] of entries) {
        const file = path.resolve(this.root, item);
        if (!this.inside(this.root, file) || !/\.funx?$/.test(file)) throw new Error("invalid file path");
        this.known.add(file);
        if (hash) this.hashes.set(item, hash);
      }
    } catch (error: any) {
      if (error.code !== "ENOENT") throw new Error(`Cannot read FunScript type view manifest: ${error.message}`);
    }
    const files = [...new Set((await Promise.all(this.inputs.map((input) => this.collect(input)))).flat())].sort();
    for (const file of files) await this.update(file);
    for (const file of this.known) if (!files.includes(file)) await this.remove(file);
    await this.writeManifest();
  }

  async refresh(file: string): Promise<void> {
    try {
      await this.update(file);
    } catch (error) {
      // Do not let consumers silently use a stale successful compilation.
      await this.remove(file);
      await this.writeManifest();
      throw error;
    }
    await this.writeManifest();
  }

  async forget(file: string): Promise<void> {
    await this.remove(file);
    await this.writeManifest();
  }
}
