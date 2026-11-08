import { describe, expect, it } from "vitest";
import { Effect, String as EffectString, pipe } from "effect";
import ts from "typescript";
import { compileString } from "../src/compiler.js";
import { typeCheckSource } from "../src/compiler/check.js";
import * as esToolkit from "es-toolkit";

async function compileAndEval<T>(code: string): Promise<{ typescript: string; result: T }> {
  const compileResult = await Effect.runPromise(compileString(code));
  const tsCode = compileResult.typescript;

  // Verify type checking passes
  const checkResult = await Effect.runPromise(typeCheckSource(code, "test.fun"));
  expect(checkResult.success, `Type checking failed with diagnostics: ${JSON.stringify(checkResult.diagnostics)}`).toBe(true);

  // Transpile TypeScript to JavaScript to strip type annotations
  const { outputText: jsTranspiled } = ts.transpileModule(tsCode, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });

  // Evaluate emitted JavaScript code by stripping imports and exports
  const evalCode = jsTranspiled
    .replace(/^import\s+[^;]+;\s*$/gm, "")
    .replace(/\bexport\s+const\s+/g, "const ")
    .replace(/\bexport\s+/g, "");

  // Create an evaluation context with pipe, Effect String, and es-toolkit utilities available
  const contextKeys = ["pipe", "String", "slug", ...Object.keys(esToolkit)];
  const contextValues = [pipe, EffectString, esToolkit.kebabCase, ...Object.values(esToolkit)];

  const fn = new Function(...contextKeys, `${evalCode}\nreturn typeof result !== "undefined" ? result : undefined;`);
  const result = fn(...contextValues);

  return { typescript: tsCode, result };
}

