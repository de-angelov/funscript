import * as fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// Declaration files are immutable for the lifetime of a process in the common
// case. Share parsed ASTs between compilation contexts, while checking file
// metadata so edits to node_modules are still picked up.
const declarationFiles = new Map<
  string,
  { stamp: string; sourceFile: ts.SourceFile }
>();

export const TS_RESET_DECLARATION =
  '/// <reference types="@total-typescript/ts-reset" />\n' +
  "interface JSON { parse(text: string, reviver?: (this: any, key: string, value: any) => any): unknown; }\n" +
  "interface Body { json(): Promise<unknown>; }\n";

export const JSX_INTRINSICS_DECLARATION =
  "declare namespace JSX { interface IntrinsicElements { [element: string]: any } }";

export const TYPE_FEST_DECLARATION =
  "type Simplify<T> = { [KeyType in keyof T]: T[KeyType] } & {};\n" +
  "type Prettify<T> = Simplify<T>;\n" +
  "type Except<ObjectType, KeysType extends keyof ObjectType, Options = {}> = Simplify<{\n" +
  "  [KeyType in keyof ObjectType as KeyType extends KeysType ? never : KeyType]: ObjectType[KeyType];\n" +
  "}>;\n" +
  "type SetOptional<BaseType, Keys extends keyof BaseType = keyof BaseType> = Simplify<\n" +
  "  Except<BaseType, Keys> & Partial<Pick<BaseType, Keys>>\n" +
  ">;\n" +
  "declare const _tag: unique symbol;\n" +
  "type TagContainer<Token> = { readonly [_tag]: Token };\n" +
  "type Tag<Token extends PropertyKey, TagMetadata> = TagContainer<{ [K in Token]: TagMetadata }>;\n" +
  "type Tagged<Type, TagName extends PropertyKey, TagMetadata = never> = Type & Tag<TagName, TagMetadata>;\n" +
  "type UnwrapTagged<T> = T extends Tagged<infer Underlying, any, any> ? Underlying : T;\n";

