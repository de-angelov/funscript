import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TraceMap } from "@jridgewell/trace-mapping";
import { Effect } from "effect";
import ts from "typescript";
import { compileString } from "../compiler.js";
import { mapDiagnosticLocation } from "../compiler/check.js";
import { rewriteRelativeImports } from "../plugins/type-view.js";

/** Run the project's TypeScript compiler, mapping verified type-view diagnostics. */
export async function runTsc(args: string[], cwd = process.cwd()): Promise<number> {
  if (args.some((arg) => arg === "--watch" || arg === "-w")) throw new Error("funscript tsc does not support watch mode; use tsc directly for watch mode");
  const require = createRequire(path.join(cwd, "package.json"));
  const tsc = require.resolve("typescript/bin/tsc");
  const output = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = spawn(process.execPath, [tsc, ...args, "--pretty", "false"], { cwd, stdio: ["inherit", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });

  const outDir = path.join(cwd, ".funscript", "types");
  const manifest: unknown = await fs.readFile(path.join(outDir, ".funscript-type-view.json"), "utf8")
    .then((text) => { try { return JSON.parse(text); } catch { return []; } }, () => []);
  const views = new Map<string, string>();
  const manifestFiles = Array.isArray(manifest) ? manifest : manifest && typeof manifest === "object" ? Object.keys(manifest) : [];
  for (const item of manifestFiles) {
    if (typeof item !== "string" || !/\.funx?$/.test(item)) continue;
    const original = path.resolve(cwd, item);
    const relative = path.relative(cwd, original);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const generated = path.join(outDir, relative.replace(/\.funx?$/, original.endsWith(".funx") ? ".tsx" : ".ts"));
    views.set(path.resolve(generated), original);
  }
  const cache = new Map<string, Promise<{ source: string; code: string; originalCode: string; map: TraceMap; file: ts.SourceFile } | undefined>>();
  const load = (generated: string, original: string) => {
    let pending = cache.get(generated);
    if (!pending) {
      pending = (async () => {
        try {
          const [source, code] = await Promise.all([fs.readFile(original, "utf8"), fs.readFile(generated, "utf8")]);
          const compiled = await Effect.runPromise(compileString(source, original, { sourcemap: true }));
          const parsed = ts.createSourceFile(generated, compiled.typescript, ts.ScriptTarget.Latest, true, generated.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
          if (!compiled.map || rewriteRelativeImports(compiled.typescript, parsed, original, generated) !== code) return undefined;
          return { source, code, originalCode: compiled.typescript, map: new TraceMap(compiled.map.toString()), file: ts.createSourceFile(generated, code, ts.ScriptTarget.Latest, true) };
        } catch { return undefined; }
      })();
      cache.set(generated, pending);
    }
    return pending;
  };
  const remap = async (text: string): Promise<string> => {
    const lines = text.split("\n");
    return (await Promise.all(lines.map(async (line) => {
      const match = /^(.*)\((\d+),(\d+)\): ((?:error|warning) TS\d+: .*)$/.exec(line);
      if (!match) return line;
      const generated = path.resolve(cwd, match[1]);
      const original = views.get(generated);
      if (!original) return line;
      const view = await load(generated, original);
      if (!view) return line;
      const lineIndex = Number(match[2]) - 1;
      const character = Number(match[3]) - 1;
      if (lineIndex < 0 || lineIndex >= view.file.getLineStarts().length) return line;
      if (view.code.split("\n")[lineIndex] !== view.originalCode.split("\n")[lineIndex]) return line;
      const start = view.file.getPositionOfLineAndCharacter(lineIndex, character);
      const token = /^[\w$]+/.exec(view.code.slice(start))?.[0] ?? "";
      const diagnostic = { file: view.file, start, length: token.length, messageText: match[4], category: ts.DiagnosticCategory.Error, code: 0 } as ts.Diagnostic;
      const location = mapDiagnosticLocation(diagnostic, path.relative(cwd, original), view.source, view.map, view.code);
      return `${location.file}(${location.line},${location.column}): ${match[4]}`;
    }))).join("\n");
  };
  process.stdout.write(await remap(output.stdout));
  process.stderr.write(await remap(output.stderr));
  return output.code;
}
