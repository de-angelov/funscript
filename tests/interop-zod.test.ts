import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Effect, Schema as EffectSchema, Option, Exit, Result } from "effect";
import {
  fromZod,
  toZod,
  decodeUnknown,
  decodeUnknownSync,
  decodeUnknownPromise,
  InteropSchema as Schema,
} from "../src/interop/zod.js";
import { compileString } from "../src/compiler.js";
import ts from "typescript";

describe("Zod and @effect/schema bidirectional interop", () => {
  describe("fromZod", () => {
    it("allows validating inputs against a Zod schema via Schema.decodeUnknownSync", () => {
      const UserZod = z.object({
        id: z.string(),
        name: z.string(),
        age: z.number().int().min(0),
      });

      const UserSchema = fromZod(UserZod);

      const valid = { id: "u-1", name: "Alice", age: 30 };
      const decoded = Schema.decodeUnknownSync(UserSchema)(valid);
      expect(decoded).toEqual({ id: "u-1", name: "Alice", age: 30 });
    });

    it("allows validating inputs against a Zod schema via Schema.decodeUnknown inside Effect", async () => {
      const OrderZod = z.object({
        orderId: z.string().uuid(),
        amount: z.number().positive(),
      });

      const OrderSchema = fromZod(OrderZod);

      const raw = {
        orderId: "123e4567-e89b-12d3-a456-426614174000",
        amount: 99.99,
      };

      const effect = Schema.decodeUnknown(OrderSchema)(raw);
      const result = await Effect.runPromise(effect);
      expect(result).toEqual(raw);
    });

    it("supports decodeUnknownPromise and decodeUnknown helper", async () => {
      const ItemZod = z.object({
        sku: z.string(),
        quantity: z.number().int().positive(),
      });

      const ItemSchema = fromZod(ItemZod);

      const valid = { sku: "ABC-123", quantity: 5 };
      const fromPromise = await decodeUnknownPromise(ItemSchema)(valid);
      expect(fromPromise).toEqual(valid);

      const fromHelper = await Effect.runPromise(decodeUnknown(ItemSchema)(valid));
      expect(fromHelper).toEqual(valid);
    });

    it("preserves exact validation error messages and nested paths", () => {
      const ProfileZod = z.object({
        username: z.string().min(3, "Username must be at least 3 chars"),
        contact: z.object({
          email: z.string().email("Invalid email address"),
        }),
        tags: z.array(z.number().positive("Tag IDs must be positive")),
      });

      const ProfileSchema = fromZod(ProfileZod);

      try {
        Schema.decodeUnknownSync(ProfileSchema)({
          username: "al",
          contact: { email: "not-an-email" },
          tags: [-1, 2],
        });
        expect.unreachable("Should have thrown SchemaError");
      } catch (err: any) {
        expect(err.name).toBe("SchemaError");
        const message = err.message;
        expect(message).toContain("Username must be at least 3 chars");
        expect(message).toContain("Invalid email address");
        expect(message).toContain("Tag IDs must be positive");
        expect(message).toContain('at ["contact"]["email"]');
        expect(message).toContain('at ["tags"][0]');
      }
    });

    it("functions as a callable schema constructor", () => {
      const SettingsZod = z.object({
        theme: z.enum(["light", "dark"]),
        notifications: z.boolean().default(true),
      });

      const Settings = fromZod(SettingsZod);

      const settings = Settings({ theme: "dark" });
      expect(settings).toEqual({ theme: "dark", notifications: true });

      expect(() => Settings({ theme: "neon" })).toThrow("Invalid enum value");
    });

    it("works with Schema.is type guards", () => {
      const PositiveNumber = fromZod(z.number().positive());

      const isPositive = EffectSchema.is(PositiveNumber);
      expect(isPositive(10)).toBe(true);
      expect(isPositive(-5)).toBe(false);
      expect(isPositive("10")).toBe(false);
    });

    it("handles asynchronous Zod refinements and transforms", async () => {
      const AsyncSlugZod = z.string().refine(async (slug) => slug.startsWith("post-"), {
        message: "Slug must start with post-",
      });

      const AsyncSlugSchema = fromZod(AsyncSlugZod);

      const valid = await decodeUnknownPromise(AsyncSlugSchema)("post-hello-world");
      expect(valid).toBe("post-hello-world");

      await expect(decodeUnknownPromise(AsyncSlugSchema)("invalid-slug")).rejects.toThrow(
        "Slug must start with post-"
      );
    });

    it("exposes StandardSchema (~standard) property when present", () => {
      const SimpleZod = z.string();
      const SimpleSchema = fromZod(SimpleZod);

      expect(SimpleSchema["~standard"]).toBeDefined();
      expect(SimpleSchema["~standard"]?.version).toBe(1);
      expect(SimpleSchema["~standard"]?.vendor).toBe("zod");
    });
  });

  describe("toZod", () => {
    it("produces a valid Zod schema that passes standard Zod .safeParse checks", () => {
      const EffectPerson = EffectSchema.Struct({
        name: EffectSchema.String,
        age: EffectSchema.Number,
      });

      const ZodPerson = toZod(EffectPerson);

      const valid = ZodPerson.safeParse({ name: "Bob", age: 40 });
      expect(valid.success).toBe(true);
      if (valid.success) {
        expect(valid.data).toEqual({ name: "Bob", age: 40 });
      }

      const invalid = ZodPerson.safeParse({ name: 123, age: "forty" });
      expect(invalid.success).toBe(false);
      if (!invalid.success) {
        expect(invalid.error).toBeInstanceOf(z.ZodError);
        expect(invalid.error.issues.length).toBeGreaterThanOrEqual(1);
      }
    });

    it("passes standard Zod .parse checks and throws ZodError on failure", () => {
      const EffectConfig = EffectSchema.Struct({
        port: EffectSchema.Number,
        host: EffectSchema.String,
      });

      const ZodConfig = toZod(EffectConfig);

      const config = ZodConfig.parse({ port: 8080, host: "localhost" });
      expect(config).toEqual({ port: 8080, host: "localhost" });

      expect(() => ZodConfig.parse({ port: "8080" })).toThrowError(z.ZodError);
    });

    it("preserves field error paths and messages in Zod issues", () => {
      const EffectAccount = EffectSchema.Struct({
        user: EffectSchema.Struct({
          email: EffectSchema.String,
        }),
        balance: EffectSchema.Number,
      });

      const ZodAccount = toZod(EffectAccount);

      const result = ZodAccount.safeParse({
        user: { email: 123 },
        balance: "none",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        const issues = result.error.issues;
        const emailIssue = issues.find((i) => i.path.includes("user") && i.path.includes("email"));
        const balanceIssue = issues.find((i) => i.path.includes("balance"));

        expect(emailIssue).toBeDefined();
        expect(emailIssue?.message).toContain("Expected string");
        expect(balanceIssue).toBeDefined();
        expect(balanceIssue?.message).toContain("Expected number");
      }
    });

    it("supports composing toZod inside standard Zod schemas", () => {
      const EffectMeta = EffectSchema.Struct({
        version: EffectSchema.Number,
      });

      const OuterZod = z.object({
        title: z.string(),
        meta: toZod(EffectMeta),
      });

      const parsed = OuterZod.safeParse({
        title: "Test Post",
        meta: { version: 1 },
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual({
          title: "Test Post",
          meta: { version: 1 },
        });
      }

      const invalid = OuterZod.safeParse({
        title: "Test Post",
        meta: { version: "invalid" },
      });

      expect(invalid.success).toBe(false);
      if (!invalid.success) {
        expect(invalid.error.issues[0].path).toEqual(["meta", "version"]);
      }
    });

    it("supports chaining standard Zod modifiers (.optional, .nullable, .array)", () => {
      const TagSchema = EffectSchema.Struct({
        name: EffectSchema.String,
      });

      const OptionalTag = toZod(TagSchema).optional();
      expect(OptionalTag.safeParse(undefined).success).toBe(true);
      expect(OptionalTag.safeParse({ name: "tech" }).success).toBe(true);

      const TagList = toZod(TagSchema).array();
      const listParsed = TagList.safeParse([{ name: "fun" }, { name: "script" }]);
      expect(listParsed.success).toBe(true);
      if (listParsed.success) {
        expect(listParsed.data).toEqual([{ name: "fun" }, { name: "script" }]);
      }
    });

    it("supports asynchronous parsing via .safeParseAsync and .parseAsync", async () => {
      const EffectData = EffectSchema.Struct({
        token: EffectSchema.String,
      });

      const ZodData = toZod(EffectData);

      const asyncSafe = await ZodData.safeParseAsync({ token: "xyz-789" });
      expect(asyncSafe.success).toBe(true);

      const asyncParse = await ZodData.parseAsync({ token: "xyz-789" });
      expect(asyncParse).toEqual({ token: "xyz-789" });

      await expect(ZodData.parseAsync({ token: 999 })).rejects.toBeInstanceOf(z.ZodError);
    });

    it("supports StandardSchema (~standard) validation", async () => {
      const EffectItem = EffectSchema.Struct({
        id: EffectSchema.Number,
      });

      const ZodItem = toZod(EffectItem);
      expect(ZodItem["~standard"]).toBeDefined();

      const validation = await ZodItem["~standard"].validate({ id: 10 });
      expect(validation.issues).toBeUndefined();
      if (!validation.issues) {
        expect(validation.value).toEqual({ id: 10 });
      }

      const failed = await ZodItem["~standard"].validate({ id: "invalid" });
      expect(failed.issues).toBeDefined();
      expect(failed.issues?.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("bidirectional roundtripping", () => {
    it("roundtrips from Zod -> Effect -> Zod seamlessly", () => {
      const OriginalZod = z.object({
        city: z.string(),
        zip: z.string().regex(/^\d{5}$/),
      });

      const AsEffect = fromZod(OriginalZod);
      const BackToZod = toZod(AsEffect);

      const valid = { city: "New York", zip: "10001" };
      expect(BackToZod.safeParse(valid)).toEqual({ success: true, data: valid });

      const invalid = BackToZod.safeParse({ city: "New York", zip: "ABCDE" });
      expect(invalid.success).toBe(false);
    });

    it("roundtrips from Effect -> Zod -> Effect seamlessly", () => {
      const OriginalEffect = EffectSchema.Struct({
        active: EffectSchema.Boolean,
        score: EffectSchema.Number,
      });

      const AsZod = toZod(OriginalEffect);
      const BackToEffect = fromZod(AsZod);

      const valid = { active: true, score: 95 };
      expect(Schema.decodeUnknownSync(BackToEffect)(valid)).toEqual(valid);

      expect(() =>
        Schema.decodeUnknownSync(BackToEffect)({ active: "yes", score: 95 })
      ).toThrow();
    });
  });

  describe("FunScript pipeline and pattern matching interop", () => {
    it("compiles and runs FunScript decoding a Zod schema in an effect block", async () => {
      const source = `
import { z } from "zod"
import { fromZod } from "funscript/interop/zod"

export CustomerZod = z.object({
  name: z.string(),
  email: z.string().email()
})

export CustomerSchema = fromZod(CustomerZod)

export parseCustomer = (dict: Unknown) =>
  effect
    payload <- dict |> decode(CustomerSchema)
    => payload
`;

      const compiled = await Effect.runPromise(compileString(source));
      expect(compiled.typescript).toContain("Schema.decodeUnknown(CustomerSchema)");

      // Transpile and evaluate to verify runtime behavior
      const transpiled = ts
        .transpile(compiled.typescript, { module: ts.ModuleKind.ESNext })
        .replace(/^import\s+[\s\S]*?from\s+["'].*?["'];?/gm, "")
        .replace(/\bexport\s+(const|var|let)\s+/g, "const ")
        .replace(/\bexport\s+/g, "");

      const runFn = new Function(
        "Effect",
        "Schema",
        "pipe",
        "z",
        "fromZod",
        `${transpiled}; return { parseCustomer, CustomerZod, CustomerSchema };`
      );

      const { parseCustomer } = runFn(Effect, Schema, Effect.pipe ?? ((v: any, f: any) => f(v)), z, fromZod);

      const validPayload = { name: "Dana", email: "dana@example.com" };
      const resultEffect = parseCustomer(validPayload);
      const output = await Effect.runPromise(resultEffect);
      expect(output).toEqual(validPayload);

      const invalidPayload = { name: "Dana", email: "bad-email" };
      await expect(Effect.runPromise(parseCustomer(invalidPayload))).rejects.toThrow();
    });
  });
});
