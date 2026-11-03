import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import ts from "typescript";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compileString } from "../src/compiler.js";
import { format } from "../src/formatter/index.js";

function evaluateSchemaModule(tsCode: string): any {
  const cjs = ts.transpileModule(tsCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as any };
  const fn = new Function("exports", "require", "module", cjs);
  fn(
    module.exports,
    (mod: string) => {
      if (mod === "effect") return require("effect");
      return require(mod);
    },
    module,
  );
  return module.exports;
}

describe("Imported TypeScript Schemas (TASK-096)", () => {
  const fixturePath = "./fixtures/imported-schemas/model";
  const dummyFile = path.resolve(process.cwd(), "tests/imported-test.fun");

  describe("Syntax, Parsing, and Formatting", () => {
    it("parses and formats ts schema declaration without export", () => {
      const code = `import type { User as UserType } from "${fixturePath}"\n\nts schema User = UserType\n`;
      const formatted = format(code);
      expect(formatted).toBe(code);
    });

    it("parses and formats export ts schema declaration", () => {
      const code = `import type { User as UserType } from "${fixturePath}"\n\nexport ts schema User = UserType\n`;
      const formatted = format(code);
      expect(formatted).toBe(code);
    });

    it("derives schemas for 'schema User = from ts<UserType>' syntax", async () => {
      const code = `import type { User as UserType } from "${fixturePath}"\n\nschema User = from ts<UserType>`;
      const res = await Effect.runPromise(compileString(code, dummyFile));
      expect(res.typescript).toContain("const User = Schema.Struct({");
    });

    it("rejects ts modifier on unsupported declarations", async () => {
      const code = `ts x = 10`;
      await expect(Effect.runPromise(compileString(code, dummyFile))).rejects.toThrow(
        "Expected '{ ... }' after 'ts'",
      );
    });
  });

  describe("Record / Struct Schema Derivation and Runtime Decoding", () => {
    it("generates Effect schema for struct with primitives, optionals, nullables, arrays, and unions", async () => {
      const source = `
import type { User as UserType } from "${fixturePath}"

export ts schema User = UserType
`.trim();

      const result = await Effect.runPromise(compileString(source, dummyFile));
      expect(result.typescript).toContain("export const User = Schema.Struct({");
      expect(result.typescript).toContain("id: Schema.String");
      expect(result.typescript).toContain("name: Schema.String");
      expect(result.typescript).toContain("age: Schema.optional(Schema.Number)");
      expect(result.typescript).toContain("bio: Schema.NullOr(Schema.String)");
      expect(result.typescript).toContain("nickname: Schema.optional(Schema.NullOr(Schema.String))");
      expect(result.typescript).toContain("tags: Schema.Array(Schema.String)");
      expect(result.typescript).toContain("matrix: Schema.Array(Schema.Array(Schema.Number))");
      expect(result.typescript).toContain('role: Schema.Union([Schema.Literal("admin"), Schema.Literal("member"), Schema.Literal("guest")])');
      expect(result.typescript).toContain("status: Schema.Union([Schema.String, Schema.Number])");
      expect(result.typescript).toContain("export type User = typeof User.Type;");
      expect(result.typescript).toContain("export const UserFromUnknown = (input: unknown): User => Schema.decodeUnknownSync(User)(input);");

      // Verify runtime decoding
      const mod = evaluateSchemaModule(result.typescript);
      expect(mod.User).toBeDefined();
      expect(typeof mod.UserFromUnknown).toBe("function");

      // Valid decode with all required fields and null bio
      const valid1 = mod.UserFromUnknown({
        id: "usr_1",
        name: "Alice",
        bio: null,
        tags: ["admin", "staff"],
        matrix: [[1, 2], [3, 4]],
        role: "admin",
        status: "active",
      });
      expect(valid1.id).toBe("usr_1");
      expect(valid1.bio).toBeNull();
      expect(valid1.age).toBeUndefined();

      // Valid decode with optional age, nickname, and numeric status
      const valid2 = mod.UserFromUnknown({
        id: "usr_2",
        name: "Bob",
        age: 30,
        bio: "Engineer",
        nickname: "Bobby",
        tags: [],
        matrix: [],
        role: "member",
        status: 200,
      });
      expect(valid2.age).toBe(30);
      expect(valid2.nickname).toBe("Bobby");
      expect(valid2.status).toBe(200);

      // Rejects invalid role
      expect(() =>
        mod.UserFromUnknown({
          id: "usr_3",
          name: "Charlie",
          bio: null,
          tags: [],
          matrix: [],
          role: "superuser",
          status: "ok",
        }),
      ).toThrow();

      // Rejects missing required field name
      expect(() =>
        mod.UserFromUnknown({
          id: "usr_4",
          bio: null,
          tags: [],
          matrix: [],
          role: "member",
          status: 1,
        }),
      ).toThrow();

      // Rejects wrong type for age (string instead of number)
      expect(() =>
        mod.UserFromUnknown({
          id: "usr_5",
          name: "Dan",
          age: "thirty",
          bio: null,
          tags: [],
          matrix: [],
          role: "member",
          status: 1,
        }),
      ).toThrow();
    });
  });

  describe("Primitive, Array, Record, and Union Schemas", () => {
    it("preserves string, boolean, and numeric discriminated union variants", async () => {
      const source = `
import type { StringTagged, BooleanTagged, NumericTagged } from "${fixturePath}"

export ts schema StringChoice = StringTagged
export ts schema BooleanChoice = BooleanTagged
export ts schema NumericChoice = NumericTagged
`.trim();
      const result = await Effect.runPromise(compileString(source, dummyFile));
      expect(result.typescript).toContain('kind: Schema.Literal("text")');
      expect(result.typescript).toContain('kind: Schema.Literal("count")');
      expect(result.typescript).toContain('enabled: Schema.Literal(true)');
      expect(result.typescript).toContain('enabled: Schema.Literal(false)');
      expect(result.typescript).toContain('code: Schema.Literal(1)');
      expect(result.typescript).toContain('code: Schema.Literal(2)');

      const mod = evaluateSchemaModule(result.typescript);
      expect(mod.StringChoiceFromUnknown({ kind: "text", value: "hello" })).toEqual({ kind: "text", value: "hello" });
      expect(mod.StringChoiceFromUnknown({ kind: "count", value: 4 })).toEqual({ kind: "count", value: 4 });
      expect(() => mod.StringChoiceFromUnknown({ kind: "text", value: 4 })).toThrow();
      expect(() => mod.StringChoiceFromUnknown({ kind: "other", value: "hello" })).toThrow();

      expect(mod.BooleanChoiceFromUnknown({ enabled: true, label: "ready" })).toEqual({ enabled: true, label: "ready" });
      expect(mod.BooleanChoiceFromUnknown({ enabled: false, reason: "disabled" })).toEqual({ enabled: false, reason: "disabled" });
      expect(() => mod.BooleanChoiceFromUnknown({ enabled: true, reason: "disabled" })).toThrow();
      expect(() => mod.BooleanChoiceFromUnknown({ enabled: "true", label: "ready" })).toThrow();

      expect(mod.NumericChoiceFromUnknown({ code: 1, message: "ok" })).toEqual({ code: 1, message: "ok" });
      expect(mod.NumericChoiceFromUnknown({ code: 2, retryAfter: 3 })).toEqual({ code: 2, retryAfter: 3 });
      expect(() => mod.NumericChoiceFromUnknown({ code: 3, message: "ok" })).toThrow();
      expect(() => mod.NumericChoiceFromUnknown({ code: 1, retryAfter: "soon" })).toThrow();
    });

    it("generates and decodes primitive schemas", async () => {
      const source = `
import type { StringAlias, NumberAlias, BooleanAlias } from "${fixturePath}"

export ts schema Str = StringAlias
export ts schema Num = NumberAlias
export ts schema Bool = BooleanAlias
`.trim();

      const result = await Effect.runPromise(compileString(source, dummyFile));
      expect(result.typescript).toContain("export const Str = Schema.String;");
      expect(result.typescript).toContain("export const Num = Schema.Number;");
      expect(result.typescript).toContain("export const Bool = Schema.Boolean;");

      const mod = evaluateSchemaModule(result.typescript);
      expect(mod.StrFromUnknown("hello")).toBe("hello");
      expect(() => mod.StrFromUnknown(123)).toThrow();
      expect(mod.NumFromUnknown(42)).toBe(42);
      expect(() => mod.NumFromUnknown("42")).toThrow();
      expect(mod.BoolFromUnknown(true)).toBe(true);
      expect(() => mod.BoolFromUnknown("true")).toThrow();
    });

    it("keeps boolean literal schemas exact", async () => {
      const source = `
import type { TrueLiteral, FalseLiteral } from "${fixturePath}"

export ts schema AlwaysTrue = TrueLiteral
export ts schema AlwaysFalse = FalseLiteral
`.trim();
      const result = await Effect.runPromise(compileString(source, dummyFile));
      expect(result.typescript).toContain("AlwaysTrue = Schema.Literal(true)");
      expect(result.typescript).toContain("AlwaysFalse = Schema.Literal(false)");
      const mod = evaluateSchemaModule(result.typescript);
      expect(mod.AlwaysTrueFromUnknown(true)).toBe(true);
      expect(() => mod.AlwaysTrueFromUnknown(false)).toThrow();
      expect(mod.AlwaysFalseFromUnknown(false)).toBe(false);
      expect(() => mod.AlwaysFalseFromUnknown(true)).toThrow();
    });

    it("documents optional undefined and extra-key decode behavior", async () => {
      const source = `
import type { OptionalUndefined } from "${fixturePath}"

export ts schema OptionalValue = OptionalUndefined
`.trim();
      const result = await Effect.runPromise(compileString(source, dummyFile));
      const mod = evaluateSchemaModule(result.typescript);
      expect(mod.OptionalValueFromUnknown({})).toEqual({});
      expect(mod.OptionalValueFromUnknown({ value: undefined })).toEqual({ value: undefined });
      expect(mod.OptionalValueFromUnknown({ value: "ok", extra: 1 })).toEqual({ value: "ok" });
      expect(() => mod.OptionalValueFromUnknown({ value: 1 })).toThrow();
    });

    it("generates and decodes array schemas", async () => {
      const source = `
import type { StringArray, ReadonlyNumberArray } from "${fixturePath}"

export ts schema Strings = StringArray
export ts schema Numbers = ReadonlyNumberArray
`.trim();

      const result = await Effect.runPromise(compileString(source, dummyFile));
      expect(result.typescript).toContain("export const Strings = Schema.Array(Schema.String);");
      expect(result.typescript).toContain("export const Numbers = Schema.Array(Schema.Number);");

      const mod = evaluateSchemaModule(result.typescript);
      expect(mod.StringsFromUnknown(["a", "b"])).toEqual(["a", "b"]);
      expect(() => mod.StringsFromUnknown([1, 2])).toThrow();
      expect(mod.NumbersFromUnknown([10, 20])).toEqual([10, 20]);
      expect(() => mod.NumbersFromUnknown("not-array")).toThrow();
    });

    it("generates and decodes record / index-signature schemas", async () => {
      const source = `
import type { StringNumberRecord } from "${fixturePath}"

export ts schema Dict = StringNumberRecord
`.trim();

      const result = await Effect.runPromise(compileString(source, dummyFile));
      expect(result.typescript).toContain("export const Dict = Schema.Record(Schema.String, Schema.Number);");

      const mod = evaluateSchemaModule(result.typescript);
      expect(mod.DictFromUnknown({ x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
      expect(() => mod.DictFromUnknown({ x: "invalid" })).toThrow();
    });

    it("generates and decodes union schemas", async () => {
      const source = `
import type { StatusUnion, MixedUnion } from "${fixturePath}"

export ts schema Status = StatusUnion
export ts schema Mixed = MixedUnion
`.trim();

      const result = await Effect.runPromise(compileString(source, dummyFile));
      expect(result.typescript).toContain('export const Status = Schema.Union([Schema.Literal("active"), Schema.Literal("inactive")]);');
      expect(result.typescript).toContain("export const Mixed = Schema.NullOr(Schema.Union([Schema.String, Schema.Number]));");

      const mod = evaluateSchemaModule(result.typescript);
      expect(mod.StatusFromUnknown("active")).toBe("active");
      expect(mod.StatusFromUnknown("inactive")).toBe("inactive");
      expect(() => mod.StatusFromUnknown("pending")).toThrow();

      expect(mod.MixedFromUnknown("test")).toBe("test");
      expect(mod.MixedFromUnknown(99)).toBe(99);
      expect(mod.MixedFromUnknown(null)).toBeNull();
      expect(() => mod.MixedFromUnknown(false)).toThrow();
    });

    it("generates and decodes nested struct schemas", async () => {
      const source = `
import type { NestedUser } from "${fixturePath}"

export ts schema Nested = NestedUser
`.trim();

      const result = await Effect.runPromise(compileString(source, dummyFile));
      expect(result.typescript).toContain("export const Nested = Schema.Struct({");
      expect(result.typescript).toContain("avatar: Schema.String");
      expect(result.typescript).toContain("description: Schema.optional(Schema.String)");

      const mod = evaluateSchemaModule(result.typescript);
      const valid = mod.NestedFromUnknown({ id: "1", profile: { avatar: "pic.png" } });
      expect(valid.profile.avatar).toBe("pic.png");
      expect(() => mod.NestedFromUnknown({ id: "1", profile: {} })).toThrow();
    });
  });

  describe("Rejection of Unsupported Types", () => {
    it("rejects function types with actionable diagnostic", async () => {
      const source = `
import type { TypeWithFunction } from "${fixturePath}"

ts schema Bad = TypeWithFunction
`.trim();

      await expect(Effect.runPromise(compileString(source, dummyFile))).rejects.toThrow(
        /Method 'TypeWithFunction\.greet' is not supported/,
      );
    });

    it("rejects 'any' with actionable diagnostic without silent widening", async () => {
      const source = `
import type { TypeWithAny } from "${fixturePath}"

ts schema Bad = TypeWithAny
`.trim();

      await expect(Effect.runPromise(compileString(source, dummyFile))).rejects.toThrow(
        /Type 'any' in 'TypeWithAny\.extra' is not supported/,
      );
    });

    it("rejects 'unknown' with actionable diagnostic", async () => {
      const source = `
import type { TypeWithUnknown } from "${fixturePath}"

ts schema Bad = TypeWithUnknown
`.trim();

      await expect(Effect.runPromise(compileString(source, dummyFile))).rejects.toThrow(
        /Type 'unknown' in 'TypeWithUnknown\.data' is not supported/,
      );
    });

    it("rejects Date and built-in instances with actionable diagnostic", async () => {
      const source = `
import type { TypeWithDate } from "${fixturePath}"

ts schema Bad = TypeWithDate
`.trim();

      await expect(Effect.runPromise(compileString(source, dummyFile))).rejects.toThrow(
        /Type 'Date' in 'TypeWithDate\.createdAt' is not supported/,
      );
    });

    it("rejects class instances with actionable diagnostic", async () => {
      const source = `
import type { UserClass } from "${fixturePath}"

ts schema Bad = UserClass
`.trim();

      await expect(Effect.runPromise(compileString(source, dummyFile))).rejects.toThrow(
        /Class 'UserClass' is not supported/,
      );
    });

    it("rejects recursive types with cycle diagnostic", async () => {
      const source = `
import type { RecursiveTree } from "${fixturePath}"

ts schema Bad = RecursiveTree
`.trim();

      await expect(Effect.runPromise(compileString(source, dummyFile))).rejects.toThrow(
        /Recursive type 'RecursiveTree'/,
      );
    });

    it("rejects non-existent types with diagnostic", async () => {
      const source = `
import type { NonExistent } from "${fixturePath}"

ts schema Bad = NonExistent
`.trim();

      await expect(Effect.runPromise(compileString(source, dummyFile))).rejects.toThrow(
        /Cannot resolve type 'NonExistent'/,
      );
    });
  });

  describe("Recompilation Reflection", () => {
    it("reflects changes to imported type files on recompilation", async () => {
      const tempDir = path.resolve(process.cwd(), "tests/fixtures/imported-schemas/temp-recompile");
      await fs.mkdir(tempDir, { recursive: true });
      const modelFile = path.join(tempDir, "dynamic.ts");
      const funFile = path.join(tempDir, "app.fun");

      try {
        // Version 1 of dynamic.ts
        await fs.writeFile(modelFile, "export interface Config { timeout: number }\n", "utf8");
        const funSource = `import type { Config as ConfigType } from "./dynamic"\n\nexport ts schema Config = ConfigType\n`;
        const res1 = await Effect.runPromise(compileString(funSource, funFile));
        expect(res1.typescript).toContain("timeout: Schema.Number");
        expect(res1.typescript).not.toContain("retries: Schema.Number");

        // Version 2 of dynamic.ts: add retries
        await fs.writeFile(
          modelFile,
          "export interface Config { timeout: number; retries: number }\n",
          "utf8",
        );
        const res2 = await Effect.runPromise(compileString(funSource, funFile));
        expect(res2.typescript).toContain("timeout: Schema.Number");
        expect(res2.typescript).toContain("retries: Schema.Number");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
