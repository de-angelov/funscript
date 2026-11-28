import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { JsInteropError } from "funscript/js";
import ts from "typescript";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compileString } from "../src/compiler.js";

describe("shared JavaScript interop runtime", () => {
  it("shares error identity across independently emitted modules", async () => {
    const dir = await mkdtemp(path.join(process.cwd(), ".interop-test-"));
    try {
      const modules = [];
      for (const name of ["first", "second"]) {
        const source = `
ts { const foreign = (): string => { throw new Error("${name}"); }; }
export run = effect {
  value <- js foreign()
  => value
}`;
        const result = await Effect.runPromise(
          compileString(source, path.join(dir, `${name}.fun`)),
        );
        expect(result.typescript).toContain('from "funscript/js"');
        expect(result.typescript).not.toContain("class JsInteropError");
        const js = ts.transpileModule(result.typescript, {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
          },
        }).outputText;
        const file = path.join(dir, `${name}.mjs`);
        await writeFile(file, js);
        modules.push(await import(pathToFileURL(file).href));
      }
      const failures = await Promise.all(
        modules.map((mod) => Effect.runPromise(Effect.flip(mod.run))),
      );
      for (const failure of failures) {
        expect(failure).toBeInstanceOf(JsInteropError);
        expect(failure._tag).toBe("JsInteropError");
      }
      expect(failures.map((failure) => failure.cause.message)).toEqual([
        "first",
        "second",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
