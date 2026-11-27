import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { compileString } from "../src/compiler.js";
import { typeCheckSource } from "../src/compiler/check.js";

describe("type-directed constructor calls (auto new)", () => {
  it("emits new TextEncoder() and new Uint8Array() without ts {}", async () => {
    const code = `export encodeUtf8 = (value: String) => TextEncoder().encode(value)
export makeBytes = (len: Number) => Uint8Array(len)`;
    const compiled = await Effect.runPromise(
      compileString(code, "web-ctors.fun"),
    );
    expect(compiled.typescript).toContain("new TextEncoder().encode(value)");
    expect(compiled.typescript).toContain("new Uint8Array(len)");
    const checked = await Effect.runPromise(
      typeCheckSource(code, "web-ctors.fun"),
    );
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("emits new for construct-only TypeScript classes", async () => {
    const code = `ts {
export class Box<T> { constructor(public readonly value: T) {} }
}
export makeBox = (v: String) => Box(v)`;
    const compiled = await Effect.runPromise(
      compileString(code, "ts-ctor.fun"),
    );
    expect(compiled.typescript).toContain("new Box(v)");
    const checked = await Effect.runPromise(
      typeCheckSource(code, "ts-ctor.fun"),
    );
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("does not emit new for ordinary functions or FunScript error constructors", async () => {
    const code = `error Boom(message: String)
helper = (x: Number) => x + 1
export run = () =>
  err = Boom({ message: "fail" })
  => helper(1)`;
    const compiled = await Effect.runPromise(
      compileString(code, "non-ctors.fun"),
    );
    expect(compiled.typescript).not.toContain("new Boom(");
    expect(compiled.typescript).not.toContain("new helper(");
  });
});
