import { describe, expect, it } from "vitest";
import { Effect, Schema, Data, pipe, Array as EffectArray, Context, Layer } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import ts from "typescript";
import { compileString } from "../src/compiler.js";
import { assertFormattingIdempotent } from "./helpers/conformance.js";

const CONFORMANCE_ROOT = path.resolve("tests/fixtures/conformance");
const RULE_DIRECTORIES = [
  "explicit-returns",
  "numeric-comparisons",
  "pipelines",
  "schemas",
  "extern-services",
] as const;

const ContextCompat = new Proxy(Context, {
  get(target, prop, receiver) {
    if (prop === "GenericTag") {
      return (key: string) => (Context as any).Service()(key);
    }
    return Reflect.get(target, prop, receiver);
  },
});

const SchemaCompat = new Proxy(Schema, {
  get(target, prop, receiver) {
    if (prop === "decodeUnknown") {
      return (target as any).decodeUnknownEffect;
    }
    return Reflect.get(target, prop, receiver);
  },
});

function evalModule(
  typescript: string,
  exportsToReturn: string[],
  scope?: Record<string, any>,
) {
  const js = ts
    .transpile(typescript, { module: ts.ModuleKind.ESNext })
    .replace(/^import\s+.*$/gm, "")
    .replace(/\bexport\s+/g, "");
  const baseScope: Record<string, any> = {
    Effect,
    Schema: SchemaCompat,
    Data,
    pipe,
    Array: EffectArray,
    Context: ContextCompat,
    Layer,
    ...(scope ?? {}),
  };
  const keys = Object.keys(baseScope);
  const values = Object.values(baseScope);
  const fn = new Function(
    ...keys,
    `${js}; return { ${exportsToReturn.join(", ")} };`,
  );
  return fn(...values);
}

async function verifyPositiveFixture(
  ruleDir: string,
  fixtureName: string,
  options?: {
    evalExports?: string[];
    scope?: Record<string, any>;
    verifyEval?: (exports: Record<string, any>) => Promise<void> | void;
  },
) {
  const fixturePath = path.join(ruleDir, `${fixtureName}.fun`);
  const expectedPath = path.join(ruleDir, `${fixtureName}.expected.ts`);

  const source = await fs.readFile(fixturePath, "utf-8");
  const expected = await fs.readFile(expectedPath, "utf-8");

  assertFormattingIdempotent(source);

  const result = await Effect.runPromise(compileString(source, fixturePath));
  expect(
    result.typescript.trim(),
    `Emitted TypeScript for fixture ${fixturePath} does not match ${expectedPath}`,
  ).toBe(expected.trim());

  if (options?.evalExports && options.verifyEval) {
    const exported = evalModule(result.typescript, options.evalExports, options?.scope);
    await options.verifyEval(exported);
  }
}

async function verifyNegativeFixture(ruleDir: string, fixtureName: string) {
  const fixturePath = path.join(ruleDir, `${fixtureName}.fun`);
  const expectedErrorPath = path.join(ruleDir, `${fixtureName}.expected.error`);

  const source = await fs.readFile(fixturePath, "utf-8");
  const expectedError = await fs.readFile(expectedErrorPath, "utf-8");

  let thrownError: any;
  try {
    await Effect.runPromise(compileString(source, fixturePath));
  } catch (err) {
    thrownError = err;
  }

  expect(
    thrownError,
    `Expected compilation of fixture ${fixturePath} to fail with an error`,
  ).toBeDefined();

  expect(
    thrownError.message.trim(),
    `Diagnostic message for fixture ${fixturePath} does not match ${expectedErrorPath}`,
  ).toBe(expectedError.trim());
}

