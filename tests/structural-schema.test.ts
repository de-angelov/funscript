import { describe, expect, it } from "vitest";
import { execute, typeCheck } from "./helpers/index.js";
import { format } from "../src/formatter/index.js";

describe("JavaScript-shaped schema unions", () => {
  it("validates literal unions without adding tags", async () => {
    const source = 'export schema Vote =\n  | "like"\n  | "dislike"\nexport read = (input: Unknown) => VoteFromUnknown(input)';
    const checked = await typeCheck(source, "literal-union.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { read } = await execute(source);
    expect(read("like")).toBe("like");
    expect(() => read("other")).toThrow();
    const invalid = await typeCheck(source + '\nexport choose = (vote: Vote) => vote\nexport wrong = choose("other")', "literal-union.fun");
    expect(invalid.success).toBe(false);
    expect(format(format(source))).toBe(format(source));
  });

  it("validates discriminated object unions and narrows their types", async () => {
    const source = 'export schema Result =\n  | { ok: true, data: String }\n  | { ok: false, error: String }\nexport read = (input: Unknown) => ResultFromUnknown(input)';
    const checked = await typeCheck(source, "structural-union.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { read } = await execute(source);
    expect(read({ ok: true, data: "yes" })).toEqual({ ok: true, data: "yes" });
    expect(read({ ok: false, error: "no" })).toEqual({ ok: false, error: "no" });
    expect(() => read({ ok: true, error: "no" })).toThrow();
    expect(format(format(source))).toBe(format(source));
    const typed = await typeCheck(source + '\nts { const accepted: Result = { ok: true, data: "yes" }; const rejected: Result = { ok: true, error: "no" }; }', "structural-union.fun");
    expect(typed.success).toBe(false);
  });

  it("decodes optional fields in union members to Options", async () => {
    const source = 'export schema Reply =\n  | { ok: true, note?: String }\n  | { ok: false, error: String }\nexport read = (input: Unknown) => ReplyFromUnknown(input)';
    const { read } = await execute(source);
    expect(read({ ok: true }).note._tag).toBe("None");
    expect(read({ ok: true, note: "yes" }).note.value).toBe("yes");
  });
});
