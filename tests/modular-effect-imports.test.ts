import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { compileString } from "../src/compiler.js";

describe("Modular Subpath Import Emission for Effect", () => {
  it("lowers user imports from 'effect' to modular subpaths when modularEffectImports is true", async () => {
    const source = `
import { Console, Effect, pipe } from "effect"

export main =
  pipe(
    Effect.succeed(42),
    Effect.flatMap((n) => Console.log("Value: " + n))
  )
`.trim();

    const result = await Effect.runPromise(
      compileString(source, "main.fun", { modularEffectImports: true }),
    );

    expect(result.typescript).not.toContain('from "effect";');
    expect(result.typescript).toContain(
      'import * as Console from "effect/Console";',
    );
    expect(result.typescript).toContain(
      'import * as Effect from "effect/Effect";',
    );
    expect(result.typescript).toContain(
      'import { pipe } from "effect/Function";',
    );
  });

  it("emits compiler-generated header imports as modular subpaths", async () => {
    // Declaring a schema triggers compiler Schema emission
    const source = `
schema User = { name?: String }
export getName = (u: User) => u.name
`.trim();

    const result = await Effect.runPromise(
      compileString(source, "user.fun", { modularEffectImports: true }),
    );

    expect(result.typescript).not.toContain('import { Schema } from "effect";');
    expect(result.typescript).toContain(
      'import * as Schema from "effect/Schema";',
    );
  });

  it("handles type-only imports to modular subpaths", async () => {
    const source = `
import type { Effect, Scope } from "effect"

export run = (e: Effect, s: Scope) => 42
`.trim();

    const result = await Effect.runPromise(
      compileString(source, "scope.fun", { modularEffectImports: true }),
    );

    expect(result.typescript).toContain(
      'import type { Effect } from "effect/Effect";',
    );
    expect(result.typescript).toContain(
      'import type { Scope } from "effect/Scope";',
    );
  });

  it("preserves standard barrel imports when modularEffectImports is false", async () => {
    const source = `
import { Console, pipe } from "effect"
export main = pipe("hello", Console.log)
`.trim();

    const result = await Effect.runPromise(
      compileString(source, "default.fun", { modularEffectImports: false }),
    );

    expect(result.typescript).toContain(
      'import { Console, pipe } from "effect";',
    );
  });

  it("supports multiple Effect modules alongside function utilities", async () => {
    const source = `
import { Array, Option, pipe, flow } from "effect"

export doubleFirst = (nums: Array<Number>) =>
  pipe(
    nums,
    Array.head,
    Option.map((n) => n * 2)
  )
`.trim();

    const result = await Effect.runPromise(
      compileString(source, "utils.fun", { modularEffectImports: true }),
    );

    expect(result.typescript).toContain(
      'import * as Array from "effect/Array";',
    );
    expect(result.typescript).toContain(
      'import * as Option from "effect/Option";',
    );
    expect(result.typescript).toContain(
      'import { pipe, flow } from "effect/Function";',
    );
  });
});
