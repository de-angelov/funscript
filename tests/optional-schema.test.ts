import { describe, expect, it } from "vitest";
import { Effect, Option, Schema } from "effect";
import {
  compile,
  execute,
  expectCompileError,
  typeCheck,
} from "./helpers/index.js";
import { format } from "../src/formatter/index.js";
import { typeCheckVirtualFiles } from "../src/compiler/check.js";

describe("named schemas with Option fields", () => {
  const source =
    "export schema Props = { label: Option<String>, nested: Option<{ enabled: Option<Boolean> }> }";

  it("decodes and encodes ordinary JavaScript optional properties explicitly", async () => {
    const { Props, PropsFromUnknown } = await execute(source);
    expect(PropsFromUnknown({})).toEqual({
      label: Option.none(),
      nested: Option.none(),
    });
    const presentUndefined = PropsFromUnknown({
      label: undefined,
      nested: { enabled: false },
    });
    expect(presentUndefined).toEqual({
      label: Option.none(),
      nested: Option.some({ enabled: Option.some(false) }),
    });
    const presentNull = PropsFromUnknown({
      label: null,
      nested: { enabled: false },
    });
    expect(presentNull).toEqual({
      label: Option.none(),
      nested: Option.some({ enabled: Option.some(false) }),
    });
    const value = PropsFromUnknown({ label: "Ada", nested: {} });
    expect(value).toEqual({
      label: Option.some("Ada"),
      nested: Option.some({ enabled: Option.none() }),
    });
    expect(Schema.encodeSync(Props)(value)).toEqual({
      label: "Ada",
      nested: {},
    });
    expect((await compile(source)).typescript).toContain(
      "Schema.OptionFromOptionalNullOr",
    );
    expect(format(format(source))).toBe(format(source));
  });

  it("requires real Option handling on decoded values while exposing the encoded input", async () => {
    const good = await typeCheck(
      source +
        "\nread = (props: Props) => props.label\nexport forward = (props: Props) => read(props)\nexport input = (props: SchemaInput<Props>) => props\nexport empty = input({})",
      "optional-schema.fun",
    );
    expect(good.success, good.formattedOutput).toBe(true);
    const bad = await typeCheck(
      source + "\nexport read = (props: Props) => props.label.toUpperCase()",
      "optional-schema.fun",
    );
    expect(bad.success).toBe(false);
    const raw = await typeCheck(
      source +
        "\nread = (props: Props) => props.label\nexport forward = (props: SchemaInput<Props>) => read(props)",
      "optional-schema.fun",
    );
    expect(raw.success).toBe(false);
  });

  it("allows explicit normalization of a present undefined field", async () => {
    const code =
      'import { Option } from "effect"\nexport schema Props = { label: Option<String> }\nexport normalize = (props: Props) => Option.flatMap(props.label, Option.fromUndefinedOr)';
    const checked = await typeCheck(code, "normalize-optional.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { PropsFromUnknown, normalize } = await execute(code);
    expect(normalize(PropsFromUnknown({}))).toEqual(Option.none());
    expect(normalize(PropsFromUnknown({ label: undefined }))).toEqual(
      Option.none(),
    );
    expect(normalize(PropsFromUnknown({ label: "Ada" }))).toEqual(
      Option.some("Ada"),
    );
  });

  it("decodes optional fields within arrays of records", async () => {
    const { HistoryFromUnknown } = await execute(
      "export schema History = { entries: Array<{ note: Option<String> }> }",
    );
    expect(HistoryFromUnknown({ entries: [{}, { note: "hello" }] })).toEqual({
      entries: [{ note: Option.none() }, { note: Option.some("hello") }],
    });
  });

  it("preserves the decoded Option type across modules", async () => {
    const good = await Effect.runPromise(
      typeCheckVirtualFiles(
        {
          "model.fun": source,
          "reader.fun":
            'import { Props } from "./model.js"\nexport read = (props: Props) => props.label',
          "consumer.fun":
            'import { Props, PropsFromUnknown } from "./model.js"\nimport { read } from "./reader.js"\nexport forward = (props: Props) => read(props)\nexport value = forward(PropsFromUnknown({}))',
        },
        { compilerOptions: { rootDir: process.cwd() } },
      ),
    );
    expect(good.success, good.formattedOutput).toBe(true);
    const result = await Effect.runPromise(
      typeCheckVirtualFiles(
        {
          "model.fun": source,
          "consumer.fun":
            'import { Props } from "./model.js"\nexport read = (props: Props) => props.label.toUpperCase()',
        },
        { compilerOptions: { rootDir: process.cwd() } },
      ),
    );
    expect(result.success).toBe(false);
    expect(
      result.diagnostics.some((d) => d.message.includes("toUpperCase")),
    ).toBe(true);
  });

  it("rejects '?' syntax in schema fields", async () => {
    await expectCompileError(
      'schema Bad = { label?: String = "x" }',
      /Optional '\?' schema field syntax is disabled/,
    );
  });

  it("supports nested schema field defaults", async () => {
    const code = `
export schema Config = {
  database: {
    host: String = "localhost",
    port: Number = 5432
  }
}
`;
    const { ConfigFromUnknown } = await execute(code);
    expect(ConfigFromUnknown({ database: {} })).toEqual({
      database: { host: "localhost", port: 5432 },
    });
    expect(ConfigFromUnknown({ database: { port: 3306 } })).toEqual({
      database: { host: "localhost", port: 3306 },
    });
  });

  it("safely decodes Country schema with rank: Option<Number> from real-world JSON/SQL null payloads", async () => {
    const code = `
export schema Country = {
  name: String
  rank: Option<Number>
}
`;
    const { Country, CountryFromUnknown } = await execute(code);
    // 1. With rank
    expect(CountryFromUnknown({ name: "Bulgaria", rank: 1 })).toEqual({
      name: "Bulgaria",
      rank: Option.some(1),
    });
    // 2. With null (real JSON API / SQL nullable response)
    expect(CountryFromUnknown({ name: "Bulgaria", rank: null })).toEqual({
      name: "Bulgaria",
      rank: Option.none(),
    });
    // 3. With undefined
    expect(CountryFromUnknown({ name: "Bulgaria", rank: undefined })).toEqual({
      name: "Bulgaria",
      rank: Option.none(),
    });
    // 4. Missing key
    expect(CountryFromUnknown({ name: "Bulgaria" })).toEqual({
      name: "Bulgaria",
      rank: Option.none(),
    });
    // 5. Encoding None omits rank
    expect(
      Schema.encodeSync(Country)({ name: "Bulgaria", rank: Option.none() }),
    ).toEqual({
      name: "Bulgaria",
    });
    // 6. Encoding Some(1) produces rank: 1
    expect(
      Schema.encodeSync(Country)({ name: "Bulgaria", rank: Option.some(1) }),
    ).toEqual({
      name: "Bulgaria",
      rank: 1,
    });
  });
});