/** Reuses the host, library files and previous program throughout one compilation. */
export class TypeScriptCompilationContext {
  private readonly options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    jsx: ts.JsxEmit.Preserve,
  };
  private virtualFile: string;
  private normalized: string;
  private readonly resetFile: string;
  private readonly normalizedReset: string;
  private readonly typeFestFile: string;
  private readonly normalizedTypeFest: string;
  private readonly jsxFile: string;
  private readonly normalizedJsx: string;
  private isJsx = false;
  private readonly host: ts.CompilerHost;
  private source = "";
  private auxiliarySources = new Map<string, string>();
  private program?: ts.Program;

  constructor(filename: string) {
    this.virtualFile = "";
    this.normalized = "";
    this.setFilename(filename);
    const cwd = process.cwd();
    this.resetFile = path.resolve(cwd, "__funscript_ts_reset__.d.ts");
    this.normalizedReset = ts.sys.resolvePath(this.resetFile);
    this.typeFestFile = path.resolve(cwd, "__funscript_type_fest__.d.ts");
    this.normalizedTypeFest = ts.sys.resolvePath(this.typeFestFile);
    this.jsxFile = path.resolve(cwd, "__funscript_jsx_intrinsics__.d.ts");
    this.normalizedJsx = ts.sys.resolvePath(this.jsxFile);

    const resolveVirtualContent = (name: string): string | undefined => {
      const norm = ts.sys.resolvePath(name);
      if (norm === this.normalized || name === this.virtualFile)
        return this.source;
      if (this.auxiliarySources.has(norm))
        return this.auxiliarySources.get(norm);
      if (
        norm === this.normalizedReset ||
        name === this.resetFile ||
        path.basename(name) === "__funscript_ts_reset__.d.ts"
      )
        return TS_RESET_DECLARATION;
      if (
        norm === this.normalizedTypeFest ||
        name === this.typeFestFile ||
        path.basename(name) === "__funscript_type_fest__.d.ts"
      )
        return TYPE_FEST_DECLARATION;
      if (
        norm === this.normalizedJsx ||
        name === this.jsxFile ||
        path.basename(name) === "__funscript_jsx_intrinsics__.d.ts"
      )
        return JSX_INTRINSICS_DECLARATION;
      return undefined;
    };

    const host = ts.createCompilerHost(this.options, true);
    const getSourceFile = host.getSourceFile.bind(host);
    const sourceFiles = new Map<string, ts.SourceFile>();
    const readFile = host.readFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    host.getSourceFile = (
      name,
      version,
      onError,
      shouldCreateNewSourceFile,
    ) => {
      const norm = ts.sys.resolvePath(name);
      if (norm === this.normalized || name === this.virtualFile)
        return ts.createSourceFile(name, this.source, version, true);
      const auxiliary = this.auxiliarySources.get(norm);
      if (auxiliary !== undefined)
        return ts.createSourceFile(name, auxiliary, version, true);
      const content = resolveVirtualContent(name);
      if (content !== undefined) {
        const cached = sourceFiles.get(norm);
        if (cached && !shouldCreateNewSourceFile) return cached;
        const sf = ts.createSourceFile(name, content, version, true);
        sourceFiles.set(norm, sf);
        return sf;
      }
      if (/\.d\.(?:ts|mts|cts)$/.test(name)) {
        // ctime also changes when a file is replaced or edited and its mtime
        // is restored; mtime and size alone can reuse stale declarations.
        let stamp: string;
        try {
          const stat = fs.statSync(name, { bigint: true });
          stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        } catch {
          stamp = "missing";
        }
        const cached = declarationFiles.get(norm);
        if (cached?.stamp === stamp && !shouldCreateNewSourceFile)
          return cached.sourceFile;
        const sf = getSourceFile(
          name,
          version,
          onError,
          shouldCreateNewSourceFile,
        );
        if (sf) declarationFiles.set(norm, { stamp, sourceFile: sf });
        return sf;
      }
      const cached = sourceFiles.get(norm);
      if (cached && !shouldCreateNewSourceFile) return cached;
      const file = getSourceFile(
        name,
        version,
        onError,
        shouldCreateNewSourceFile,
      );
      if (file) sourceFiles.set(norm, file);
      return file;
    };
    host.readFile = (name) => {
      const content = resolveVirtualContent(name);
      return content !== undefined ? content : readFile(name);
    };
    host.fileExists = (name) =>
      resolveVirtualContent(name) !== undefined || fileExists(name);
    this.host = host;
  }

  setFilename(filename: string, reuseProgram = false): void {
    const nextFile = filename.endsWith(".funx")
      ? filename.slice(0, -5) + ".tsx"
      : filename.endsWith(".fun")
        ? filename.slice(0, -4) + ".ts"
        : filename.endsWith(".ts") || filename.endsWith(".tsx")
          ? filename
          : filename + ".ts";
    if (this.virtualFile && this.virtualFile !== nextFile && !reuseProgram)
      this.program = undefined;
    // Directory tooling can opt into using the old Program as an incremental
    // base when only its virtual source root changes.
    this.virtualFile = nextFile;
    this.normalized = ts.sys.resolvePath(this.virtualFile);
    this.isJsx =
      this.virtualFile.endsWith(".tsx") || filename.endsWith(".funx");
  }

  setAuxiliarySources(sources: ReadonlyMap<string, string>): void {
    this.auxiliarySources = new Map(
      [...sources].map(([file, source]) => [ts.sys.resolvePath(file), source]),
    );
    this.program = undefined;
  }

  check(source: string):
    | {
        sourceFile: ts.SourceFile;
        checker: ts.TypeChecker;
        program: ts.Program;
      }
    | undefined {
    this.source = source;
    const rootNames: string[] = [
      this.virtualFile,
      this.resetFile,
      this.typeFestFile,
    ];
    if (this.isJsx) {
      const hasJsxIntrinsicTypes =
        /namespace\s+JSX[\s\S]*?IntrinsicElements/.test(this.source);
      if (!hasJsxIntrinsicTypes) {
        rootNames.push(this.jsxFile);
      }
    }
    this.program = ts.createProgram({
      rootNames,
      options: this.options,
      host: this.host,
      oldProgram: this.program,
    });
    const sourceFile =
      this.program.getSourceFile(this.normalized) ??
      this.program.getSourceFile(this.virtualFile);
    return sourceFile
      ? {
          sourceFile,
          checker: this.program.getTypeChecker(),
          program: this.program,
        }
      : undefined;
  }

  getProgram(): ts.Program | undefined {
    return this.program;
  }

  getTypeChecker(): ts.TypeChecker | undefined {
    return this.program?.getTypeChecker();
  }

  getNormalizedFilename(): string {
    return this.normalized || this.virtualFile;
  }
}
