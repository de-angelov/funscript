import ts from "typescript";

/** Reuses the host, library files and previous program throughout one compilation. */
export class TypeScriptCompilationContext {
  private readonly options: ts.CompilerOptions = {
    strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true, jsx: ts.JsxEmit.Preserve,
  };
  private readonly virtualFile: string;
  private readonly normalized: string;
  private readonly host: ts.CompilerHost;
  private source = "";
  private program?: ts.Program;

  constructor(filename: string) {
    this.virtualFile = filename.endsWith(".funx") ? filename.slice(0, -5) + ".tsx"
      : filename.endsWith(".fun") ? filename.slice(0, -4) + ".ts" : filename + ".ts";
    this.normalized = ts.sys.resolvePath(this.virtualFile);
    const host = ts.createCompilerHost(this.options, true);
    const getSourceFile = host.getSourceFile.bind(host);
    const sourceFiles = new Map<string, ts.SourceFile>();
    const readFile = host.readFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    host.getSourceFile = (name, version, onError, shouldCreateNewSourceFile) => {
      const key = ts.sys.resolvePath(name);
      if (key === this.normalized) return ts.createSourceFile(name, this.source, version, true);
      const cached = sourceFiles.get(key);
      if (cached && !shouldCreateNewSourceFile) return cached;
      const file = getSourceFile(name, version, onError, shouldCreateNewSourceFile);
      if (file) sourceFiles.set(key, file);
      return file;
    };
    host.readFile = (name) => ts.sys.resolvePath(name) === this.normalized ? this.source : readFile(name);
    host.fileExists = (name) => ts.sys.resolvePath(name) === this.normalized || fileExists(name);
    this.host = host;
  }

  check(source: string): { sourceFile: ts.SourceFile; checker: ts.TypeChecker; program: ts.Program } | undefined {
    this.source = source;
    this.program = ts.createProgram({ rootNames: [this.virtualFile], options: this.options, host: this.host, oldProgram: this.program });
    const sourceFile = this.program.getSourceFile(this.normalized) ?? this.program.getSourceFile(this.virtualFile);
    return sourceFile ? { sourceFile, checker: this.program.getTypeChecker(), program: this.program } : undefined;
  }
}
