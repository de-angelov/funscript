import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { packageFingerprint } from "./package-fingerprint.js";
import { providerDependencies } from "./providers.js";

/**
 * Fingerprint only dependency graphs entirely represented by this snapshot.
 * Unresolvable packages, JS/TS or filesystem dependencies are not cached.
 * Installed package trees and declared dependencies are fingerprinted.
 */
export function incrementalDependencyKeys(
  sources: ReadonlyMap<string, string>,
  cwd: string,
): Map<string, string | undefined> {
  const graph = new Map<
    string,
    { dependencies: string[]; packages: string[]; safe: boolean }
  >();
  const packageKeys = new Map<string, string | undefined>();
  const environments = new Map<string, string | undefined>();
  const environmentFor = (filename: string): string | undefined => {
    const directory = path.dirname(filename);
    if (environments.has(directory)) return environments.get(directory);
    const hash = createHash("sha256");
    let current = directory;
    try {
      for (;;) {
        for (const name of ["package.json", "tsconfig.json"]) {
          const file = path.join(current, name);
          if (fs.existsSync(file)) {
            const content = fs.readFileSync(file, "utf8");
            // Extended configs can refer to arbitrary files outside this graph.
            if (
              name === "tsconfig.json" &&
              /["']extends["']\s*:/.test(content)
            ) {
              environments.set(directory, undefined);
              return undefined;
            }
            hash.update(JSON.stringify([file, content]));
          } else hash.update(JSON.stringify([file, null]));
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
      const key = hash.digest("hex");
      environments.set(directory, key);
      return key;
    } catch {
      environments.set(directory, undefined);
      return undefined;
    }
  };
  const sourceHashes = new Map(
    [...sources].map(([file, source]) => [
      file,
      createHash("sha256").update(source).digest("hex"),
    ]),
  );
  const exists = (file: string) => sources.has(file) || fs.existsSync(file);
  for (const [filename, source] of sources) {
    const dependencies: string[] = [];
    const packages: string[] = [];
    const environment = environmentFor(filename);
    let safe = !filename.endsWith(".funx") && environment !== undefined;
    let usesImplicitEffect = false;
    try {
      const ast = new Parser(
        new Lexer(source, filename).tokenize(),
        filename,
        source,
      ).parse();
      const inspect = (node: any): void => {
        if (!node || typeof node !== "object") return;
        if (
          [
            "TsEscapeDeclaration",
            "TsEscapeExpression",
            "TsEscapeTypeNode",
            "AsDeclaration",
            "JsExpression",
          ].includes(node.kind)
        )
          safe = false;
        if (
          [
            "PipelineExpression",
            "BinaryExpression",
            "SchemaDeclaration",
            "ErrorDeclaration",
            "ServiceDeclaration",
            "EffectBlockExpression",
          ].includes(node.kind)
        )
          usesImplicitEffect = true;
        if (Array.isArray(node)) {
          node.forEach(inspect);
          return;
        }
        for (const [key, value] of Object.entries(node))
          if (key !== "span" && value && typeof value === "object")
            inspect(value);
      };
      inspect(ast);
      for (const file of providerDependencies(ast, filename)) {
        try {
          packages.push(
            `provider:${file}:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
            packages.push(`provider:${file}:missing`);
          else safe = false;
        }
      }
      if (usesImplicitEffect) {
        try {
          const key = `effect\0${createRequire(filename).resolve("effect")}`;
          if (!packageKeys.has(key))
            packageKeys.set(key, packageFingerprint("effect", filename));
          const fingerprint = packageKeys.get(key);
          if (!fingerprint) safe = false;
          else packages.push(fingerprint);
        } catch {
          safe = false;
        }
      }
      for (const item of ast.body) {
        if (
          item.kind !== "ImportDeclaration" &&
          item.kind !== "ExportFromDeclaration"
        )
          continue;
        if (
          item.source.parts.length !== 1 ||
          item.source.parts[0].kind !== "StringRawPart"
        ) {
          safe = false;
          continue;
        }
        const specifier = item.source.parts[0].value;
        if (!specifier.startsWith(".")) {
          let key: string;
          try {
            key = `${specifier}\0${createRequire(filename).resolve(specifier)}`;
          } catch {
            safe = false;
            continue;
          }
          if (!packageKeys.has(key))
            packageKeys.set(key, packageFingerprint(specifier, filename));
          const fingerprint = packageKeys.get(key);
          if (!fingerprint) safe = false;
          else packages.push(fingerprint);
          continue;
        }
        const requested = path.resolve(path.dirname(filename), specifier);
        let candidates: string[] = [];
        if (/\.funx?$/.test(requested)) candidates = [requested];
        else if (requested.endsWith(".js")) {
          const base = requested.slice(0, -3);
          if (
            [
              requested,
              `${base}.ts`,
              `${base}.tsx`,
              `${base}.jsx`,
              `${base}.d.ts`,
              `${base}.d.mts`,
              `${base}.d.cts`,
            ].some(exists)
          ) {
            safe = false;
            continue;
          }
          candidates = [`${base}.fun`, `${base}.funx`].filter(exists);
        }
        if (candidates.length !== 1 || !sources.has(candidates[0])) {
          safe = false;
          continue;
        }
        dependencies.push(candidates[0]);
      }
    } catch {
      safe = false;
    }
    if (environment) packages.push(environment);
    graph.set(filename, { dependencies, packages, safe });
  }
  const result = new Map<string, string | undefined>();
  for (const filename of sources.keys()) {
    const seen = new Set<string>();
    let safe = true;
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const node = graph.get(file);
      if (!node?.safe) {
        safe = false;
        return;
      }
      node.dependencies.forEach(visit);
    };
    visit(filename);
    if (!safe) {
      result.set(filename, undefined);
      continue;
    }
    const hash = createHash("sha256");
    hash.update(cwd);
    for (const file of [...seen].sort())
      hash.update(
        JSON.stringify([
          file,
          sourceHashes.get(file),
          graph.get(file)?.packages,
        ]),
      );
    result.set(filename, hash.digest("hex"));
  }
  return result;
}
