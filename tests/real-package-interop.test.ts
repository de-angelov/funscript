import { describe, expect, it } from "vitest";
import ts from "typescript";
import { compile, typeCheck } from "./helpers/index.js";

describe("real package interop", () => {
  const options = { compilerOptions: { rootDir: process.cwd(), jsx: ts.JsxEmit.ReactJSX, types: ["react"], lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"] } };
  const helper = "funscript/record";

  it("forwards actual React button props and keeps the ref type", async () => {
    const source = `
import type { ComponentPropsWithRef, Ref } from "react"
import { omit } from "${helper}"
ts {
  type Props = ComponentPropsWithRef<"button"> & { internal: boolean };
  declare const props: Props;
}
export forwarded = omit(props, ["internal"])
export View = () => <button {...forwarded} />
ts {
  const ref: Ref<HTMLButtonElement> | undefined = forwarded.ref;
  // @ts-expect-error The private key is removed.
  forwarded.internal;
  // @ts-expect-error Button refs cannot point to an anchor.
  const wrongRef: Ref<HTMLAnchorElement> = forwarded.ref!;
}
`;
    const checked = await typeCheck(source, "react-props.funx", options);
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("preserves React discriminated union props through forwarding", async () => {
    const source = `
import type { ComponentPropsWithRef } from "react"
import { omit } from "${helper}"
ts {
  type Props =
    | (ComponentPropsWithRef<"a"> & { kind: "link"; internal: boolean })
    | (ComponentPropsWithRef<"button"> & { kind: "button"; internal: boolean });
  declare const props: Props;
}
export forwarded = omit(props, ["internal"])
ts {
  if (forwarded.kind === "link") {
    const href: string | undefined = forwarded.href;
    const ref: import("react").Ref<HTMLAnchorElement> | undefined = forwarded.ref;
  } else {
    const ref: import("react").Ref<HTMLButtonElement> | undefined = forwarded.ref;
    // @ts-expect-error Button props do not have href.
    forwarded.href;
  }
  declare const link: Extract<typeof forwarded, { kind: "link" }>;
  declare const button: Extract<typeof forwarded, { kind: "button" }>;
}
export LinkView = () => <a {...link} />
export ButtonView = () => <button {...button} />
`;
    const checked = await typeCheck(source, "react-union.funx", options);
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("rejects invalid React button props and unknown spreads", async () => {
    const wrong = await typeCheck('export View = () => <button disabled="yes" />', "react-invalid.funx", options);
    expect(wrong.success).toBe(false);
    expect(wrong.formattedOutput).toContain("not assignable to type 'boolean");
    const unknown = await typeCheck('ts { declare const props: unknown }\nexport View = () => <button {...props} />', "react-unknown.funx", options);
    expect(unknown.success).toBe(false);
    expect(unknown.formattedOutput).toContain("Spread types may only be created from object types");
  });

  it("uses Pino's real variadic overloads and checks its imported signatures", async () => {
    const source = `import pino from "pino"
export logger = pino()
export log = () => logger.info("country %s count %d", "BG", 3)
export logObject = () => logger.info({ country: "BG" }, "connected %s", "client")`;
    const emitted = await compile(source);
    expect(emitted.typescript).toContain('logger.info("country %s count %d", "BG", 3)');
    const checked = await typeCheck(source);
    expect(checked.success, checked.formattedOutput).toBe(true);
    const invalid = await typeCheck(source + '\nexport invalid = () => logger.child(42)');
    expect(invalid.success).toBe(false);
    expect(invalid.formattedOutput).toContain("not assignable");
  });

  describe("foreign any boundary policy", () => {
    it("rejects unannotated bindings inferring foreign any with ANY_BINDING", async () => {
      const source = `ts { declare const untypedJson: () => any }\nexport val = untypedJson()`;
      const checked = await typeCheck(source);
      expect(checked.success).toBe(false);
      expect(checked.formattedOutput).toContain("ANY_BINDING");
      expect(checked.formattedOutput).toContain("Cannot infer untyped 'any' for binding 'val'");
    });

    it("rejects property access on untyped foreign any with ANY_ACCESS", async () => {
      const source = `ts { declare const payload: any }\nexport name = payload.user.name`;
      const checked = await typeCheck(source);
      expect(checked.success).toBe(false);
      expect(checked.formattedOutput).toContain("ANY_ACCESS");
      expect(checked.formattedOutput).toContain("Cannot access property 'user' on untyped 'any' value");
    });

    it("allows foreign any when explicitly typed as Unknown at the boundary", async () => {
      const source = `ts { declare const untypedJson: () => any }\nexport val: Unknown = untypedJson()`;
      const checked = await typeCheck(source);
      expect(checked.success, checked.formattedOutput).toBe(true);
    });

    it("resets JSON.parse to return unknown and rejects unvalidated property access", async () => {
      const source = `export parsed = JSON.parse("[]")\nexport bad = parsed.foo`;
      const checked = await typeCheck(source);
      expect(checked.success).toBe(false);
      expect(checked.formattedOutput).toContain("'parsed' is of type 'unknown'");
    });
  });
});
