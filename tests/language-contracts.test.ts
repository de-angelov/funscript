import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Effect } from "effect";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileString } from "../src/compiler.js";
import { Lexer } from "../src/lexer/lexer.js";
import { TokenType } from "../src/lexer/tokens.js";
import { loadLanguageContracts, unclassifiedTokens } from "../scripts/language-contracts.mjs";

const root = resolve(import.meta.dirname, "..");
const directory = resolve(root, "tests/fixtures/language-contracts");
const catalog = JSON.parse(readFileSync(resolve(directory, "catalog.json"), "utf8"));
const require = createRequire(import.meta.url);

describe("documented language contracts", () => {
  it("classifies every lexer token, requiring new tokens to have a contract", async () => {
    const { contracts, legacyTokens } = await loadLanguageContracts(root);
    const existing = new Set<string>(Object.values(TokenType));
    const covered = new Set<string>(contracts.flatMap((contract: { tokens: string[] }) => contract.tokens));
    const legacy = new Set<string>(legacyTokens);
    expect(legacy.size).toBe(legacyTokens.length);
    expect([...legacy].filter((token) => !existing.has(token)), "Remove obsolete legacy tokens").toEqual([]);
    expect([...covered].filter((token) => !existing.has(token)), "Remove obsolete contract tokens").toEqual([]);
    expect([...covered].filter((token) => legacy.has(token)), "Remove covered tokens from the legacy baseline").toEqual([]);
    expect(unclassifiedTokens([...existing], contracts, legacyTokens),
      "New tokens need a documented, behavior-tested language contract").toEqual([]);
  });

  it("reports a newly introduced token until a contract covers it", () => {
    expect(unclassifiedTokens(["existing", "new-token"], [], ["existing"])).toEqual(["new-token"]);
    expect(unclassifiedTokens(["existing", "new-token"], [{ tokens: ["new-token"] }], ["existing"])).toEqual([]);
  });

  it("uses distinct, documented contracts with concrete behavior expectations", async () => {
    const { contracts } = await loadLanguageContracts(root);
    expect(new Set(contracts.map((contract: { id: string }) => contract.id)).size).toBe(contracts.length);
    expect(contracts.length).toBeGreaterThan(0);
    for (const contract of contracts) {
      expect(contract.title.trim()).not.toBe("");
      expect(contract.description.trim()).not.toBe("");
      expect(contract.tokens.length).toBeGreaterThan(0);
      expect(contract.behavior.export).toBeTruthy();
      expect(contract.behavior.effect === true || contract.behavior.cases?.length > 0).toBe(true);
      if (contract.behavior.effect) expect(contract.behavior).toHaveProperty("expected");
      else for (const testCase of contract.behavior.cases) {
        expect(Array.isArray(testCase.args)).toBe(true);
        expect(testCase).toHaveProperty("expected");
      }
      const tokens = new Set(new Lexer(contract.source, contract.file).tokenize().map((token) => token.type));
      for (const token of contract.tokens) expect(tokens.has(token), `${contract.id} must use token ${token}`).toBe(true);
    }
  });

  it.each(catalog.contracts)("compiles and executes the documented $id example", async (contract) => {
    const source = readFileSync(resolve(directory, contract.file), "utf8");
    const result = await Effect.runPromise(compileString(source, contract.file));
    const javascript = ts.transpileModule(result.typescript, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} as Record<string, any> };
    new Function("exports", "require", "module", javascript)(module.exports, require, module);
    const exported = module.exports[contract.behavior.export];
    if (contract.behavior.effect) {
      expect(Effect.runSync(exported)).toEqual(contract.behavior.expected);
    } else {
      expect(typeof exported).toBe("function");
      for (const testCase of contract.behavior.cases) {
        expect(exported(...testCase.args)).toEqual(testCase.expected);
      }
    }
  }, 30_000);
});
