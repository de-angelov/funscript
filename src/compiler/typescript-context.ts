import ts from "typescript";
import path from "node:path";

export const TS_RESET_DECLARATION =
  '/// <reference types="@total-typescript/ts-reset" />\n' +
  'interface JSON { parse(text: string, reviver?: (this: any, key: string, value: any) => any): unknown; }\n' +
  'interface Body { json(): Promise<unknown>; }\n';

export const JSX_INTRINSICS_DECLARATION =
  'declare namespace JSX { interface IntrinsicElements { [element: string]: any } }';

export const TYPE_FEST_DECLARATION =
  'type Simplify<T> = { [KeyType in keyof T]: T[KeyType] } & {};\n' +
  'type Prettify<T> = Simplify<T>;\n' +
  'type Except<ObjectType, KeysType extends keyof ObjectType, Options = {}> = Simplify<{\n' +
  '  [KeyType in keyof ObjectType as KeyType extends KeysType ? never : KeyType]: ObjectType[KeyType];\n' +
  '}>;\n' +
  'type SetOptional<BaseType, Keys extends keyof BaseType = keyof BaseType> = Simplify<\n' +
  '  Except<BaseType, Keys> & Partial<Pick<BaseType, Keys>>\n' +
  '>;\n' +
  'declare const _tag: unique symbol;\n' +
  'type TagContainer<Token> = { readonly [_tag]: Token };\n' +
  'type Tag<Token extends PropertyKey, TagMetadata> = TagContainer<{ [K in Token]: TagMetadata }>;\n' +
  'type Tagged<Type, TagName extends PropertyKey, TagMetadata = never> = Type & Tag<TagName, TagMetadata>;\n' +
  'type UnwrapTagged<T> = T extends Tagged<infer Underlying, any, any> ? Underlying : T;\n';

/** Reuses the host, library files and previous program throughout one compilation. */
export class TypeScriptCompilationContext {
  private readonly options: ts.CompilerOptions = {
    strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true, jsx: ts.JsxEmit.Preserve,
  };
  private readonly virtualFile: string;
  private readonly normalized: string;
  private readonly resetFile: string;
  private readonly normalizedReset: string;
  private readonly typeFestFile: string;
  private readonly normalizedTypeFest: string;
  private readonly jsxFile: string;
  private readonly normalizedJsx: string;
  private readonly isJsx: boolean;
  private readonly host: ts.CompilerHost;
  private source = "";
  private program?: ts.Program;

  constructor(filename: string) {
    this.virtualFile = filename.endsWith(".funx") ? filename.slice(0, -5) + ".tsx"
      : filename.endsWith(".fun") ? filename.slice(0, -4) + ".ts" : filename.endsWith(".ts") || filename.endsWith(".tsx") ? filename : filename + ".ts";
    this.normalized = ts.sys.resolvePath(this.virtualFile);
    this.isJsx = this.virtualFile.endsWith(".tsx") || filename.endsWith(".funx");

    const cwd = process.cwd();
    this.resetFile = path.resolve(cwd, "__funscript_ts_reset__.d.ts");
    this.normalizedReset = ts.sys.resolvePath(this.resetFile);
    this.typeFestFile = path.resolve(cwd, "__funscript_type_fest__.d.ts");
    this.normalizedTypeFest = ts.sys.resolvePath(this.typeFestFile);
    this.jsxFile = path.resolve(cwd, "__funscript_jsx_intrinsics__.d.ts");
    this.normalizedJsx = ts.sys.resolvePath(this.jsxFile);

    const resolveVirtualContent = (name: string): string | undefined => {
      const norm = ts.sys.resolvePath(name);
      if (norm === this.normalized || name === this.virtualFile) {
        return this.source;
      }
      if (
        norm === this.normalizedReset ||
        name === this.resetFile ||
        path.basename(name) === "__funscript_ts_reset__.d.ts"
      ) {
        return TS_RESET_DECLARATION;
      }
      if (
        norm === this.normalizedTypeFest ||
        name === this.typeFestFile ||
        path.basename(name) === "__funscript_type_fest__.d.ts"
      ) {
        return TYPE_FEST_DECLARATION;
      }
      if (
        norm === this.normalizedJsx ||
        name === this.jsxFile ||
        path.basename(name) === "__funscript_jsx_intrinsics__.d.ts"
      ) {
        return JSX_INTRINSICS_DECLARATION;
      }
      return undefined;
    };

    const host = ts.createCompilerHost(this.options, true);
    const getSourceFile = host.getSourceFile.bind(host);
    const sourceFiles = new Map<string, ts.SourceFile>();
    const readFile = host.readFile.bind(host);
    const fileExists = host.fileExists.bind(host);

    host.getSourceFile = (name, version, onError, shouldCreateNewSourceFile) => {
      const norm = ts.sys.resolvePath(name);
      if (norm === this.normalized || name === this.virtualFile) {
        return ts.createSourceFile(name, this.source, version, true);
      }
      const content = resolveVirtualContent(name);
      if (content !== undefined) {
        const cached = sourceFiles.get(norm);
        if (cached && !shouldCreateNewSourceFile) return cached;
        const sf = ts.createSourceFile(name, content, version, true);
        sourceFiles.set(norm, sf);
        return sf;
      }
      const cached = sourceFiles.get(norm);
      if (cached && !shouldCreateNewSourceFile) return cached;
      const file = getSourceFile(name, version, onError, shouldCreateNewSourceFile);
      if (file) sourceFiles.set(norm, file);
      return file;
    };

    host.readFile = (name) => {
      const content = resolveVirtualContent(name);
      return content !== undefined ? content : readFile(name);
    };

    host.fileExists = (name) => {
      return resolveVirtualContent(name) !== undefined || fileExists(name);
    };

    this.host = host;
  }

  check(source: string): { sourceFile: ts.SourceFile; checker: ts.TypeChecker; program: ts.Program } | undefined {
    this.source = source;
    const rootNames: string[] = [this.virtualFile, this.resetFile, this.typeFestFile];
    if (this.isJsx) {
      const hasJsxIntrinsicTypes = /namespace\s+JSX[\s\S]*?IntrinsicElements/.test(this.source);
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
    const sourceFile = this.program.getSourceFile(this.normalized) ?? this.program.getSourceFile(this.virtualFile);
    return sourceFile ? { sourceFile, checker: this.program.getTypeChecker(), program: this.program } : undefined;
  }
}