describe("language conformance fixture suite", () => {
  describe("fixture organization and layout integrity", () => {
    it("verifies every rule directory has isolated positive and negative fixtures with adjacent expected files", async () => {
      for (const rule of RULE_DIRECTORIES) {
        const dir = path.join(CONFORMANCE_ROOT, rule);
        const entries = await fs.readdir(dir);
        const funFiles = entries.filter((f) => f.endsWith(".fun"));

        expect(
          funFiles.length,
          `Rule directory '${rule}' must contain at least 2 .fun fixture files (positive and negative)`,
        ).toBeGreaterThanOrEqual(2);

        let hasPositive = false;
        let hasNegative = false;

        for (const funFile of funFiles) {
          const base = funFile.slice(0, -4);
          const hasExpectedTs = entries.includes(`${base}.expected.ts`);
          const hasExpectedError = entries.includes(`${base}.expected.error`);

          expect(
            hasExpectedTs || hasExpectedError,
            `Fixture ${funFile} in ${rule} must have an adjacent .expected.ts or .expected.error file`,
          ).toBe(true);

          if (hasExpectedTs) hasPositive = true;
          if (hasExpectedError) hasNegative = true;
        }

        expect(
          hasPositive,
          `Rule directory '${rule}' must contain at least one positive fixture (.expected.ts)`,
        ).toBe(true);
        expect(
          hasNegative,
          `Rule directory '${rule}' must contain at least one negative fixture (.expected.error)`,
        ).toBe(true);
      }
    });
  });

  describe("Rule: Explicit Returns", () => {
    const dir = path.join(CONFORMANCE_ROOT, "explicit-returns");

    it("verifies effect block with explicit '=>' return compiles, matches expected TypeScript, and evaluates correctly", async () => {
      await verifyPositiveFixture(dir, "effect-block-explicit-return", {
        evalExports: ["compute"],
        verifyEval: async ({ compute }) => {
          const result = await Effect.runPromise(compute);
          expect(result).toBe(42);
        },
      });
    });

    it("verifies function block with explicit '=>' return compiles, matches expected TypeScript, and evaluates correctly", async () => {
      await verifyPositiveFixture(dir, "function-block-explicit-return", {
        evalExports: ["calculate"],
        verifyEval: ({ calculate }) => {
          expect(calculate(5)).toBe(12);
        },
      });
    });

    it("reports diagnostic when effect block is missing explicit '=>' return", async () => {
      await verifyNegativeFixture(dir, "missing-effect-return");
    });

    it("reports diagnostic when function block is missing explicit '=>' return", async () => {
      await verifyNegativeFixture(dir, "missing-function-return");
    });
  });

  describe("Rule: Numeric-Only Comparisons", () => {
    const dir = path.join(CONFORMANCE_ROOT, "numeric-comparisons");

    it("verifies numeric comparison compiles, matches expected TypeScript, and evaluates correctly", async () => {
      await verifyPositiveFixture(dir, "valid-numeric-comparison", {
        evalExports: ["inRange"],
        verifyEval: ({ inRange }) => {
          expect(inRange(50)).toBe(true);
          expect(inRange(-1)).toBe(false);
          expect(inRange(100)).toBe(false);
        },
      });
    });

    it("reports diagnostic when non-numeric operands are used with relational comparison operator", async () => {
      await verifyNegativeFixture(dir, "rejected-string-comparison");
    });
  });

  describe("Rule: Type-Directed Pipelines", () => {
    const dir = path.join(CONFORMANCE_ROOT, "pipelines");

    it("verifies explicitly qualified pipeline compiles, matches expected TypeScript, and evaluates correctly", async () => {
      await verifyPositiveFixture(dir, "explicit-qualification", {
        evalExports: ["apply"],
        verifyEval: ({ apply }) => {
          expect(apply([1, 2, 3])).toEqual([2, 3, 4]);
        },
      });
    });

    it("reports diagnostic for rejected ambiguous bare operation in pipeline", async () => {
      await verifyNegativeFixture(dir, "ambiguous-bare-operation");
    });
  });

  describe("Rule: Schemas", () => {
    const dir = path.join(CONFORMANCE_ROOT, "schemas");

    it("verifies record schema compiles, matches expected TypeScript, and decodes successfully", async () => {
      await verifyPositiveFixture(dir, "record-schema", {
        evalExports: ["UserFromUnknown"],
        verifyEval: ({ UserFromUnknown }) => {
          const decoded = UserFromUnknown({ id: "user-1", name: "Alice" });
          expect(decoded).toEqual({ id: "user-1", name: "Alice" });
          expect(() => UserFromUnknown({ id: 123 })).toThrow();
        },
      });
    });

    it("verifies tagged union schema compiles, matches expected TypeScript, and constructs variants", async () => {
      await verifyPositiveFixture(dir, "tagged-union-schema", {
        evalExports: ["Circle", "Rect"],
        verifyEval: ({ Circle, Rect }) => {
          const c = Circle(5);
          expect(c).toEqual({ _tag: "Circle", radius: 5 });
          const r = Rect(10, 20);
          expect(r).toEqual({ _tag: "Rect", width: 10, height: 20 });
        },
      });
    });

    it("reports diagnostic when deprecated 'type' keyword is used instead of 'schema'", async () => {
      await verifyNegativeFixture(dir, "rejected-type-keyword");
    });

    it("reports diagnostic when schema name is not UpperCamelCase", async () => {
      await verifyNegativeFixture(dir, "lowercase-schema-name");
    });
  });

  describe("Rule: Extern Services", () => {
    const dir = path.join(CONFORMANCE_ROOT, "extern-services");

    it("verifies extern service with ts schema and decode pipeline compiles, matches expected TypeScript, and evaluates correctly", async () => {
      const mockStripe = {
        constructEvent: (body: string, sig: string, secret: string) => {
          if (sig !== "valid_sig") {
            throw new Error("Invalid signature");
          }
          return { id: "evt_conformance_1", type: "payment_intent.succeeded" };
        },
      };

      await verifyPositiveFixture(dir, "extern-service-wrapper", {
        evalExports: ["processWebhook", "StripeClientLive"],
        scope: {
          __extern_stripe: mockStripe,
        },
        verifyEval: async ({ processWebhook, StripeClientLive }) => {
          // 1. Success case: decoded input feeds into extern service call
          const result = await Effect.runPromise(
            processWebhook({ payload: "event_data", signature: "valid_sig" }, "whsec_test").pipe(
              Effect.provide(StripeClientLive),
            ),
          );
          expect(result).toEqual({ id: "evt_conformance_1", type: "payment_intent.succeeded" });

          // 2. Exception case: SDK thrown exception is caught and yields typed Effect failure
          const failEffect = processWebhook(
            { payload: "event_data", signature: "invalid_sig" },
            "whsec_test",
          ).pipe(Effect.provide(StripeClientLive));
          const failure = await Effect.runPromise(Effect.flip(failEffect));
          expect(failure).toBeDefined();
          expect((failure as any).message).toBe("Invalid signature");

          // 3. Invalid decoded input: payload validation fails before extern service call
          const decodeFailEffect = processWebhook(
            { payload: 12345, signature: "valid_sig" },
            "whsec_test",
          ).pipe(Effect.provide(StripeClientLive));
          const decodeFailure = await Effect.runPromise(Effect.flip(decodeFailEffect));
          expect(decodeFailure).toBeDefined();
          expect((decodeFailure as any)._tag).toBe("SchemaError");
        },
      });
    });

    it("reports diagnostic when extern package name is missing", async () => {
      await verifyNegativeFixture(dir, "missing-extern-package");
    });
  });
});
