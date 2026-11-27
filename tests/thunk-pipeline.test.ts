import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { execute, typeCheck } from "./helpers/index.js";
import { format } from "../src/formatter/index.js";

describe("deferred pipeline", () => {
  it("defers the complete preceding pipeline and runs it on every execution", async () => {
    const source = `ts { declare function next(): number }
addOne = (value: Number) => value + 1
export program = next() |> addOne |>> sync |> map((value) => value * 2)`;
    const checked = await typeCheck(source, "thunk-pipe.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    let count = 0;
    const { program } = await execute(source, {
      scope: { next: () => ++count },
    });
    expect(count).toBe(0);
    expect(Effect.runSync(program)).toBe(4);
    expect(Effect.runSync(program)).toBe(6);
    expect(count).toBe(2);
  });

  it("uses user-defined thunk functions and round-trips formatting", async () => {
    const source = `applyThunk = (f: () => Number) => f()
export result = 21 |>> applyThunk`;
    const checked = await typeCheck(source, "thunk-custom.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { result } = await execute(source);
    expect(result).toBe(21);
    expect(format(source)).toContain("|>>");
    expect(format(format(source))).toBe(format(source));
  });

  it("resolves bare try and preserves thrown errors as typed failures", async () => {
    const source = `ts { declare function risky(): number }
export program = risky() |>> try
export recovered = risky() |>> try |> orDie`;
    const checked = await typeCheck(source, "thunk-try.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    let count = 0;
    const { program } = await execute(source, {
      scope: {
        risky: () => {
          count++;
          throw new Error("bad");
        },
      },
    });
    expect(count).toBe(0);
    expect(Effect.runSyncExit(program)._tag).toBe("Failure");
    expect(count).toBe(1);
  });

  it("supports promises and rejects functions that do not accept a thunk", async () => {
    const source = `ts { declare function load(): Promise<string> }
export program = load() |>> promise`;
    const checked = await typeCheck(source, "thunk-promise.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    let count = 0;
    const { program } = await execute(source, {
      scope: {
        load: () => {
          count++;
          return Promise.resolve("ok");
        },
      },
    });
    expect(count).toBe(0);
    expect(await Effect.runPromise(program)).toBe("ok");
    expect(count).toBe(1);
    const invalid = await typeCheck(
      "f = (n: Number) => n\nexport invalid = 1 |>> f",
      "thunk-invalid.fun",
    );
    expect(invalid.success).toBe(false);
  });

  it("uses a local stage named sync instead of the Effect constructor", async () => {
    const source = `sync = (f: () => Number) => f() + 2
export result = 3 |>> sync`;
    const checked = await typeCheck(source, "thunk-shadow.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { result } = await execute(source);
    expect(result).toBe(5);
  });
});
