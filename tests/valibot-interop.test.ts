import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { Effect, Schema } from "effect";
import { fromValibotSchema, toValibotSchema } from "../src/interop/valibot.js";

describe("Effect Schema and Valibot interop", () => {
  it("converts Effect primitives, structs, arrays, and optional fields to Valibot", () => {
    const effectSchema = Schema.Struct({
      name: Schema.String,
      scores: Schema.Array(Schema.Number),
      note: Schema.optional(Schema.String),
    });
    const valibotSchema = toValibotSchema(effectSchema);
    expect(v.safeParse(valibotSchema, { name: "Ada", scores: [1, 2] }).success).toBe(true);
    expect(v.safeParse(valibotSchema, { name: 3, scores: [] }).success).toBe(false);
  });

  it("converts Effect tagged unions to Valibot variants", () => {
    const effectSchema = Schema.Union([
      Schema.Struct({ kind: Schema.Literal("text"), value: Schema.String }),
      Schema.Struct({ kind: Schema.Literal("count"), value: Schema.Number }),
    ]);
    const valibotSchema = toValibotSchema(effectSchema);
    expect(v.safeParse(valibotSchema, { kind: "count", value: 4 }).success).toBe(true);
    expect(v.safeParse(valibotSchema, { kind: "count", value: "four" }).success).toBe(false);
  });

  it("converts Valibot schemas to Effect schemas and reports decode paths", async () => {
    const valibotSchema = v.object({
      profile: v.object({ name: v.string() }),
      values: v.array(v.number()),
      alias: v.optional(v.string()),
    });
    const effectSchema = fromValibotSchema(valibotSchema);
    const value = { profile: { name: "Ada" }, values: [1, 2] };
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(effectSchema)(value))).resolves.toEqual(value);
    expect(() => Schema.decodeUnknownSync(effectSchema)({ profile: { name: 1 }, values: [] })).toThrow(/profile/);
  });

  it("converts Valibot unions and variants to Effect decoders", () => {
    const schema = fromValibotSchema(v.variant("kind", [
      v.object({ kind: v.literal("text"), value: v.string() }),
      v.object({ kind: v.literal("count"), value: v.number() }),
    ]));
    expect(Schema.decodeUnknownSync(schema)({ kind: "text", value: "ok" })).toEqual({ kind: "text", value: "ok" });
    expect(() => Schema.decodeUnknownSync(schema)({ kind: "count", value: "bad" })).toThrow();
  });
});
