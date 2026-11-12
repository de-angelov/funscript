import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { compileString } from "../src/compiler.js";

describe("Type Ergonomics & Non-Escaping Types", () => {
  it("compiles typeof expressions in type positions", () => {
    const src = `
export buttonVariants = { variant: "default" }
export schema ButtonProps = VariantProps<typeof buttonVariants>
export fn cn(...inputs: Parameters<typeof cx>): String => ""
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("typeof buttonVariants");
    expect(res.typescript).toContain("Parameters<typeof cx>");
  });

  it("compiles indexed access types and parenthesized type queries", () => {
    const src = `
supportedLogLevels = ["debug", "info"]
export schema SupportedLogLevel = (typeof supportedLogLevels)[Number]
export schema DebugParams = Parameters<PinoLogger["debug"]>
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("(typeof supportedLogLevels)[number]");
    expect(res.typescript).toContain('PinoLogger["debug"]');
  });

  it("compiles generic record contracts with qualified types without throwing", () => {
    const src = `
export schema RedisClientProviderOptions<Client> = {
  env?: NodeJS.ProcessEnv
  clientFactory: (config: RedisConfig) => Client
}
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("export type RedisClientProviderOptions<Client> = { readonly env?: NodeJS.ProcessEnv; readonly clientFactory: (config: RedisConfig) => Client }");
  });

  it("compiles Any, Null, and Undefined primitive types", () => {
    const src = `
export schema FlexibleError = Any
export schema NullableResult = String | Null
export schema OptionalParam = Number | Undefined
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("export type FlexibleError = any;");
    expect(res.typescript).toContain("string | null");
    expect(res.typescript).toContain("number | undefined");
  });

  it("compiles Option.fromNullishOrElse with eager values", () => {
    const src = `
import { Option } from "effect"

export testFn = (raw: Unknown, opt: Option<String>) =>
  a = Option.fromNullishOrElse(raw, "default")
  b = Option.fromNullishOrElse(opt, "fallback")
  => [a, b]
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("__funscriptOptionFromNullishOrElse");
    expect(res.typescript).toContain('__funscriptOptionFromNullishOrElse(raw, "default")');
    expect(res.typescript).toContain('__funscriptOptionFromNullishOrElse(opt, "fallback")');
  });
});
