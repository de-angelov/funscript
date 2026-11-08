import { describe, expect, it } from "vitest";
import path from "node:path";
import { omit } from "funscript/record";
import { compile, typeCheck } from "./helpers/index.js";

describe("TypeScript interop and record algebra", () => {
  it("omits own enumerable keys without mutating the original", () => {
    const symbol = Symbol("data");
    const original = { internal: true, label: "Save", [symbol]: 1 };
    expect(omit(original, ["internal"])).toEqual({ label: "Save", [symbol]: 1 });
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
    const checked = await typeCheck(source, "record-algebra.fun", { compilerOptions: { rootDir: process.cwd() } });
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("delegates imported overloads and variadic calls to TypeScript", async () => {
    const fixture = path.resolve("tests/fixtures/interop-logger.js");
    const source = `import { logger } from "${fixture}"
export log = () => logger.info("country %s count %d", "BG", 3)`;
    const result = await compile(source);
    expect(result.typescript).toContain('logger.info("country %s count %d", "BG", 3)');
    const checked = await typeCheck(source);
    expect(checked.success, checked.formattedOutput).toBe(true);
    const invalid = await typeCheck(`import { logger } from "${fixture}"\nexport log = () => logger.info(42)`);
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
    const checked = await typeCheck(prefix + 'export View = () => <Target {...omit(props, ["internal"])} />', "view.funx", { compilerOptions: { rootDir: process.cwd() } });
    expect(checked.success, checked.formattedOutput).toBe(true);
    const invalid = await typeCheck(prefix + 'export View = () => <Target {...unknownProps} />', "view.funx", { compilerOptions: { rootDir: process.cwd() } });
    expect(invalid.success).toBe(false);
    expect(invalid.formattedOutput).toMatch(/Spread types may only be created from object types/);
    const wrong = await typeCheck(prefix + 'export View = () => <Target {...{ label: 123 }} />', "view.funx", { compilerOptions: { rootDir: process.cwd() } });
    expect(wrong.success).toBe(false);
    expect(wrong.formattedOutput).toMatch(/not assignable to type 'string'/);
  });
});
