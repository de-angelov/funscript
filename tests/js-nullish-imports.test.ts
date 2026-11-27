import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as path from "node:path";
import { Lexer } from "../src/lexer/lexer.js";
import { Parser } from "../src/parser/parser.js";
import { resolveImportedRecordFunctions } from "../src/compiler/imported-record-functions.js";
import { typeCheckVirtualFiles } from "../src/compiler/check.js";
import type { TypeNode } from "../src/ast/types.js";

describe("imported JSNullish schema provenance", () => {
  const base = path.join(process.cwd(), "tests", "virtual-nullish");
  const target = path.join(base, "props.fun");
  const bridge = path.join(base, "bridge.fun");
  const main = path.join(base, "main.fun");
  const props = `export schema Props = { text: JSNullish<String>, count: Number }`;
  const reexport = `export { Props as PublicProps } from "./props.js"`;
  const input = `import { PublicProps as LocalProps } from "./bridge.js"
export show = (props: LocalProps) =>
  match props.text
    | Success(value) => value
    | Failure(Null) => "null"
    | Failure(Undefined) => "undefined"`;

  it("recovers a renamed, re-exported nullish field separately from record contracts", () => {
    const ast = new Parser(
      new Lexer(input, main).tokenize(),
      main,
      input,
    ).parse();
    const files = new Map([
      [target, props],
      [bridge, reexport],
      [main, input],
    ]);
    const contracts = new Map();
    const nullish = new Map<string, Map<string, TypeNode>>();
    resolveImportedRecordFunctions(
      ast,
      main,
      files,
      contracts,
      undefined,
      undefined,
      undefined,
      nullish,
    );
    expect(nullish.get("LocalProps")?.get("text")).toMatchObject({
      kind: "TypeReferenceNode",
      name: { name: "JSNullish" },
    });
    expect(contracts.has("LocalProps")).toBe(false);
  });

  it("type-checks matching through an imported renamed schema", async () => {
    const result = await Effect.runPromise(
      typeCheckVirtualFiles(
        { [target]: props, [bridge]: reexport, [main]: input },
        { compilerOptions: { rootDir: process.cwd() } },
      ),
    );
    expect(result.success, result.formattedOutput).toBe(true);
  });

  it("allows imported tagged unions with Failure(Null) and Failure(Undefined)", async () => {
    const unionFile = path.join(base, "union.fun");
    const consumerFile = path.join(base, "consumer.fun");
    const unionCode = `export schema Reason = | Null | Undefined
export schema Outcome = | Success(value: String) | Failure(reason: Reason)`;
    const consumerCode = `import { Outcome } from "./union.js"
export show = (outcome: Outcome) =>
  match outcome
    | Success(value) => value
    | Failure(Null) => "null"`;
    const result = await Effect.runPromise(
      typeCheckVirtualFiles(
        { [unionFile]: unionCode, [consumerFile]: consumerCode },
        { compilerOptions: { rootDir: process.cwd() } },
      ),
    );
    expect(result.success, result.formattedOutput).toBe(true);
  });
});
