import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { compileString } from "../src/compiler.js";
import { transformSync } from "esbuild";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const runFunScriptModule = async (code: string) => {
  const res = await Effect.runPromise(compileString(code));
  const transformed = transformSync(res.typescript, { loader: "ts", format: "esm" });
  const tmpFile = path.resolve(`.tmp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  await fs.writeFile(tmpFile, transformed.code, "utf-8");
  try {
    return await import(tmpFile);
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
};

describe("Runtime Schema Validation Helpers (schema.decode / schema.parse)", () => {
  it("emits companion decoding helpers on Schema.Struct definitions", async () => {
    const code = `
export schema User = {
  id: string
  name: string
  age: number
}
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain('import { Schema } from "effect";');
    expect(res.typescript).toContain("export const User = Object.assign(");
    expect(res.typescript).toContain("Schema.Struct({");
    expect(res.typescript).toContain("decode: (data: unknown) => Schema.decodeUnknown(User)(data)");
    expect(res.typescript).toContain("parse: (data: unknown) => Schema.decodeUnknownSync(User)(data)");
    expect(res.typescript).toContain("export type User = typeof User.Type;");
  });

  it("supports synchronous .parse(data) on valid and invalid data", async () => {
    const code = `
export schema User = {
  id: string
  name: string
  age: number
}
`.trim();

    const mod = await runFunScriptModule(code);
    expect(typeof mod.User.parse).toBe("function");
    expect(typeof mod.User.decode).toBe("function");

    // Valid data
    const valid = mod.User.parse({ id: "usr_1", name: "Alice", age: 30 });
    expect(valid).toEqual({ id: "usr_1", name: "Alice", age: 30 });

    // Invalid data throws Schema validation error
    expect(() => mod.User.parse({ id: "usr_1", name: "Alice", age: "thirty" })).toThrow();
    expect(() => mod.User.parse({ id: "usr_1" })).toThrow();
    expect(() => mod.User.parse(null)).toThrow();
  });

  it("supports Effect-based .decode(data) on valid and invalid data", async () => {
    const code = `
export schema User = {
  id: string
  name: string
  age: number
}
`.trim();

    const mod = await runFunScriptModule(code);

    // Valid data resolves in Effect
    const validEff = mod.User.decode({ id: "usr_2", name: "Bob", age: 25 });
    expect(Effect.isEffect(validEff)).toBe(true);

    const validUser = await Effect.runPromise(validEff);
    expect(validUser).toEqual({ id: "usr_2", name: "Bob", age: 25 });

    // Invalid data fails Effect with ParseError
    const invalidEff = mod.User.decode({ id: "usr_2", name: "Bob", age: "invalid" });
    expect(Effect.isEffect(invalidEff)).toBe(true);

    const failure = await Effect.runPromise(Effect.flip(invalidEff));
    expect(failure._tag).toBe("ParseError");
  });

  it("enables pipeline syntax 'data |> User.decode' and 'json |> User.parse'", async () => {
    const code = `
export schema User = {
  id: string
  name: string
}

export parseUser = (raw: unknown) -> raw |> User.parse
export decodeUser = (raw: unknown) -> raw |> User.decode
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain("pipe(\n  raw,\n  User.parse\n)");
    expect(res.typescript).toContain("pipe(\n  raw,\n  User.decode\n)");

    const mod = await runFunScriptModule(code);

    // Test pipeline parseUser
    const parsed = mod.parseUser({ id: "101", name: "Charlie" });
    expect(parsed).toEqual({ id: "101", name: "Charlie" });
    expect(() => mod.parseUser({ id: 101 })).toThrow();

    // Test pipeline decodeUser
    const decodedEff = mod.decodeUser({ id: "102", name: "Dana" });
    const decoded = await Effect.runPromise(decodedEff);
    expect(decoded).toEqual({ id: "102", name: "Dana" });

    const failed = await Effect.runPromise(Effect.flip(mod.decodeUser({})));
    expect(failed._tag).toBe("ParseError");
  });

  it("integrates seamlessly into Effect generator blocks with <- bind", async () => {
    const code = `
export schema Account = {
  id: string
  balance: number
}

export processAccount = (payload: unknown) ->
  effect
    acc <- Account.decode(payload)
    acc.balance * 2
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain("const acc = yield* Account.decode(payload);");

    const mod = await runFunScriptModule(code);
    const result = await Effect.runPromise(mod.processAccount({ id: "acc_1", balance: 50 }));
    expect(result).toBe(100);

    const fail = await Effect.runPromise(Effect.flip(mod.processAccount({ id: "acc_1", balance: "bad" })));
    expect(fail._tag).toBe("ParseError");
  });

  it("validates nested schemas and complex fields", async () => {
    const code = `
export schema Address = {
  city: string
  zip: string
}

export schema Customer = {
  name: string
  address: Address
}

export validateCustomer = (input: unknown) -> input |> Customer.parse
`.trim();

    const mod = await runFunScriptModule(code);

    const validCustomer = mod.validateCustomer({
      name: "Eve",
      address: {
        city: "Berlin",
        zip: "10115",
      },
    });
    expect(validCustomer).toEqual({
      name: "Eve",
      address: {
        city: "Berlin",
        zip: "10115",
      },
    });

    expect(() =>
      mod.validateCustomer({
        name: "Eve",
        address: {
          city: "Berlin",
          zip: 10115, // wrong type: number instead of string
        },
      })
    ).toThrow();
  });
});
