import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";

/**
 * Fingerprint only dependency graphs entirely represented by this snapshot.
 * Unknown package, JS/TS or filesystem dependencies are deliberately not cached:
 * changing them can affect FunScript emission even when a source file is unchanged.
 */
export function incrementalDependencyKeys(sources: ReadonlyMap<string, string>, cwd: string): Map<string, string | undefined> {
  const graph = new Map<string, { dependencies: string[]; safe: boolean }>();
  const sourceHashes = new Map([...sources].map(([file, source]) => [file, createHash("sha256").update(source).digest("hex")]));
  const exists = (file: string) => sources.has(file) || fs.existsSync(file);
  for (const [filename, source] of sources) {
    const dependencies: string[] = [];
    let safe = !filename.endsWith(".funx");
    try {
      const ast = new Parser(new Lexer(source, filename).tokenize(), filename, source).parse();
      const inspect = (node: any): void => {
        if (!node || typeof node !== "object") return;
        if (["TsEscapeDeclaration", "TsEscapeExpression", "TsEscapeTypeNode", "AsDeclaration", "JsExpression"].includes(node.kind)) safe = false;
        if (Array.isArray(node)) { node.forEach(inspect); return; }
        for (const [key, value] of Object.entries(node)) if (key !== "span" && value && typeof value === "object") inspect(value);
      };
      inspect(ast);
      for (const item of ast.body) {
        if (item.kind !== "ImportDeclaration" && item.kind !== "ExportFromDeclaration") continue;
        if (item.source.parts.length !== 1 || item.source.parts[0].kind !== "StringRawPart") { safe = false; continue; }
        const specifier = item.source.parts[0].value;
        if (!specifier.startsWith(".")) { safe = false; continue; }
        const requested = path.resolve(path.dirname(filename), specifier);
        let candidates: string[] = [];
        if (/\.funx?$/.test(requested)) candidates = [requested];
        else if (requested.endsWith(".js")) {
          const base = requested.slice(0, -3);
          if ([requested, `${base}.ts`, `${base}.tsx`, `${base}.jsx`, `${base}.d.ts`, `${base}.d.mts`, `${base}.d.cts`].some(exists)) { safe = false; continue; }
          candidates = [`${base}.fun`, `${base}.funx`].filter(exists);
        }
        if (candidates.length !== 1 || !sources.has(candidates[0])) { safe = false; continue; }
        dependencies.push(candidates[0]);
      }
    } catch { safe = false; }
    graph.set(filename, { dependencies, safe });
  }
  const result = new Map<string, string | undefined>();
  for (const filename of sources.keys()) {
    const seen = new Set<string>();
    let safe = true;
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const node = graph.get(file);
      if (!node?.safe) { safe = false; return; }
      node.dependencies.forEach(visit);
    };
    visit(filename);
    if (!safe) { result.set(filename, undefined); continue; }
    const hash = createHash("sha256");
    hash.update(cwd);
    for (const file of [...seen].sort()) hash.update(JSON.stringify([file, sourceHashes.get(file)]));
    result.set(filename, hash.digest("hex"));
  }
  return result;
}
