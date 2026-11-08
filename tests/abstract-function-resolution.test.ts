import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { compileString } from "../src/compiler.js";

const compile = async (code: string, filename = "test.fun") =>
  Effect.runPromise(compileString(code, filename));

describe("Type-Directed Abstract Function Resolution (TASK-076)", () => {
  it("resolves multiple bare stages on a custom abstraction and chains inferred output types", async () => {
    const code = `
ts {
  export interface HttpClient { readonly url: string; }
  export namespace HttpClient {
    export const Afn = (c: HttpClient): HttpResponse => ({ status: 200 });
  }
  export interface HttpResponse { readonly status: number; }
  export namespace HttpResponse {
    export const Bfn = (r: HttpResponse): string => "ok";
  }
}

export test = (c: HttpClient) => c |> Afn |> Bfn
`.trim();

    const result = await compile(code);
    expect(result.typescript).toContain("HttpClient.Afn");
    expect(result.typescript).toContain("HttpResponse.Bfn");
    expect(result.typescript).toContain("pipe(\n  c,\n  HttpClient.Afn,\n  HttpResponse.Bfn\n)");
  });

  it("resolves pipeline call stages with arguments on abstractions", async () => {
    const code = `
ts {
  export interface HttpClient { readonly url: string; }
  export namespace HttpClient {
    export const get = (path: string) => (c: HttpClient): HttpResponse => ({ status: 200, body: path });
  }
  export interface HttpResponse { readonly status: number; readonly body: string; }
  export namespace HttpResponse {
    export const json = (r: HttpResponse): string => r.body;
  }
}

export test = (c: HttpClient) => c |> get("/api/items") |> json
`.trim();

    const result = await compile(code);
    expect(result.typescript).toContain('HttpClient.get("/api/items")');
    expect(result.typescript).toContain("HttpResponse.json");
    expect(result.typescript).toContain('pipe(\n  c,\n  HttpClient.get("/api/items"),\n  HttpResponse.json\n)');
  });

  it("resolves score |> lessThan(deadline) against Number and lowers to Number.isLessThan", async () => {
    const code = `
export check = (score: Number, deadline: Number) => score |> lessThan(deadline)
export checkGt = (score: Number, limit: Number) => score |> greaterThan(limit)
export checkLte = (score: Number, bound: Number) => score |> lessThanOrEqualTo(bound)
export checkGte = (score: Number, bound: Number) => score |> greaterThanOrEqualTo(bound)
export checkBetween = (score: Number, min: Number, max: Number) => score |> between(min, max)
`.trim();

    const result = await compile(code);
    expect(result.typescript).toContain("import { Number, pipe } from \"effect\";");
    expect(result.typescript).toContain("pipe(\n  score,\n  Number.isLessThan(deadline)\n)");
    expect(result.typescript).toContain("pipe(\n  score,\n  Number.isGreaterThan(limit)\n)");
    expect(result.typescript).toContain("pipe(\n  score,\n  Number.isLessThanOrEqualTo(bound)\n)");
    expect(result.typescript).toContain("pipe(\n  score,\n  Number.isGreaterThanOrEqualTo(bound)\n)");
    expect(result.typescript).toContain("pipe(\n  score,\n  Number.between(min, max)\n)");
  });

  it("resolves timestamp |> lessThan(deadline) against DateTime and lowers to DateTime.isLessThan", async () => {
    const code = `
import { DateTime } from "effect"

export isBefore = (t: DateTime.Utc, deadline: DateTime.Utc) => t |> lessThan(deadline)
export isAfter = (t: DateTime.Utc, deadline: DateTime.Utc) => t |> greaterThan(deadline)
`.trim();

    const result = await compile(code);
    expect(result.typescript).toContain("DateTime.isLessThan(deadline)");
    expect(result.typescript).toContain("DateTime.isGreaterThan(deadline)");
  });

  it("resolves direct comparison calls preserving argument order", async () => {
    const code = `
export directNum = (score: Number, deadline: Number) => lessThan(score, deadline)
export directGt = (score: Number, deadline: Number) => greaterThan(score, deadline)
export directLte = (score: Number, deadline: Number) => lessThanOrEqualTo(score, deadline)
export directGte = (score: Number, deadline: Number) => greaterThanOrEqualTo(score, deadline)
export directBetween = (score: Number, min: Number, max: Number) => between(score, min, max)
`.trim();

    const result = await compile(code);
    expect(result.typescript).toContain("Number.isLessThan(score, deadline)");
    expect(result.typescript).toContain("Number.isGreaterThan(score, deadline)");
    expect(result.typescript).toContain("Number.isLessThanOrEqualTo(score, deadline)");
    expect(result.typescript).toContain("Number.isGreaterThanOrEqualTo(score, deadline)");
    expect(result.typescript).toContain("Number.between(score, min, max)");
  });

  it("resolves direct comparison calls on DateTime", async () => {
    const code = `
import { DateTime } from "effect"

export isBefore = (t: DateTime.Utc, deadline: DateTime.Utc) => lessThan(t, deadline)
`.trim();

    const result = await compile(code);
    expect(result.typescript).toContain("DateTime.isLessThan(t, deadline)");
  });

  it("reports actionable diagnostic for missing function on abstraction", async () => {
    const code = `
ts {
  export interface HttpClient { readonly url: string; }
  export namespace HttpClient {
    export const Afn = (c: HttpClient): string => "ok";
  }
}

export test = (c: HttpClient) => c |> NonExistentFn
`.trim();

    await expect(compile(code)).rejects.toThrow(
      "NonExistentFn cannot be resolved for HttpClient. Explicit Module.NonExistentFn qualification is available.",
    );
  });

  it("reports diagnostic for comparison on non-ordered operand", async () => {
    const code = `export test = (name: String, other: String) => name |> lessThan(other)`;
    await expect(compile(code)).rejects.toThrow(
      "< or comparison 'lessThan' is only available for supported ordered types (Number, DateTime); this operand has type string. Use Order.isLessThan(...) or an explicit domain Order. See docs/syntax.md#42-equality-and-comparisons.",
    );
  });

  it("reports diagnostic for direct comparison on non-ordered operand", async () => {
    const code = `export test = (name: String, other: String) => lessThan(name, other)`;
    await expect(compile(code)).rejects.toThrow(
      "comparison 'lessThan' is only available for supported ordered types (Number, DateTime); this operand has type string. Use Order.isLessThan(...) or an explicit domain Order. See docs/syntax.md#42-equality-and-comparisons.",
    );
  });

  it("preserves explicit Module.function qualification as an escape hatch", async () => {
    const code = `
ts {
  export interface HttpClient { readonly url: string; }
  export namespace HttpClient {
    export const Afn = (c: HttpClient): HttpResponse => ({ status: 200 });
  }
  export interface HttpResponse { readonly status: number; }
  export namespace HttpResponse {
    export const Bfn = (r: HttpResponse): string => "ok";
  }
}

export test = (c: HttpClient) => c |> HttpClient.Afn |> HttpResponse.Bfn
`.trim();

    const result = await compile(code);
    expect(result.typescript).toContain("pipe(\n  c,\n  HttpClient.Afn,\n  HttpResponse.Bfn\n)");
  });
});
