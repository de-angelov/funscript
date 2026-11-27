import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { execute, typeCheck, expectCompileError } from "./helpers/index.js";
import { format } from "../src/formatter/index.js";

const source = `import { Effect } from "effect"
error Missing(message: String)
error Offline(message: String)
export recover = (value: Effect<String, Missing | Offline>) =>
  value
  |> catch
    | Missing(cause) => Effect.succeed(cause.message)
  |> Effect.map((text) => text + "!")`;

describe("catch pipeline", () => {
  it("allows catch inside a match arm", async () => {
    const nested = `import { Effect, Option } from "effect"
error Missing(message: String)
export recover = (opt: Option<Effect<String, Missing>>) =>
  match opt
    | None => Effect.succeed("none")
    | Some(value) => value |> catch
        | Missing => Effect.succeed("missing")`;
    const checked = await typeCheck(nested, "catch-in-match.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
  });
  it("recovers a tag, preserves other failures, and composes with later stages", async () => {
    const checked = await typeCheck(source, "catch-pipeline.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { recover } = await execute(source);
    expect(Effect.runSync(recover(Effect.succeed("ok")))).toBe("ok!");
    expect(
      Effect.runSync(
        recover(Effect.fail({ _tag: "Missing", message: "found" })),
      ),
    ).toBe("found!");
    const exit = Effect.runSyncExit(
      recover(Effect.fail({ _tag: "Offline", message: "down" })),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("rejects invalid catch patterns and duplicate tags", async () => {
    await expectCompileError(
      "x = Effect.void |> catch\n  | _ => Effect.void",
      /Catch arms require/,
    );
    await expectCompileError(
      "x = Effect.void |> catch\n  | Missing => Effect.void\n  | Missing => Effect.void",
      /Duplicate tag/,
    );
  });

  it("checks tags, handler results, and the remaining error type", async () => {
    const wrongTag = await typeCheck(
      source.replace("Missing(cause) =>", "UnknownTag(cause) =>"),
      "catch-unknown.fun",
    );
    expect(wrongTag.success).toBe(false);
    const pureHandler = await typeCheck(
      source.replace("Effect.succeed(cause.message)", "cause.message"),
      "catch-pure.fun",
    );
    expect(pureHandler.success).toBe(false);
    const wrongField = await typeCheck(
      source.replace("cause.message", "cause.noSuchField"),
      "catch-field.fun",
    );
    expect(wrongField.success).toBe(false);
    const remaining = await typeCheck(
      source +
        `
ts {
  const remaining: Effect.Effect<string, Offline> = recover(Effect.fail(new Offline({ message: "down" })));
  const impossible: Effect.Effect<string, never> = recover(Effect.fail(new Offline({ message: "down" })));
}`,
      "catch-remaining.fun",
    );
    expect(remaining.success).toBe(false);
    expect(remaining.formattedOutput).toContain("impossible");
  });

  it("handles multiple tags and leaves defects untouched", async () => {
    const multiple = source.replace(
      '  |> Effect.map((text) => text + "!")',
      '    | Offline => Effect.succeed("offline")\n  |> Effect.map((text) => text + "!")',
    );
    const checked = await typeCheck(multiple, "catch-multiple.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { recover } = await execute(multiple);
    expect(
      Effect.runSync(
        recover(Effect.fail({ _tag: "Offline", message: "down" })),
      ),
    ).toBe("offline!");
    expect(
      Exit.isFailure(Effect.runSyncExit(recover(Effect.die("defect")))),
    ).toBe(true);
  });

  it("formats catch syntax idempotently", () => {
    const formatted = format(source);
    expect(formatted).toContain("|> catch");
    expect(format(formatted)).toBe(formatted);
  });

  it("supports standalone catch (eff) and catch eff with Tag(_) and OrPattern tags", async () => {
    const standalone = `import { Effect } from "effect"
error Missing(message: String)
error Offline(message: String)
export recoverParen = (value: Effect<String, Missing | Offline>) =>
  catch (value)
    | Missing(cause) => Effect.succeed(cause.message)
    | Offline(_) => Effect.succeed("offline")
export recoverBoth = (value: Effect<String, Missing | Offline>) =>
  catch value
    | Missing(cause) | Offline(cause) => Effect.succeed(cause.message)`;
    const checked = await typeCheck(standalone, "catch-standalone.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { recoverParen, recoverBoth } = await execute(standalone);
    expect(
      Effect.runSync(
        recoverParen(Effect.fail({ _tag: "Missing", message: "m" })),
      ),
    ).toBe("m");
    expect(
      Effect.runSync(
        recoverParen(Effect.fail({ _tag: "Offline", message: "o" })),
      ),
    ).toBe("offline");
    expect(
      Effect.runSync(
        recoverBoth(Effect.fail({ _tag: "Offline", message: "down" })),
      ),
    ).toBe("down");
    const formatted = format(standalone);
    expect(formatted).toContain("catch value");
    expect(formatted).toContain("| Missing(cause) | Offline(cause) =>");
    expect(format(formatted)).toBe(formatted);
  });

  it("rejects standalone catch without scrutinee, duplicate tags in OrPattern, and when guards", async () => {
    await expectCompileError(
      "x = catch\n  | Missing => Effect.void",
      /Expected Effect expression after 'catch'/,
    );
    await expectCompileError(
      "x = Effect.void |> catch\n  | Missing | Missing => Effect.void",
      /Duplicate tag/,
    );
    await expectCompileError(
      'x = Effect.void |> catch\n  | Missing(e) when e.message #= "x" => Effect.void',
      /guards are not supported/,
    );
  });
});
