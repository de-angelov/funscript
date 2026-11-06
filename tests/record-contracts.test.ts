import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import { compile, execute, expectCompileError, typeCheck } from "./helpers/index.js";
import { typeCheckVirtualFiles } from "../src/compiler/check.js";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

describe("named compile-time record contracts", () => {
  const declaration = 'schema Props = { label?: String, onChange?: (value: String) => Void }';

  it("keeps ordinary JavaScript props while requiring Options inside", async () => {
    const source = declaration + '\nexport read = (props: Props) => props.label\nexport callback = (props: Props) => props.onChange';
    const checked = await typeCheck(source + '\nexport missing = read({})\nexport present = read({ label: "Ada" })', "contract.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { read, callback } = await execute(source);
    expect(read({})).toEqual(Option.none());
    expect(read({ label: "Ada" })).toEqual(Option.some("Ada"));
    const fn = () => {};
    expect(callback({ onChange: fn })).toEqual(Option.some(fn));
    expect((await typeCheck(source + '\nexport wrong = read({ label: 1 })', "contract.fun")).success).toBe(false);
    expect((await typeCheck(declaration + '\nexport read = (props: Props) => props.label.toUpperCase()', "contract.fun")).success).toBe(false);
  });

  it("forwards named contracts through verified JSX components", async () => {
    const source = declaration + '\nexport Target = (props: Props) => <div />\nexport Wrapper = (props: Props) => <Target {...props} />';
    const result = await compile(source, "contract.funx");
    expect(result.typescript).toContain("type Props =");
    expect(result.typescript).toContain("<Target {...props} />");
    expect(result.typescript).not.toContain("PropsFromUnknown");
  });

  it("checks callback signatures for TypeScript callers", async () => {
    const good = await typeCheck(declaration + '\nts { const props: Props = { onChange: (value: string) => {} }; }', "contract.fun");
    expect(good.success, good.formattedOutput).toBe(true);
    const bad = await typeCheck(declaration + '\nts { const props: Props = { onChange: (value: number) => {} }; }', "contract.fun");
    expect(bad.success).toBe(false);
  });

  it("resolves type-only imports and forwards contracts across modules", async () => {
    const files = {
      "props.fun": 'export ' + declaration,
      "target.funx": 'import type { Props } from "./props.js"\nexport Target = (props: Props) => <div />',
      "wrapper.funx": 'import type { Props } from "./props.js"\nimport { Target } from "./target.js"\nexport Wrapper = (props: Props) => <Target {...props} />',
    };
    const result = await Effect.runPromise(typeCheckVirtualFiles(files, { compilerOptions: { rootDir: process.cwd() } }));
    expect(result.success, result.formattedOutput).toBe(true);
  });

  it("recovers optional field semantics from an emitted TypeScript package", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fun-contract-package-"));
    try {
      const modules = path.join(root, "node_modules");
      await mkdir(path.join(modules, "props-pkg"), { recursive: true });
      await symlink(path.resolve("node_modules/effect"), path.join(modules, "effect"), "dir");
      const compiled = await compile('export ' + declaration, "props.fun");
      const emitted = ts.transpileDeclaration(compiled.typescript, { compilerOptions: { declaration: true, emitDeclarationOnly: true } });
      expect(emitted.outputText).toContain("$funscriptRecordContract");
      await writeFile(path.join(modules, "props-pkg/package.json"), '{"name":"props-pkg","types":"index.d.ts"}');
      await writeFile(path.join(modules, "props-pkg/index.d.ts"), emitted.outputText);
      const source = 'import type { Props } from "props-pkg"\nexport read = (props: Props) => props.label';
      const { read } = await execute(source, { filename: path.join(root, "caller.fun") });
      expect(read({})).toEqual(Option.none());
      expect(read({ label: "Ada" })).toEqual(Option.some("Ada"));
      const checked = await Effect.runPromise(typeCheckVirtualFiles({ "caller.fun": source }, { cwd: root, compilerOptions: { rootDir: root, types: [] } }));
      expect(checked.success, checked.formattedOutput).toBe(true);
      const unsafe = await Effect.runPromise(typeCheckVirtualFiles({ "caller.fun": source + '.toUpperCase()' }, { cwd: root, compilerOptions: { rootDir: root, types: [] } }));
      expect(unsafe.success).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects runtime decoding and unsafe uses of static contracts", async () => {
    expect((await typeCheck(declaration + '\nexport decode = (value: Unknown) => PropsFromUnknown(value)', "contract.fun")).success).toBe(false);
    await expectCompileError(declaration + '\nexport value = Props', /compile-time record contract/);
    await expectCompileError(declaration + '\nexport value: Props = {}', /only as a direct function parameter/);
    await expectCompileError(declaration + '\nexport js entry = (props: Props) => props.label', /not supported on js entry/);
    await expectCompileError(declaration + '\nexport entry = (props?: Props) => props', /cannot itself be optional or defaulted/);
  });
});