describe("es-toolkit pipeline integration", () => {
  describe("pure string utilities in pipelines", () => {
    it("supports slug pipeline operations", async () => {
      const code = 'export result = "Hello World From FunScript!" |> slug';
      const { typescript, result } = await compileAndEval<string>(code);

      expect(typescript).toContain('import { kebabCase as slug } from "es-toolkit";');
      expect(typescript).toContain("pipe(\n  \"Hello World From FunScript!\",\n  slug\n)");
      expect(result).toBe("hello-world-from-fun-script");
    });

    it("supports camelCase pipeline operations", async () => {
      const code = 'export result = "order_fulfillment_service" |> camelCase';
      const { typescript, result } = await compileAndEval<string>(code);

      expect(typescript).toContain('import { camelCase } from "es-toolkit";');
      expect(result).toBe("orderFulfillmentService");
    });

    it("supports snakeCase pipeline operations", async () => {
      const code = 'export result = "orderFulfillmentService" |> snakeCase';
      const { typescript, result } = await compileAndEval<string>(code);

      expect(typescript).toContain('import { snakeCase } from "es-toolkit";');
      expect(result).toBe("order_fulfillment_service");
    });

    it("supports kebabCase pipeline operations", async () => {
      const code = 'export result = "Order Fulfillment Service" |> kebabCase';
      const { typescript, result } = await compileAndEval<string>(code);

      expect(typescript).toContain('import { kebabCase } from "es-toolkit";');
      expect(result).toBe("order-fulfillment-service");
    });

    it("supports pascalCase and capitalize pipeline operations", async () => {
      const code = 'export result = "hello world" |> pascalCase';
      const { typescript, result } = await compileAndEval<string>(code);

      expect(typescript).toContain('import { pascalCase } from "es-toolkit";');
      expect(result).toBe("HelloWorld");
    });

    it("chains Effect string combinators and es-toolkit string operations", async () => {
      const code = 'export result = "   DeepMind FunScript Pipeline   " |> trim |> slug';
      const { typescript, result } = await compileAndEval<string>(code);

      expect(typescript).toContain('import { String, pipe } from "effect";');
      expect(typescript).toContain('import { kebabCase as slug } from "es-toolkit";');
      expect(result).toBe("deep-mind-fun-script-pipeline");
    });
  });

  describe("math utilities with data-last calling conventions", () => {
    it("supports clamp in data-last pipelines", async () => {
      const code = "export result = 15 |> clamp(0, 10)";
      const { typescript, result } = await compileAndEval<number>(code);

      expect(typescript).toContain('import { clamp } from "es-toolkit";');
      expect(typescript).toContain("(__p) => clamp(__p, 0, 10)");
      expect(result).toBe(10);
    });

    it("supports clamp with negative bounds and in-range values", async () => {
      const code1 = "export result = -5 |> clamp(0, 10)";
      const { result: res1 } = await compileAndEval<number>(code1);
      expect(res1).toBe(0);

      const code2 = "export result = 7 |> clamp(0, 10)";
      const { result: res2 } = await compileAndEval<number>(code2);
      expect(res2).toBe(7);
    });

    it("supports round in data-last pipelines with precision argument", async () => {
      const code = "export result = 3.14159265 |> round(2)";
      const { typescript, result } = await compileAndEval<number>(code);

      expect(typescript).toContain('import { round } from "es-toolkit";');
      expect(typescript).toContain("(__p) => round(__p, 2)");
      expect(result).toBe(3.14);
    });

    it("supports round as a bare identifier in pipelines defaulting to 0 decimals", async () => {
      const code = "export result = 5.67 |> round";
      const { typescript, result } = await compileAndEval<number>(code);

      expect(typescript).toContain('import { round } from "es-toolkit";');
      expect(typescript).toContain("pipe(\n  5.67,\n  round\n)");
      expect(result).toBe(6);
    });

    it("supports inRange in data-last pipelines", async () => {
      const codeTrue = "export result = 5 |> inRange(0, 10)";
      const { result: resTrue } = await compileAndEval<boolean>(codeTrue);
      expect(resTrue).toBe(true);

      const codeFalse = "export result = 15 |> inRange(0, 10)";
      const { result: resFalse } = await compileAndEval<boolean>(codeFalse);
      expect(resFalse).toBe(false);
    });

    it("chains multiple math operations in a single pipeline", async () => {
      const code = "export result = 25.6789 |> clamp(0, 10) |> round(1)";
      const { typescript, result } = await compileAndEval<number>(code);

      expect(typescript).toContain('import { clamp, round } from "es-toolkit";');
      expect(result).toBe(10);

      const code2 = "export result = 5.6789 |> clamp(0, 10) |> round(2)";
      const { result: res2 } = await compileAndEval<number>(code2);
      expect(res2).toBe(5.68);
    });

    it("supports array math utilities in pipelines", async () => {
      const code = "export result = [10, 20, 30, 40] |> sum";
      const { typescript, result } = await compileAndEval<number>(code);

      expect(typescript).toContain('import { sum } from "es-toolkit";');
      expect(result).toBe(100);

      const codeMean = "export result = [10, 20, 30] |> mean";
      const { result: resMean } = await compileAndEval<number>(codeMean);
      expect(resMean).toBe(20);
    });
  });

  describe("timing helpers with data-last calling conventions", () => {
    it("supports debounce in data-last pipelines", async () => {
      const code = "export result = ((x: Number) => x * 2) |> debounce(100)";
      const { typescript, result } = await compileAndEval<any>(code);

      expect(typescript).toContain('import { debounce } from "es-toolkit";');
      expect(typescript).toContain("(__p) => debounce(__p, 100)");
      expect(typeof result).toBe("function");
    });

    it("supports throttle in data-last pipelines", async () => {
      const code = "export result = ((x: Number) => x * 2) |> throttle(50)";
      const { typescript, result } = await compileAndEval<any>(code);

      expect(typescript).toContain('import { throttle } from "es-toolkit";');
      expect(typescript).toContain("(__p) => throttle(__p, 50)");
      expect(typeof result).toBe("function");
    });
  });

  describe("ambient direct calls outside pipelines", () => {
    it("resolves es-toolkit functions called directly without manual imports", async () => {
      const code = `
export title = slug("Direct Call")
export clamped = clamp(15, 0, 10)
export rounded = round(1.2345, 2)
export result = "{title}:{clamped}:{rounded}"
`;
      const { typescript, result } = await compileAndEval<string>(code);

      expect(typescript).toContain('import { clamp, kebabCase as slug, round } from "es-toolkit";');
      expect(result).toBe("direct-call:10:1.23");
    });

    it("does not duplicate imports when user explicitly imports from es-toolkit", async () => {
      const code = `
import { clamp } from "es-toolkit"
export result = 15 |> clamp(0, 10)
`;
      const { typescript, result } = await compileAndEval<number>(code);

      const matches = typescript.match(/from "es-toolkit"/g);
      expect(matches?.length).toBe(1);
      expect(result).toBe(10);
    });
  });
});
