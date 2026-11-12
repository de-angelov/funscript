import { describe, expect, it } from "vitest";
import { compile, execute, typeCheck } from "./helpers/index.js";

describe("FunScript Language Features", () => {
  describe("Feature 1: Contextual Literal Preservation in Record Expressions", () => {
    it("preserves boolean literals as const in record expressions for discriminated unions", async () => {
      const source = `
export okRes = { ok: true, dataValue: "hello" }
export errRes = { ok: false, error: "something went wrong" }
export getStatus = (r: { ok: true, dataValue: String } | { ok: false, error: String }) => {
  match r.ok
    | true => "success"
    | false => "error"
}
export testOk = getStatus(okRes)
export testErr = getStatus(errRes)
`;
      const compiled = await compile(source);
      expect(compiled.typescript).toContain("ok: true as const");
      expect(compiled.typescript).toContain("ok: false as const");

      const checked = await typeCheck(source, "literal-preservation-bool.fun");
      expect(checked.success, checked.formattedOutput).toBe(true);

      const { testOk, testErr } = await execute(source);
      expect(testOk).toBe("success");
      expect(testErr).toBe("error");
    });

    it("preserves string and number literals for common discriminant keys", async () => {
      const source = `
export loading = { _tag: "Loading" }
export success = { _tag: "Success", value: 42 }
export action = { type: "click", kind: "primary", status: 200 }
`;
      const compiled = await compile(source);
      expect(compiled.typescript).toContain('_tag: "Loading" as const');
      expect(compiled.typescript).toContain('_tag: "Success" as const');
      expect(compiled.typescript).toContain('type: "click" as const');
      expect(compiled.typescript).toContain('kind: "primary" as const');
      expect(compiled.typescript).toContain("status: 200 as const");

      const checked = await typeCheck(source, "literal-preservation-discriminants.fun");
      expect(checked.success, checked.formattedOutput).toBe(true);
    });
  });

  describe("Feature 2: Lifting Optional Record Parameter Restriction for Record Spreads", () => {
    it("permits spreading a record parameter with optional fields into a new record", async () => {
      const source = `
export withDefaults = (opts: { order?: String, limit?: Number } = {}) => {
  base = { ...opts, fallback: true }
  => base
}
export testEmpty = withDefaults({})
export testProvided = withDefaults({ order: "desc", limit: 10 })
`;
      const compiled = await compile(source);
      expect(compiled.typescript).toContain("...opts");

      const checked = await typeCheck(source, "spread-optional-record.fun");
      expect(checked.success, checked.formattedOutput).toBe(true);

      const { testEmpty, testProvided } = await execute(source);
      expect(testEmpty.fallback).toBe(true);
      expect(testProvided.order).toBe("desc");
      expect(testProvided.limit).toBe(10);
      expect(testProvided.fallback).toBe(true);
    });
  });

  describe("Feature 3: Generic Tagged Unions in schema declarations", () => {
    it("emits generic type parameters and constructors for generic tagged unions", async () => {
      const source = `
export schema RemoteData<D, E> =
  | Loading
  | Success(value: D)
  | Failure(err: E)

export load = Loading
export succ = Success(42)
export fail = Failure("network error")

export render = (r: RemoteData<Number, String>) => {
  match r
    | Loading => "loading..."
    | Success(d) => "success"
    | Failure(e) => e
}

export getNumber = (r: RemoteData<Number, String>) => {
  match r
    | Loading => 0
    | Success(d) => d
    | Failure(_) => -1
}

export testLoad = render(load)
export testSucc = render(succ)
export testFail = render(fail)
export testNum = getNumber(succ)
`;
      const compiled = await compile(source);
      expect(compiled.typescript).toContain("export type RemoteData<D, E> = Data.TaggedEnum<{");
      expect(compiled.typescript).toContain("const $RemoteData = Data.taggedEnum<RemoteData<any, any>>();");
      expect(compiled.typescript).toContain("export const Loading: RemoteData<never, never> = $RemoteData.Loading();");
      expect(compiled.typescript).toContain("export const Success = <D, E = never>(value: D): RemoteData<D, E> => $RemoteData.Success({ value });");
      expect(compiled.typescript).toContain("export const Failure = <E, D = never>(err: E): RemoteData<D, E> => $RemoteData.Failure({ err });");

      const checked = await typeCheck(source, "generic-tagged-unions.fun");
      expect(checked.success, checked.formattedOutput).toBe(true);

      const { testLoad, testSucc, testFail, testNum } = await execute(source);
      expect(testLoad).toBe("loading...");
      expect(testSucc).toBe("success");
      expect(testFail).toBe("network error");
      expect(testNum).toBe(42);
    });
  });

  describe("Feature 4: Exhaustive Boolean Match Lowering", () => {
    it("lowers exhaustive boolean match to ts-pattern otherwise arm without NonExhaustiveError", async () => {
      const source = `
export checkBool = (flag: Boolean) => {
  match flag
    | true => "it is true"
    | false => "it is false"
}
export testT = checkBool(true)
export testF = checkBool(false)
`;
      const compiled = await compile(source);
      expect(compiled.typescript).toContain(".with(true, () =>");
      expect(compiled.typescript).toContain(".otherwise(() =>");
      expect(compiled.typescript).not.toContain(".exhaustive()");

      const checked = await typeCheck(source, "boolean-exhaustive-match.fun");
      expect(checked.success, checked.formattedOutput).toBe(true);

      const { testT, testF } = await execute(source);
      expect(testT).toBe("it is true");
      expect(testF).toBe("it is false");
    });

    it("lowers exhaustive boolean match with false first correctly", async () => {
      const source = `
export invert = (flag: Boolean) => {
  match flag
    | false => 0
    | true => 1
}
export t0 = invert(false)
export t1 = invert(true)
`;
      const compiled = await compile(source);
      expect(compiled.typescript).toContain(".with(false, () =>");
      expect(compiled.typescript).toContain(".otherwise(() =>");
      expect(compiled.typescript).not.toContain(".exhaustive()");

      const checked = await typeCheck(source, "boolean-exhaustive-false-first.fun");
      expect(checked.success, checked.formattedOutput).toBe(true);

      const { t0, t1 } = await execute(source);
      expect(t0).toBe(0);
      expect(t1).toBe(1);
    });

    it("lowers guarded boolean match followed by exhaustive arms correctly", async () => {
      const source = `
export evaluate = (flag: Boolean, debug: Boolean) => {
  match flag
    | true when debug => "debug-true"
    | true => "normal-true"
    | false => "false"
}
export r1 = evaluate(true, true)
export r2 = evaluate(true, false)
export r3 = evaluate(false, false)
`;
      const compiled = await compile(source);
      expect(compiled.typescript).toContain(".with(true,");
      expect(compiled.typescript).toContain(".otherwise(() =>");
      expect(compiled.typescript).not.toContain(".exhaustive()");

      const checked = await typeCheck(source, "boolean-guarded-match.fun");
      expect(checked.success, checked.formattedOutput).toBe(true);

      const { r1, r2, r3 } = await execute(source);
      expect(r1).toBe("debug-true");
      expect(r2).toBe("normal-true");
      expect(r3).toBe("false");
    });
  });

  describe("Feature 5: Universal dbg Pipeline & Expression Inspection", () => {
    it("transparently inspects values in pipelines with and without labels", async () => {
      const source = `
import { Array } from "effect"

export doubleEvens = (numbers: Array<Number>): Array<Number> => {
  evens = numbers |> Array.filter((n: Number) => n % 2 #= 0) |> dbg("evens") |> Array.map((n: Number) => n * 2) |> dbg
  => evens
}

export result = doubleEvens([1, 2, 3, 4, 5, 6])
`;
      const compiled = await compile(source);
      expect(compiled.typescript).toContain('console.log("evens", __v)');
      expect(compiled.typescript).toContain("console.log(__v)");

      const checked = await typeCheck(source, "pipeline-dbg.fun");
      expect(checked.success, checked.formattedOutput).toBe(true);

      const { result } = await execute(source);
      expect(result).toEqual([4, 8, 12]);
    });

    it("supports standalone dbg expressions", async () => {
      const source = `
export a = dbg(123)
export b = dbg("my-label", "hello")
export c = [1, 2, 3] |> dbg
`;
      const compiled = await compile(source);
      expect(compiled.typescript).toContain("console.log(__v)");
      expect(compiled.typescript).toContain('console.log("my-label", __v)');

      const checked = await typeCheck(source, "standalone-dbg.fun");
      expect(checked.success, checked.formattedOutput).toBe(true);

      const { a, b, c } = await execute(source);
      expect(a).toBe(123);
      expect(b).toBe("hello");
      expect(c).toEqual([1, 2, 3]);
    });
  });
});
