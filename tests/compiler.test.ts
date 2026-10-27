import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { compileString } from "../src/compiler.js";

describe("FunScript Compiler", () => {
  it("compiles basic bindings and arithmetic", async () => {
    const code = `
export name = "Ada"
export age = 36
export nextAge = age + 1
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`export const name = "Ada";`);
    expect(res.typescript).toContain(`export const age = 36;`);
    expect(res.typescript).toContain(`export const nextAge = (age + 1);`);
  });

  it("compiles lambdas and pipelines", async () => {
    const code = `
export add = (a: number, b: number) -> a + b
export res = 5 |> add(10, _)
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`import { pipe } from "effect";`);
    expect(res.typescript).toContain(`export const add = (a: number, b: number) => (a + b);`);
    expect(res.typescript).toContain(`(__p) => add(10, __p)`);
  });

  it("compiles record schemas and tagged union schemas", async () => {
    const code = `
export schema User = {
  id: string
  name: string
}

export schema Shape =
  | Circle(radius: number)
  | Rect(width: number, height: number)
  | Point
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`import { Data, Schema } from "effect";`);
    expect(res.typescript).toContain(`export const User = Schema.Struct({`);
    expect(res.typescript).toContain(`id: Schema.String`);
    expect(res.typescript).toContain(`export type Shape = Data.TaggedEnum<{`);
    expect(res.typescript).toContain(`Circle: { readonly radius: number }`);
    expect(res.typescript).toContain(`export const Point: Shape = $Shape.Point();`);
  });

  it("compiles effect blocks with direct service calls", async () => {
    const code = `
export getUser = (id: string) ->
  effect
    user <- UserRepo.find(id)
    _ <- Console.log(user)
    user
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`import { Effect } from "effect";`);
    expect(res.typescript).toContain(`Effect.gen(function* () {`);
    expect(res.typescript).toContain(`const user = yield* (yield* UserRepo).find(id);`);
    expect(res.typescript).toContain(`yield* Console.log(user);`);
    expect(res.typescript).toContain(`return user;`);
  });

  it("compiles deep Mutative spreads", async () => {
    const code = `
export updateCity = (user: User, city: string) ->
  {
    ...user
    address.city: city
  }
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`import { create } from "mutative";`);
    expect(res.typescript).toContain(`create(user, (draft) => {`);
    expect(res.typescript).toContain(`draft.address.city = city;`);
  });
});
