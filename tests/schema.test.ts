import { describe, expect, it } from "vitest";
import { compile, execute, typeCheck } from "./helpers/index.js";
import { format } from "../src/formatter/index.js";

describe("Effect Brand schemas (TASK-079)", () => {
  it("compiles string branded schema and emits Schema.brand and Brand.Brand declarations", async () => {
    const source = 'export schema UserId = String |> Brand("UserId")\nexport read = (id: UserId) => id\nexport test = read(UserIdFromUnknown("usr_123"))';
    const compiled = await compile(source);

    expect(compiled.typescript).toContain('import { Brand, Schema } from "effect";');
    expect(compiled.typescript).toContain('export const UserId = Schema.String.pipe(Schema.brand("UserId"));');
    expect(compiled.typescript).toContain('export type UserId = string & Brand.Brand<"UserId">;');
    expect(compiled.typescript).toContain(
      "export const UserIdFromUnknown = (input: unknown): UserId => Schema.decodeUnknownSync(UserId)(input);",
    );

    const checked = await typeCheck(source, "brand-string.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);

    const { UserId, UserIdFromUnknown, read } = await execute(source);
    expect(UserIdFromUnknown("usr_123")).toBe("usr_123");
    expect(UserId.make("usr_456")).toBe("usr_456");
    expect(read(UserId.make("usr_789"))).toBe("usr_789");
    expect(() => UserIdFromUnknown(12345)).toThrow();

    expect(format(format(source))).toBe(format(source));
  });

  it("compiles integer branded schema and emits Schema.brand and Brand.Brand declarations", async () => {
    const source = 'export schema PositiveInt = Int |> Brand("Positive")\nexport read = (n: PositiveInt) => n\nexport test = read(PositiveIntFromUnknown(42))';
    const compiled = await compile(source);

    expect(compiled.typescript).toContain('import { Brand, Schema } from "effect";');
    expect(compiled.typescript).toContain('export const PositiveInt = Schema.Int.pipe(Schema.brand("Positive"));');
    expect(compiled.typescript).toContain('export type PositiveInt = number & Brand.Brand<"Positive">;');
    expect(compiled.typescript).toContain(
      "export const PositiveIntFromUnknown = (input: unknown): PositiveInt => Schema.decodeUnknownSync(PositiveInt)(input);",
    );

    const checked = await typeCheck(source, "brand-int.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);

    const { PositiveInt, PositiveIntFromUnknown, read } = await execute(source);
    expect(PositiveIntFromUnknown(42)).toBe(42);
    expect(PositiveInt.make(100)).toBe(100);
    expect(read(PositiveInt.make(7))).toBe(7);

    // Rejects floating point values
    expect(() => PositiveIntFromUnknown(3.14)).toThrow();
    // Rejects non-numeric values
    expect(() => PositiveIntFromUnknown("not-a-number")).toThrow();

    expect(format(format(source))).toBe(format(source));
  });

  it("enforces nominal type checking against raw unbranded values", async () => {
    const source = `
export schema UserId = String |> Brand("UserId")
export read = (id: UserId) => id
export wrong = read("raw_string")
`;
    const checked = await typeCheck(source, "raw-unbranded.fun");
    expect(checked.success).toBe(false);
    expect(checked.formattedOutput).toContain("is not assignable to type");
  });

  it("enforces nominal distinction between mismatched branded types", async () => {
    const source = `
export schema UserId = String |> Brand("UserId")
export schema AccountId = String |> Brand("AccountId")
export readUser = (id: UserId) => id
export wrong = readUser(AccountIdFromUnknown("acc_123"))
`;
    const checked = await typeCheck(source, "mismatched-brand.fun");
    expect(checked.success).toBe(false);
    expect(checked.formattedOutput).toContain("is not assignable to type");
  });

  it("accepts explicitly constructed or validated values in type checking", async () => {
    const source = `
export schema UserId = String |> Brand("UserId")
export readUser = (id: UserId) => id
export fromUnknownVal = readUser(UserIdFromUnknown("usr_1"))
export fromMakeVal = readUser(UserId.make("usr_2"))
`;
    const checked = await typeCheck(source, "valid-constructed.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("supports branded schemas in record schemas with nominal type safety", async () => {
    const source = `
export schema UserId = String |> Brand("UserId")
export schema AccountId = String |> Brand("AccountId")
export schema Profile = {
  id: UserId
  accountId: AccountId
}
export getUserId = (p: Profile) => p.id
export getAccountId = (p: Profile) => p.accountId
export test = getUserId(ProfileFromUnknown({ id: "u_1", accountId: "a_1" }))
`;
    const checked = await typeCheck(source, "record-brands.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);

    const { ProfileFromUnknown, getUserId, getAccountId } = await execute(source);
    const profile = ProfileFromUnknown({ id: "usr_99", accountId: "acc_99" });
    expect(getUserId(profile)).toBe("usr_99");
    expect(getAccountId(profile)).toBe("acc_99");
    expect(() => ProfileFromUnknown({ id: 123, accountId: "acc_99" })).toThrow();

    // Mismatched record field type checking
    const badSource = source + `\nexport wrong = (p: Profile) => {\n  acc: AccountId = p.id\n  => acc\n}`;
    const badChecked = await typeCheck(badSource, "bad-record-brand.fun");
    expect(badChecked.success).toBe(false);
    expect(badChecked.formattedOutput).toContain("is not assignable to type");
  });

  it("supports multiple chained brands on a single schema", async () => {
    const source = 'export schema TaggedEntity = String |> Brand("Entity") |> Brand("Tagged")\nexport read = (e: TaggedEntity) => e';
    const compiled = await compile(source);

    expect(compiled.typescript).toContain('export const TaggedEntity = Schema.String.pipe(Schema.brand("Entity"), Schema.brand("Tagged"));');
    expect(compiled.typescript).toContain('export type TaggedEntity = string & Brand.Brand<"Entity"> & Brand.Brand<"Tagged">;');

    const checked = await typeCheck(source + '\nexport test = read(TaggedEntityFromUnknown("item_1"))', "chained-brands.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);

    const { TaggedEntityFromUnknown } = await execute(source);
    expect(TaggedEntityFromUnknown("item_1")).toBe("item_1");
  });

  it("supports alternative Schema.brand qualification syntax", async () => {
    const source = 'export schema OrderId = String |> Schema.brand("OrderId")\nexport read = (id: OrderId) => id';
    const compiled = await compile(source);

    expect(compiled.typescript).toContain('export const OrderId = Schema.String.pipe(Schema.brand("OrderId"));');
    expect(compiled.typescript).toContain('export type OrderId = string & Brand.Brand<"OrderId">;');

    const checked = await typeCheck(source + '\nexport test = read(OrderIdFromUnknown("ord_1"))', "schema-brand-qualified.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("composes imported schemas in record schemas without widening to Schema.Unknown", async () => {
    const source = 'import { Country } from "./country.js"\nexport schema CardProps = {\n  country: Country\n  active: Boolean\n}';
    const compiled = await compile(source);
    expect(compiled.typescript).toContain("country: Country");
    expect(compiled.typescript).not.toContain("Schema.Unknown as unknown");
  });
});
