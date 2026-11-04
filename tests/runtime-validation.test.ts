import { describe, expect, it } from "vitest";
import { Effect, Schema, pipe } from "effect";
import ts from "typescript";
import { compileString } from "../src/compiler.js";

const evaluate = async (source: string, names: string[]) => {
  const result = await Effect.runPromise(compileString(source));
  const code = ts.transpile(result.typescript, { module: ts.ModuleKind.ESNext })
    .replace(/^export const /gm, "const ")
    .replace(/^export \{.*\};?\n/gm, "")
    .replace(/^export type .*;\n/gm, "")
    .replace(/^import .* from "effect";\n/gm, "")
    .replace(/^export const /gm, "const ")
    .replace(/^export type .*;\n/gm, "");
  const executable = code.replace(/\bexport\s+/g, "");
  const schemaProxy = new Proxy(Schema, {
    get(target, prop, receiver) {
      if (prop === "decodeUnknown") {
        return (target as any).decodeUnknownEffect;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return new Function("Effect", "Schema", "pipe", `${executable}; return { ${names.join(", ")} };`)(Effect, schemaProxy, pipe) as Record<string, (...args: unknown[]) => unknown>;
};

describe("runtime boundary validation", () => {
  it("validates exported JavaScript function arguments before running the body", async () => {
    const { greet } = await evaluate(`
export js greet = (name: String) =>
  effect
    => "Hello, " + name
`, ["greet"]);

    await expect(greet("Ada")).resolves.toBe("Hello, Ada");
    expect(() => greet(42)).toThrow(/Expected string/);
  });

  it("provides runtime-validating constructors for record schemas", async () => {
    const { UserFromUnknown } = await evaluate(`
export schema User = {
  name: String
}
`, ["UserFromUnknown"]);

    expect(UserFromUnknown({ name: "Ada" })).toEqual({ name: "Ada" });
    expect(() => UserFromUnknown({ name: 42 })).toThrow(/Expected string/);
  });

  it("compiles dict |> decode(TargetSchema) to Schema.decodeUnknown and safely decodes payloads", async () => {
    const source = `
schema VotePayload = {
  countryCode: String
  voteType: String
}

export parseVote = (dict: Unknown) =>
  => dict |> decode(VotePayload)
`;
    const result = await Effect.runPromise(compileString(source));
    expect(result.typescript).toContain("Schema.decodeUnknown(VotePayload)");

    const { parseVote } = await evaluate(source, ["parseVote"]);
    const valid = await Effect.runPromise(parseVote({ countryCode: "BG", voteType: "upvote" }) as Effect.Effect<any, any>);
    expect(valid).toEqual({ countryCode: "BG", voteType: "upvote" });

    const failure = await Effect.runPromise(Effect.flip(parseVote({ countryCode: 123, voteType: "upvote" }) as Effect.Effect<any, any>));
    expect(failure).toBeDefined();
    expect(failure._tag).toBe("SchemaError");
  });

  it("supports decoding untrusted payloads directly inside effect blocks", async () => {
    const source = `
schema VotePayload = {
  countryCode: String
  voteType: String
}

export processVote = (dict: Unknown) =>
  effect {
    payload <- dict |> decode(VotePayload)
    => payload.countryCode
  }
`;
    const result = await Effect.runPromise(compileString(source));
    expect(result.typescript).toContain("Schema.decodeUnknown(VotePayload)");

    const { processVote } = await evaluate(source, ["processVote"]);
    const country = await Effect.runPromise(processVote({ countryCode: "US", voteType: "vote" }) as Effect.Effect<any, any>);
    expect(country).toBe("US");

    const failure = await Effect.runPromise(Effect.flip(processVote({ countryCode: 42, voteType: "vote" }) as Effect.Effect<any, any>));
    expect(failure).toBeDefined();
    expect(failure._tag).toBe("SchemaError");
  });
});
