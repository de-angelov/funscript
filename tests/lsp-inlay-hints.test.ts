import { describe, it, expect } from "vitest";
import {
  findInlayHints,
  FunScriptLspServer,
  InlayHintKind,
} from "../src/lsp/index.js";
import * as path from "node:path";

describe("LSP Inlay Hints", () => {
  const fixtureUri = `file://${path.resolve(process.cwd(), "tests/fixtures/test.fun")}`;

  it("infers variable binding types", () => {
    const source = `
export num = 42
export text = "hello"
`;
    const hints = findInlayHints(source, fixtureUri);
    expect(hints.length).toBeGreaterThanOrEqual(2);
    const numHint = hints.find((h) => h.position.line === 1);
    expect(numHint).toBeDefined();
    expect(numHint?.label).toBe(": 42");
    expect(numHint?.kind).toBe(InlayHintKind.Type);

    const textHint = hints.find((h) => h.position.line === 2);
    expect(textHint).toBeDefined();
    expect(textHint?.label).toBe(': "hello"');
  });

  it("infers function return types without explicit annotation", () => {
    const source = `
export add = (a: Number, b: Number) => a + b
`;
    const hints = findInlayHints(source, fixtureUri);
    const returnHint = hints.find((h) => h.label === ": number");
    expect(returnHint).toBeDefined();
    expect(returnHint?.kind).toBe(InlayHintKind.Type);
  });

  it("infers Effect bind statement (<-) success types", () => {
    const source = `
import { Effect } from "effect"

export program = effect {
  msg <- Effect.succeed("hello")
  => msg
}
`;
    const hints = findInlayHints(source, fixtureUri);
    const msgHint = hints.find((h) => h.label === ": string");
    expect(msgHint).toBeDefined();
    expect(msgHint?.kind).toBe(InlayHintKind.Type);
  });

  it("filters hints based on range", () => {
    const source = `
export a = 1
export b = 2
export c = 3
`;
    const hints = findInlayHints(source, fixtureUri, {
      start: { line: 2, character: 0 },
      end: { line: 2, character: 20 },
    });
    expect(hints.length).toBe(1);
    expect(hints[0].position.line).toBe(2);
  });

  it("handles textDocument/inlayHint JSON-RPC request on FunScriptLspServer", async () => {
    const server = new FunScriptLspServer();
    server.onInitializeHandler({
      capabilities: {},
      rootUri: `file://${process.cwd()}`,
    } as any);

    const uri = `file://${process.cwd()}/sample.fun`;
    const source = `export count = 100\n`;
    server.onDidOpenHandler({
      textDocument: {
        uri,
        languageId: "funscript",
        version: 1,
        text: source,
      },
    });

    const res = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "textDocument/inlayHint",
      params: {
        textDocument: { uri },
      },
    });

    expect(res).toBeDefined();
    expect((res as any).result).toBeInstanceOf(Array);
    expect((res as any).result.length).toBeGreaterThan(0);
    expect((res as any).result[0].label).toBe(": 100");
  });

  it("disambiguates inlay hints when the same binding name appears multiple times", () => {
    const source = `
import { Effect } from "effect"

first = () =>
  effect {
    value <- Effect.succeed(42)
    => value
  }

second = () =>
  effect {
    value <- Effect.succeed("hello")
    => value
  }
`;
    const hints = findInlayHints(source, fixtureUri);
    const firstHint = hints.find((h) => h.position.line === 5);
    const secondHint = hints.find((h) => h.position.line === 11);
    expect(firstHint?.label).toBe(": number");
    expect(secondHint?.label).toBe(": string");
  });
});
