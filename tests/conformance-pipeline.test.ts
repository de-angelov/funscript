import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compileString } from "../src/compiler.js";

const FIXTURES_DIR = path.resolve("tests/fixtures/conformance/pipeline");

describe("type-directed pipeline resolution conformance", () => {
  it("verifies fixture files exist and have adjacent expected outcomes", async () => {
    const files = await fs.readdir(FIXTURES_DIR);
    const funFiles = files.filter((f) => f.endsWith(".fun"));
    expect(funFiles.length).toBeGreaterThanOrEqual(2);

    for (const funFile of funFiles) {
      const base = funFile.slice(0, -4);
      const hasAdjacentOutcome =
        files.includes(`${base}.expected.ts`) || files.includes(`${base}.expected.error`);
      expect(
        hasAdjacentOutcome,
        `Fixture ${funFile} in ${FIXTURES_DIR} must have an adjacent .expected.ts or .expected.error outcome`,
      ).toBe(true);
    }
  });

  it("compiles accepted explicitly qualified pipeline fixture", async () => {
    const fixturePath = path.join(FIXTURES_DIR, "explicit-qualification.fun");
    const expectedPath = path.join(FIXTURES_DIR, "explicit-qualification.expected.ts");

    const source = await fs.readFile(fixturePath, "utf-8");
    const expected = await fs.readFile(expectedPath, "utf-8");

    const result = await Effect.runPromise(compileString(source, fixturePath));

    expect(
      result.typescript.trim(),
      `Emitted TypeScript for fixture ${fixturePath} does not match ${expectedPath}`,
    ).toBe(expected.trim());

    // Meaningful emitted behavior assertions
    expect(
      result.typescript,
      `Emitted code for ${fixturePath} missing effect imports`,
    ).toContain('import { Array, pipe } from "effect";');
    expect(
      result.typescript,
      `Emitted code for ${fixturePath} missing pipe expression`,
    ).toContain("pipe(");
    expect(
      result.typescript,
      `Emitted code for ${fixturePath} missing Array.map call`,
    ).toContain("Array.map((item) => (item + 1))");

    // Execute emitted behavior to verify runtime semantics
    const { pipe, Array: EffectArray } = await import("effect");
    const evalCode = result.typescript
      .replace(/import .*\n/g, "")
      .replace(/export const /g, "const ");
    const fn = new Function("pipe", "Array", `${evalCode}; return { apply };`);
    const { apply } = fn(pipe, EffectArray);
    expect(apply([1, 2, 3])).toEqual([2, 3, 4]);
  });

  it("reports actionable diagnostic for rejected ambiguous bare operation fixture", async () => {
    const fixturePath = path.join(FIXTURES_DIR, "ambiguous-bare-operation.fun");
    const expectedErrorPath = path.join(FIXTURES_DIR, "ambiguous-bare-operation.expected.error");

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
      `Expected compilation of fixture ${fixturePath} to fail with an ambiguous pipeline diagnostic`,
    ).toBeDefined();

    expect(
      thrownError.message.trim(),
      `Diagnostic message for fixture ${fixturePath} does not match ${expectedErrorPath}`,
    ).toBe(expectedError.trim());

    expect(
      thrownError.message,
      `Diagnostic message for fixture ${fixturePath} must contain actionable suggestion`,
    ).toContain("map is ambiguous for this pipeline; write Array.map(...) or Option.map(...)");
  });
});
