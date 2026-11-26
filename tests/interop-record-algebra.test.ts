import { describe, expect, it } from "vitest";
import path from "node:path";
import { omit, optionalProperty, propertyPresence } from "funscript/record";
import { Option } from "effect";
import { compile, typeCheck } from "./helpers/index.js";

describe("TypeScript interop and record algebra", () => {
  it("round-trips missing, undefined, null, and values without guessing", () => {
    type Props = { value?: string | null | undefined };
    const inputs: Props[] = [
      {},
      { value: undefined },
      { value: null },
      { value: "Ada" },
    ];
    for (const input of inputs) {
      const result = optionalProperty(
        "value",
        propertyPresence(input, "value"),
      );
      expect(Object.hasOwn(result, "value")).toBe(
        Object.hasOwn(input, "value"),
      );
      expect(result.value).toBe(input.value);
    }
    expect(propertyPresence(inputs[0], "value")).toEqual(Option.none());
    expect(propertyPresence(inputs[1], "value")).toEqual(
      Option.some(undefined),
    );
    expect(propertyPresence(inputs[2], "value")).toEqual(Option.some(null));
    let reads = 0;
    const object = {
      get value() {
        reads++;
        return undefined;
      },
    };
    expect(propertyPresence(object, "value")).toEqual(Option.some(undefined));
    expect(reads).toBe(1);
    expect(
      propertyPresence(Object.create({ value: "inherited" }) as Props, "value"),
    ).toEqual(Option.none());
  });
  it("preserves optional property presence, values, callbacks and order", () => {
    const callback = () => "called";
    const none = {
      first: 1,
      ...optionalProperty("label", Option.none()),
      last: 2,
    };
    expect(Object.hasOwn(none, "label")).toBe(false);
    const someUndefined = {
      first: 1,
      ...optionalProperty("label", Option.some(undefined)),
      last: 2,
    };
    expect(Object.hasOwn(someUndefined, "label")).toBe(true);
    expect(someUndefined.label).toBeUndefined();
    expect(Object.keys(someUndefined)).toEqual(["first", "label", "last"]);
    const props = { ...optionalProperty("onClick", Option.some(callback)) };
    expect(props.onClick).toBe(callback);
    expect(props.onClick?.()).toBe("called");
    const key = Symbol("flag");
    expect({ ...optionalProperty(key, Option.some(false)) }[key]).toBe(false);
  });

  it("can explicitly adapt an Option into a JavaScript-shaped JSX prop", async () => {
    const source = `import { optionalProperty } from "funscript/record"
ts { declare const Target: (props: { label?: string }) => any }
export View = (label?: String) => <Target {...optionalProperty("label", label |> fromNullishOr)} />`;
    const checked = await typeCheck(source, "optional-prop.funx", {
      compilerOptions: { rootDir: process.cwd() },
    });
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("exposes the presence-aware reader to FunScript with the imported property type", async () => {
    const source = `import { propertyPresence } from "funscript/record"
ts { type ForeignProps = { label?: string | null | undefined } }
export read = (props: ForeignProps) => propertyPresence(props, "label")`;
    const checked = await typeCheck(source, "presence.fun", {
      compilerOptions: { rootDir: process.cwd() },
    });
    expect(checked.success, checked.formattedOutput).toBe(true);
    const invalid = await typeCheck(
      source.replace('"label")', '"missing")'),
      "presence.fun",
      { compilerOptions: { rootDir: process.cwd() } },
    );
    expect(invalid.success).toBe(false);
  });
  it("omits own enumerable keys without mutating the original", () => {
    const symbol = Symbol("data");
    const original = { internal: true, label: "Save", [symbol]: 1 };
    expect(omit(original, ["internal"])).toEqual({
      label: "Save",
      [symbol]: 1,
    });
    expect(original.internal).toBe(true);
  });

  it("preserves discriminated props, readonly and optional fields through a FunScript call", async () => {
    const helper = "funscript/record";
    const source = `
import { omit } from "${helper}"
ts {
  type Props =
    | { readonly kind: "link"; readonly href: string; label?: string; internal: boolean }
    | { readonly kind: "button"; readonly onClick: () => void; label?: string; internal: boolean };
  declare const props: Props;
}
export forwarded = omit(props, ["internal"])
ts {
  if (forwarded.kind === "link") {
    const href: string = forwarded.href;
    // @ts-expect-error The button-only field is absent on links.
    forwarded.onClick;
    // @ts-expect-error The field remains readonly.
    forwarded.href = "changed";
  } else {
    forwarded.onClick();
  }
  const label: string | undefined = forwarded.label;
  // @ts-expect-error The internal key was removed.
  forwarded.internal;
}
`;
    const checked = await typeCheck(source, "record-algebra.fun", {
      compilerOptions: { rootDir: process.cwd() },
    });
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("delegates imported overloads and variadic calls to TypeScript", async () => {
    const fixture = path.resolve("tests/fixtures/interop-logger.js");
    const source = `import { logger } from "${fixture}"
export log = () => logger.info("country %s count %d", "BG", 3)`;
    const result = await compile(source);
    expect(result.typescript).toContain(
      'logger.info("country %s count %d", "BG", 3)',
    );
    const checked = await typeCheck(source);
    expect(checked.success, checked.formattedOutput).toBe(true);
    const invalid = await typeCheck(
      `import { logger } from "${fixture}"\nexport log = () => logger.info(42)`,
    );
    expect(invalid.success).toBe(false);
    expect(invalid.formattedOutput).toContain("No overload matches this call");
  });

  it("checks forwarded JSX props and rejects unknown spreads", async () => {
    const helper = "funscript/record";
    const prefix = `
import { omit } from "${helper}"
ts {
  type ButtonProps = { label: string; onClick?: () => void };
  declare const Target: (props: ButtonProps) => any;
  declare const props: ButtonProps & { internal: boolean };
  declare const unknownProps: unknown;
}
`;
    const checked = await typeCheck(
      prefix + 'export View = () => <Target {...omit(props, ["internal"])} />',
      "view.funx",
      { compilerOptions: { rootDir: process.cwd() } },
    );
    expect(checked.success, checked.formattedOutput).toBe(true);
    const invalid = await typeCheck(
      prefix + "export View = () => <Target {...unknownProps} />",
      "view.funx",
      { compilerOptions: { rootDir: process.cwd() } },
    );
    expect(invalid.success).toBe(false);
    expect(invalid.formattedOutput).toMatch(
      /Spread types may only be created from object types/,
    );
    const wrong = await typeCheck(
      prefix + "export View = () => <Target {...{ label: 123 }} />",
      "view.funx",
      { compilerOptions: { rootDir: process.cwd() } },
    );
    expect(wrong.success).toBe(false);
    expect(wrong.formattedOutput).toMatch(/not assignable to type 'string'/);
  });

  it("supports optional properties and parameters in type emission for consumer interop", async () => {
    const source = `
import type { ReactNode } from "react"
export Header = (props: { className?: String, children?: ReactNode }) =>
  => <div className="header" />

ts {
  type RankingOrder = "asc" | "desc";
}
export sortCountries = (order?: RankingOrder) =>
  order |> fromNullishOrElse("asc")

export customSorter: (order?: RankingOrder) => String = sortCountries
export config: { className?: String } = { className: "custom" }
export View = (config?: { className?: String }) =>
  match (fromNullishOr(config))
    | Some(c) => c.className
    | None => "default"

export Button = (props: { label: String, className?: String, onClick?: () => Void }) =>
  => <button className="btn">{props.label}</button>

ts {
  import React from "react";
  const el1 = React.createElement(Header);
  const el2 = React.createElement(Header, {});
  const el3 = React.createElement(Header, { className: "custom" });
  const btn1 = React.createElement(Button, { label: "Submit" });
  const btn2 = React.createElement(Button, { label: "Submit", className: "primary" });
  const s1: string = sortCountries();
  const s2: string = sortCountries("desc");
  const s3: string = customSorter();
  const v1: string | undefined = View();
  const v2: string | undefined = View({ className: "light" });
}
`;
    const checked = await typeCheck(source, "header.funx", {
      compilerOptions: {
        rootDir: process.cwd(),
        jsx: 1,
        types: ["react"],
        lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      },
    });
    expect(checked.success, checked.formattedOutput).toBe(true);

    const compiled = await compile(source, "header.funx");
    expect(compiled.typescript).toContain("className?:");
    expect(compiled.typescript).toContain("children?:");
    expect(compiled.typescript).toContain("onClick?:");
    expect(compiled.typescript).toContain(
      "customSorter: (order?: RankingOrder) => string",
    );
  });
});
