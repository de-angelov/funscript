import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { funscriptPlugin } from "../src/plugins/vite.js";
import { compileString } from "../src/compiler.js";
import {
  loadProjectConfig,
  isEffectOnlyFile,
} from "../src/compiler/project-config.js";
import {
  createTypeCheckCache,
  typeCheckSource,
} from "../src/compiler/check.js";

describe("FunScript project policy", () => {
  it("loads a static FunScript record and rejects dynamic or unknown options", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "funscript-config-"));
    expect(loadProjectConfig(dir)).toEqual({});
    const file = path.join(dir, "funscript.config.fun");
    writeFileSync(
      file,
      'export config = { noTs: true, noGlobalThis: true, noOptional: true, barePipelines: true, noDeepDestructure: true, maxDestructureDepth: 2, effectOnly: ["src/domain"], allowHoles: true }',
    );
    expect(loadProjectConfig(dir)).toEqual({
      noTs: true,
      noGlobalThis: true,
      noOptional: true,
      barePipelines: true,
      noDeepDestructure: true,
      maxDestructureDepth: 2,
      effectOnly: ["src/domain"],
      allowHoles: true,
    });
    expect(
      isEffectOnlyFile(loadProjectConfig(dir), dir, "src/domain/model.fun"),
    ).toBe(true);
    expect(
      isEffectOnlyFile(loadProjectConfig(dir), dir, "src/domain2/model.fun"),
    ).toBe(false);
    for (const input of [
      "export config = { noTs: unknown }",
      "export config = { typo: true }",
      'export config = { effectOnly: ["../outside"] }',
      "export config = { noTs: true, noTs: false }",
      "export config = { maxDestructureDepth: 0 }",
      "export config = { maxDestructureDepth: 11 }",
      "export config = { maxDestructureDepth: 2.5 }",
      'export config = { maxDestructureDepth: "two" }',
      'ts { console.log("bad") }',
    ]) {
      writeFileSync(file, input);
      expect(() => loadProjectConfig(dir)).toThrow("invalid FunScript config");
    }
  });

  it.each([
    "export x = globalThis.fetch",
    'export x = globalThis["fetch"]',
    "export x = window.globalThis",
    'export x = window["globalThis"]',
    "export x = () => globalThis",
    "export x = { globalThis }",
  ])("rejects references to globalThis: %s", async (source) => {
    await expect(
      Effect.runPromise(
        compileString(source, "test.fun", { noGlobalThis: true }),
      ),
    ).rejects.toThrow("globalThis is disabled by project policy");
  });

  it("allows ordinary properties and strings named globalThis", async () => {
    const source =
      'export x = { globalThis: "globalThis" }\nexport read = (value: { globalThis: String }) => value.globalThis\nexport destructure = ({ globalThis: renamed }) => renamed';
    await expect(
      Effect.runPromise(
        compileString(source, "test.fun", { noGlobalThis: true }),
      ),
    ).resolves.toBeDefined();
  });

  it.each([
    ["parameter", "export f = (name?: String) => name"],
    ["record type field", "export f = (user: { name?: String }) => user"],
    ["schema field", "export schema User = { name?: String }"],
  ])(
    "rejects optional values when noOptional is enabled: %s",
    async (_, source) => {
      await expect(
        Effect.runPromise(
          compileString(source, "test.fun", { noOptional: true }),
        ),
      ).rejects.toThrow("Optional");
    },
  );

  it("allows Option<T> and defaulted parameters when noOptional is enabled", async () => {
    const source =
      'import { Option } from "effect"\nexport f = (opt: Option<String>, port: Number = 8080) => port';
    await expect(
      Effect.runPromise(
        compileString(source, "test.fun", { noOptional: true }),
      ),
    ).resolves.toBeDefined();
  });

  it("allows optional values inside ts escape hatches when noOptional is enabled", async () => {
    const source = "export f = ts { (x?: string) => x }";
    await expect(
      Effect.runPromise(
        compileString(source, "test.fun", { noOptional: true }),
      ),
    ).resolves.toBeDefined();
  });

  it.each([
    [
      "String.trim",
      'sec = { name: "test" }\nexport cleanName = sec.name |> String.trim',
    ],
    [
      "String.replace",
      'sec = { name: "test" }\nexport cleanName = sec.name |> String.replace("a", "b")',
    ],
    ["Array.map", "export res = [1, 2] |> Array.map((x) => x * 2)"],
    [
      "Option.getOrElse",
      'import { Option } from "effect"\nexport res = Option.none() |> Option.getOrElse(() => 0)',
    ],
  ])(
    "rejects redundant companion prefix in pipeline when barePipelines is enabled: %s",
    async (_, source) => {
      await expect(
        Effect.runPromise(
          compileString(source, "test.fun", { barePipelines: true }),
        ),
      ).rejects.toThrow("Redundant pipeline prefix");
    },
  );

  it("allows bare pipeline stages and non-pipeline companion calls when barePipelines is enabled", async () => {
    const pipeline =
      'sec = { name: "test" }\nexport cleanName = sec.name |> replace("a", "b") |> trim |> toLowerCase';
    await expect(
      Effect.runPromise(
        compileString(pipeline, "test.fun", { barePipelines: true }),
      ),
    ).resolves.toBeDefined();

    const directCall = 'export trimmed = String.trim("hello")';
    await expect(
      Effect.runPromise(
        compileString(directCall, "test.fun", { barePipelines: true }),
      ),
    ).resolves.toBeDefined();
  });

  it("loads folder policy from the Vite project root", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "funscript-vite-policy-"));
    writeFileSync(
      path.join(root, "funscript.config.fun"),
      'export config = { noGlobalThis: ["app/domain"] }',
    );
    const plugin = funscriptPlugin();
    await (plugin.config as Function).call({}, { root, resolve: {} }, {});
    const transform = plugin.transform as Function;
    await expect(
      transform.call(
        {},
        "export x = globalThis",
        path.join(root, "app/domain/a.fun"),
      ),
    ).rejects.toThrow("globalThis is disabled by project policy");
    await expect(
      transform.call(
        {},
        "export x = globalThis",
        path.join(root, "app/other.fun"),
      ),
    ).resolves.toBeDefined();
  });

  it("does not reuse cached output from permissive checks", async () => {
    const source = "export value = globalThis";
    const cache = createTypeCheckCache();
    await Effect.runPromise(typeCheckSource(source, "cache.fun", { cache }));
    const result = await Effect.runPromise(
      typeCheckSource(source, "cache.fun", { cache, noGlobalThis: true }),
    );
    expect(result.success).toBe(false);
    expect(result.formattedOutput).toContain(
      "globalThis is disabled by project policy",
    );
  });

  it.each([
    ['import { readFile } from "node:fs"\nexport x = 1', "disallows import"],
    ['export x = fetch("https://example.com")', "disallows 'fetch'"],
    ["export x = globalThis", "disallows 'globalThis'"],
    ['export x = js fetch("https://example.com")', "disallows 'js' interop"],
    ["export js x = () => Effect.succeed(1)", "disallows 'js' interop"],
    ["ts { const x = 1; }", "TypeScript escapes are disabled"],
  ])(
    "rejects non-Effect sources under the Effect-only policy",
    async (source, message) => {
      await expect(
        Effect.runPromise(
          compileString(source, "test.fun", { effectOnly: true }),
        ),
      ).rejects.toThrow(message);
    },
  );

  it("allows Effect imports and ordinary pure functions under the Effect-only policy", async () => {
    const source =
      'import { Effect } from "effect"\nexport add = (a: Number, b: Number) => a + b\nexport value = Effect.succeed(1)';
    await expect(
      Effect.runPromise(
        compileString(source, "test.fun", { effectOnly: true }),
      ),
    ).resolves.toBeDefined();
  });

  it("limits local dependencies to FunScript inside Effect-only folders", async () => {
    const root = process.cwd();
    const source = 'import { value } from "./helper.js"\nexport result = value';
    const file = path.join(root, "policy-fixture/src/domain/main.fun");
    const options = {
      effectOnly: true,
      effectOnlyDirectories: ["policy-fixture/src/domain"],
      policyRoot: root,
      virtualSources: new Map([
        [
          path.join(root, "policy-fixture/src/domain/helper.fun"),
          "export value = 1",
        ],
      ]),
    };
    await expect(
      Effect.runPromise(compileString(source, file, options)),
    ).resolves.toBeDefined();
    await expect(
      Effect.runPromise(
        compileString(
          'import { value } from "../other.js"\nexport result = value',
          file,
          options,
        ),
      ),
    ).rejects.toThrow("must remain within an Effect-only directory");
    const sidecar = {
      ...options,
      virtualSources: new Map([
        [
          path.join(root, "policy-fixture/src/domain/helper.ts"),
          "export const value = 1",
        ],
      ]),
    };
    await expect(
      Effect.runPromise(compileString(source, file, sidecar)),
    ).rejects.toThrow("resolves to a JavaScript or TypeScript file");
  });

  describe("noDeepDestructure and maxDestructureDepth policy", () => {
    it("allows flat and 2-level destructuring under default 2-level limit", async () => {
      const sources = [
        "export f = ({ a, b }) => a + b",
        "export f = ({ user: { name } }) => name",
        "export [head, ...tail] = [1, 2, 3]",
        "export [[x, y]] = [[1, 2]]",
        "export { items: [first] } = { items: [1] }",
        "export [] = [1, 2]",
        "export {} = { a: 1 }",
        'import { Option } from "effect"\nexport f = (opt) => match opt | Some({ id }) => id | None => 0',
      ];
      for (const source of sources) {
        await expect(
          Effect.runPromise(
            compileString(source, "test.fun", { noDeepDestructure: true }),
          ),
        ).resolves.toBeDefined();
      }
    });

    it("rejects 3-level destructuring under default 2-level limit", async () => {
      const violations = [
        ["parameter", "export f = ({ user: { profile: { name } } }) => name"],
        [
          "binding",
          "obj = { user: { profile: { name: 1 } } }\nexport { user: { profile: { name } } } = obj",
        ],
        ["nested array", "arr = [[[1]]]\nexport [[[x]]] = arr"],
        [
          "record and array",
          "obj = { items: [{ name: 1 }] }\nexport { items: [{ name }] } = obj",
        ],
        [
          "match constructor",
          'import { Option } from "effect"\nexport f = (opt) => match opt | Some({ user: { id } }) => id | None => 0',
        ],
        [
          "effect bind statement",
          "export f = effect {\n  { user: { profile: { name } } } <- getUser\n  => name\n}",
        ],
      ];
      for (const [kind, source] of violations) {
        await expect(
          Effect.runPromise(
            compileString(source, "test.fun", { noDeepDestructure: true }),
          ),
          `expected ${kind} to exceed max destructure depth`,
        ).rejects.toThrow(
          "Destructuring depth of 3 exceeds the maximum allowed depth of 2",
        );
      }
    });

    it("respects custom maxDestructureDepth", async () => {
      const source = "export f = ({ user: { name } }) => name";

      // With maxDestructureDepth: 1, 2-level nesting is rejected
      await expect(
        Effect.runPromise(
          compileString(source, "test.fun", { maxDestructureDepth: 1 }),
        ),
      ).rejects.toThrow(
        "Destructuring depth of 2 exceeds the maximum allowed depth of 1",
      );

      // With maxDestructureDepth: 3, 3-level nesting is allowed
      const deepSource = "export f = ({ user: { profile: { name } } }) => name";
      await expect(
        Effect.runPromise(
          compileString(deepSource, "test.fun", { maxDestructureDepth: 3 }),
        ),
      ).resolves.toBeDefined();

      // With maxDestructureDepth: 3, 4-level nesting is rejected
      const fourLevelSource = "export f = ({ a: { b: { c: { d } } } }) => d";
      await expect(
        Effect.runPromise(
          compileString(fourLevelSource, "test.fun", {
            maxDestructureDepth: 3,
          }),
        ),
      ).rejects.toThrow(
        "Destructuring depth of 4 exceeds the maximum allowed depth of 3",
      );
    });

    it("applies noDeepDestructure to matching directory paths", async () => {
      const source = "export f = ({ user: { profile: { name } } }) => name";
      const options = {
        noDeepDestructurePaths: ["src/clean"],
        policyRoot: "/workspace",
      };

      await expect(
        Effect.runPromise(
          compileString(source, "/workspace/src/clean/module.fun", options),
        ),
      ).rejects.toThrow(
        "Destructuring depth of 3 exceeds the maximum allowed depth of 2",
      );

      await expect(
        Effect.runPromise(
          compileString(source, "/workspace/src/other/module.fun", options),
        ),
      ).resolves.toBeDefined();
    });
  });
});
