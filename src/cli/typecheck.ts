import { Console, Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compileString } from "../compiler.js";
import { typeCheckFiles } from "../compiler/check.js";

/** Include local FunScript modules in the checker's virtual TypeScript program. */
export const checkCliFiles = (entryFiles: string[]) =>
  Effect.gen(function* () {
    const files = new Set(entryFiles.map((file) => path.resolve(file)));
    for (const file of files) {
      const source = yield* Effect.tryPromise(() => fs.readFile(file, "utf8"));
      const compiled = yield* compileString(source, file);
      for (const declaration of compiled.ast.body) {
        if (declaration.kind !== "ImportDeclaration") continue;
        const specifier = declaration.source.parts.map((part) => part.kind === "StringRawPart" ? part.value : "").join("");
        if (!specifier.startsWith(".")) continue;
        const target = path.resolve(path.dirname(file), specifier);
        const stem = target.replace(/\.(?:js|jsx|ts|tsx|fun|funx)$/, "");
        const candidates = /\.funx?$/.test(target)
          ? [target]
          : [`${stem}.fun`, `${stem}.funx`, path.join(target, "index.fun"), path.join(target, "index.funx")];
        for (const candidate of candidates) {
          const exists = yield* Effect.promise(() => fs.stat(candidate).then((stat) => stat.isFile(), () => false));
          if (exists) {
            files.add(candidate);
            break;
          }
        }
      }
    }
    const result = yield* typeCheckFiles([...files]);
    if (!result.success) {
      process.exitCode = 1;
      yield* Console.error(result.formattedOutput);
    }
    return result.success;
  });
