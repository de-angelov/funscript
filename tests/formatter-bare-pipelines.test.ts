import { describe, expect, it } from "vitest";
import { format } from "../src/formatter/index.js";
import { compile } from "./helpers/index.js";

const filename = `${process.cwd()}/formatter-bare.fun`;

describe("formatter bare pipelines", () => {
  it("shortens safely resolved ordinary and deferred stages", async () => {
    const source = `import { Effect, String } from "effect"
export trimmed = "hello" |> String.trim
export delayed = "hello" |>> Effect.sync
export attempted = "hello" |>> Effect.try`;
    const formatted = format(source, { filename });
    expect(formatted).toContain('"hello" |> trim');
    expect(formatted).toContain('"hello" |>> sync');
    expect(formatted).toContain('"hello" |>> try');
    expect(format(formatted, { filename })).toBe(formatted);
    const before = await compile(source, filename);
    const after = await compile(formatted, filename);
    expect(after.typescript).toBe(before.typescript);
  }, 60000);

  it("keeps qualified stages when local names shadow them", () => {
    const source = `import { Effect, String } from "effect"
trim = (value: String) => value
sync = (value: () => String) => value()
export x = "hi" |> String.trim
export y = "hi" |>> Effect.sync`;
    const formatted = format(source, { filename });
    expect(formatted).toContain("|> String.trim");
    expect(formatted).toContain("|>> Effect.sync");
  }, 60000);

  it("retains qualified names that are language keywords", () => {
    const source = `import { Option } from "effect"
export value = Option.some(1) |> Option.match({ onNone: () => 0, onSome: (n) => n })`;
    const formatted = format(source, { filename });
    expect(formatted).toContain("|> Option.match(");
    expect(format(formatted, { filename })).toBe(formatted);
  }, 60000);
});
