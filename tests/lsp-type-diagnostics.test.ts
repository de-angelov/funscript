import { describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { FunScriptLspServer } from "../src/lsp/server.js";

describe("LSP TypeScript diagnostics", () => {
  it("maps generic constraint errors to FunScript and clears them after an edit", async () => {
    const server = new FunScriptLspServer();
    const uri = pathToFileURL(path.resolve("lsp-generics.fun")).href;
    const events: any[] = [];
    server.on("diagnostics", (event) => events.push(event));
    const source = `ts { type Client = { close: () => void } }
export connect = <A extends Client>(factory: () => A) => factory()
export bad = connect(() => "bad")`;
    try {
      server.onDidOpenHandler({ textDocument: { uri, languageId: "funscript", version: 1, text: source } });
      await vi.waitFor(() => {
        const diagnostic = events.flatMap((event) => event.diagnostics).find((d: any) => String(d.code) === "2322");
        expect(diagnostic).toBeDefined();
        expect(diagnostic.range.start.line).toBe(2);
      }, { timeout: 10000 });
      server.onDidChangeHandler({ textDocument: { uri, version: 2 }, contentChanges: [{ text: source.replace('"bad"', '{ close: () => {} }') }] });
      await vi.waitFor(() => {
        expect(events.filter((event) => event.version === 2 && event.diagnostics.length === 0).length).toBeGreaterThanOrEqual(2);
      }, { timeout: 10000 });
    } finally {
      server.dispose();
    }
  });

  it("rechecks an open caller when its imported document changes", async () => {
    const server = new FunScriptLspServer();
    const dependency = pathToFileURL(path.resolve("lsp-dependency.fun")).href;
    const caller = pathToFileURL(path.resolve("lsp-caller.fun")).href;
    const events: any[] = [];
    server.on("diagnostics", (event) => events.push(event));
    try {
      server.onDidOpenHandler({ textDocument: { uri: dependency, languageId: "funscript", version: 1, text: "export accept = (value: Number) => value" } });
      server.onDidOpenHandler({ textDocument: { uri: caller, languageId: "funscript", version: 1, text: 'import { accept } from "./lsp-dependency.js"\nexport result = accept(1)' } });
      await vi.waitFor(() => expect(events.filter((event) => event.uri === caller).length).toBeGreaterThanOrEqual(2), { timeout: 10000 });
      server.onDidChangeHandler({ textDocument: { uri: dependency, version: 2 }, contentChanges: [{ text: "export accept = (value: String) => value" }] });
      await vi.waitFor(() => {
        const diagnostic = events.filter((event) => event.uri === caller).flatMap((event) => event.diagnostics).find((item: any) => item.code === 2345);
        expect(diagnostic?.range.start.line).toBe(1);
      }, { timeout: 10000 });
    } finally {
      server.dispose();
    }
  });
});
