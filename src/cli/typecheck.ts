import { Console, Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { typeCheckFiles } from "../compiler/check.js";

/** Include local FunScript modules in the checker's virtual TypeScript program. */
export const collectCliFiles = (entryFiles: string[], options?: { cwd?: string }) =>
  Effect.gen(function* () {
    const files = new Set(entryFiles.map((file) => path.resolve(options?.cwd ?? process.cwd(), file)));
    for (const file of files) {
      const source = yield* Effect.tryPromise(() => fs.readFile(file, "utf8"));
      let declarations;
      try { declarations = new Parser(new Lexer(source, file).tokenize(), file, source).parse().body; }
      catch { continue; } // The type checker reports the source's syntax diagnostics.
      for (const declaration of declarations) {
        if (declaration.kind !== "ImportDeclaration" && declaration.kind !== "ExportFromDeclaration") continue;
        const specifier = declaration.source.parts.map((part) => part.kind === "StringRawPart" ? part.value : "").join("");
        if (!specifier.startsWith(".")) continue;
        const target = path.resolve(path.dirname(file), specifier);
        const stem = target.replace(/\.(?:js|jsx|ts|tsx|fun|funx)$/, "");
        const isFun = /\.funx?$/.test(target);
        const exists = (candidate: string) => fs.stat(candidate).then((stat) => stat.isFile(), () => false);
        if (!isFun) {
          // Leave actual JS/TS targets to TypeScript instead of adding a competing
          // FunScript file with the same stem to the virtual program.
          const regular = [target, `${stem}.ts`, `${stem}.tsx`, `${stem}.jsx`, `${stem}.d.ts`, `${stem}.d.mts`, `${stem}.d.cts`];
          if ((yield* Effect.promise(() => Promise.all(regular.map(exists)))).some(Boolean)) continue;
        }
        const candidates = isFun ? [target] : [`${stem}.fun`, `${stem}.funx`, path.join(target, "index.fun"), path.join(target, "index.funx")];
        const matches = (yield* Effect.promise(() => Promise.all(candidates.map(exists)))).flatMap((found, i) => found ? [candidates[i]] : []);
        if (matches.length === 1) files.add(matches[0]);
      }
    }
    return [...files];
  });

export const checkCliFiles = (entryFiles: string[], options?: { cwd?: string }) =>
  Effect.gen(function* () {
    const files = yield* collectCliFiles(entryFiles, options);
    const result = yield* typeCheckFiles(files, { cwd: options?.cwd });
    if (!result.success) {
      process.exitCode = 1;
      yield* Console.error(result.formattedOutput);
    }
    return result.success;
  });
