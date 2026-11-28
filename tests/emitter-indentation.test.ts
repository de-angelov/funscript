import { describe, expect, it } from "vitest";
import { String as EffectString } from "effect";
import { compile, execute } from "./helpers/compiler.js";

describe("generated TypeScript indentation", () => {
  it("indents pipelines inside functions and guards inside matches", async () => {
    const source = `
export schema Shape =
  | Circle(radius: Number)
  | Point
export describe = (shape: Shape) =>
  match shape
    | Circle(r) when r |> Number.isGreaterThan(0) => "circle"
    | Circle(r) => "other"
    | Point => "point"
export trimName = (name: String) =>
  name |> String.trim
`;
    const { typescript } = await compile(source);
    expect(typescript).toContain(
      "  return pipe(\n    name,\n    String.trim\n  );",
    );
    expect(typescript).toContain("  return match(shape)\n    .with(");
    expect(typescript).toContain(
      "      return pipe(\n        r,\n        Number.isGreaterThan(0)\n      );",
    );
  });

  it("preserves multiline template contents while indenting a pipeline", async () => {
    const source = `
export value = () =>
  ts { \`first
second\` } |> String.trim
`;
    const { typescript } = await compile(source);
    expect(typescript).toContain("`first\nsecond`");
    const output = await execute(source, { scope: { String: EffectString } });
    expect(output.value()).toBe("first\nsecond");
  });

  it("simplifies left-nested addition without reassociating right-nested addition", async () => {
    const source = `
export concat = (name: String) => "Hello " + name + "!"
export left = () => (10000000000000000 + -10000000000000000) + 1
export right = () => 10000000000000000 + (-10000000000000000 + 1)
`;
    const { typescript } = await compile(source);
    expect(typescript).toContain('("Hello " + name + "!")');
    const output = await execute(source);
    expect(output.concat("Ada")).toBe("Hello Ada!");
    expect(output.left()).toBe(1);
    expect(output.right()).toBe(0);
  });

  it("merges compatible generated imports without moving other module imports", async () => {
    const source = `
import { Console } from "effect"
export clean = (name: String) => name |> String.trim
`;
    const { typescript } = await compile(source);
    expect(typescript).toContain(
      'import { Console, String, pipe } from "effect";',
    );
    expect(typescript.match(/from "effect"/g)).toHaveLength(1);

    const ordered = await compile(`
import "./setup.js"
import { Console } from "effect"
export clean = (name: String) => name |> String.trim
`);
    expect(ordered.typescript).toContain('import "./setup.js";');
    expect(ordered.typescript).toContain(
      'import { Console, String, pipe } from "effect";',
    );
    expect(ordered.typescript.indexOf('from "effect"')).toBeLessThan(
      ordered.typescript.indexOf('import "./setup.js"'),
    );
  });

  it("merges named imports across generated headers and preserves aliases and type-only imports", async () => {
    const source = `
import "./setup.js"
import { Console as Log, type Effect as EffectType } from "effect"
import { clamp as limit } from "es-toolkit"
export schema Shape =
  | Circle(radius: Number)
  | Point
export size = (shape: Shape) =>
  match shape
    | Circle(r) => r |> round(1)
    | Point => 0
`;
    const { typescript } = await compile(source);
    expect(typescript.match(/from "effect"/g)).toHaveLength(1);
    expect(typescript.match(/from "es-toolkit"/g)).toHaveLength(1);
    expect(typescript).toContain("Console as Log");
    expect(typescript).toContain("type Effect as EffectType");
    expect(typescript).toContain("clamp as limit");
    expect(typescript).toContain('from "ts-pattern"');
    expect(typescript.indexOf('from "effect"')).toBeLessThan(
      typescript.indexOf('from "ts-pattern"'),
    );
    expect(typescript.indexOf('from "ts-pattern"')).toBeLessThan(
      typescript.indexOf('import "./setup.js"'),
    );
  });
});
