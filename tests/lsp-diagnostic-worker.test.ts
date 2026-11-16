import { describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { FunScriptLspServer } from "../dist/lsp/server.js";

describe("diagnostic worker", () => {
  it("publishes semantic diagnostics asynchronously and clears them after an edit", async () => {
    const server = new FunScriptLspServer();
    const uri = pathToFileURL(resolve("worker-comparison.fun")).href;
    const events: any[] = [];
    server.on("diagnostics", event => events.push(event));
    try {
      const bad = "export compare = (left: String, right: String) => left < right";
      server.onDidOpenHandler({ textDocument: { uri, languageId: "funscript", version: 1, text: bad } });
      expect(events[0].diagnostics).toEqual([]);
      const first = await Promise.race([
        new Promise<string>(resolve => server.on("diagnostics", event => { if (event.diagnostics.length) resolve("diagnostic"); })),
        new Promise<string>(resolve => setTimeout(() => resolve("timer"), 0)),
      ]);
      expect(first).toBe("timer");
      await vi.waitFor(() => expect(events.some(event => event.version === 1 && event.diagnostics.some((diagnostic: any) => diagnostic.message.includes("only available for numbers")))).toBe(true), { timeout: 20000 });
      server.onDidChangeHandler({ textDocument: { uri, version: 2 }, contentChanges: [{ text: "export compare = (left: Number, right: Number) => left < right" }] });
      await vi.waitFor(() => expect(events.filter(event => event.version === 2 && event.diagnostics.length === 0).length).toBeGreaterThanOrEqual(2), { timeout: 20000 });
    } finally { server.dispose(); }
  }, 30000);

  it("never publishes obsolete results after an edit or close", async () => {
    const server = new FunScriptLspServer();
    const uri = pathToFileURL(resolve("worker-stale.fun")).href;
    const events: any[] = [];
    server.on("diagnostics", event => events.push(event));
    try {
      server.onDidOpenHandler({ textDocument: { uri, languageId: "funscript", version: 1, text: "export compare = (left: String, right: String) => left < right" } });
      await new Promise(resolve => setTimeout(resolve, 350));
      server.onDidChangeHandler({ textDocument: { uri, version: 2 }, contentChanges: [{ text: "export value = 1" }] });
      await vi.waitFor(() => expect(events.filter(event => event.version === 2 && event.diagnostics.length === 0).length).toBeGreaterThanOrEqual(2), { timeout: 20000 });
      const changedAt = events.findIndex(event => event.version === 2);
      expect(events.slice(changedAt).some(event => event.version === 1)).toBe(false);
      server.onDidChangeHandler({ textDocument: { uri, version: 3 }, contentChanges: [{ text: "export compare = (left: String, right: String) => left < right" }] });
      await vi.waitFor(() => expect((server as any).diagnosticBusy).toBe(true), { timeout: 5000 });
      server.onDidCloseHandler({ textDocument: { uri } });
      const closedAt = events.length;
      await vi.waitFor(() => expect((server as any).diagnosticBusy).toBe(false), { timeout: 20000 });
      expect(events.slice(closedAt)).toEqual([]);
    } finally { server.dispose(); }
  }, 30000);
});
