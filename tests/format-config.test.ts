import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { format } from "../src/formatter/index.js";
import { loadProjectConfig, loadFormatConfigForFile } from "../src/compiler/project-config.js";
import { FunScriptLspServer } from "../src/lsp/server.js";

describe("formatter project settings", () => {
  it("validates settings and finds the closest project from a nested document", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fun-format-"));
    const file = path.join(dir, "funscript.config.fun");
    const nested = path.join(dir, "src");
    mkdirSync(nested);
    writeFileSync(file, 'export config = { format: { indentSize: 4, lineWidth: 40 } }');
    expect(loadProjectConfig(dir).format).toEqual({ indentSize: 4, lineWidth: 40 });
    expect(loadFormatConfigForFile(path.join(nested, "a.fun"))).toEqual({ indentSize: 4, lineWidth: 40 });
    for (const value of ['{ indentSize: 0 }', '{ lineWidth: 39 }', '{ lineWidth: 250 }', '{ unknown: 2 }', '{ indentSize: 2, indentSize: 4 }']) {
      writeFileSync(file, `export config = { format: ${value} }`);
      expect(() => loadProjectConfig(dir)).toThrow("invalid FunScript config");
    }
  });

  it("uses the configured width and indentation for lists, and is idempotent", () => {
    const source = 'items = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]\n';
    const compact = format(source, { lineWidth: 100, indentSize: 2 });
    const expanded = format(source, { lineWidth: 40, indentSize: 4 });
    expect(compact).toContain('["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]');
    expect(expanded).toContain('\n    "aaaaaaaaaaaa",');
    expect(format(expanded, { lineWidth: 40, indentSize: 4 })).toBe(expanded);
  });

  it("wraps a long pipeline at the configured width", () => {
    const source = 'export result = "some-very-long-value" |> replace("long", "short")\n';
    const expanded = format(source, { lineWidth: 40 });
    expect(expanded).toContain('\n  |> replace');
    expect(format(expanded, { lineWidth: 40 })).toBe(expanded);
  });

  it("applies project settings in the editor ahead of the client tab size", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fun-format-lsp-"));
    writeFileSync(path.join(dir, "funscript.config.fun"), 'export config = { format: { indentSize: 4, lineWidth: 40 } }');
    const uri = `file://${dir}/a.fun`;
    const server = new FunScriptLspServer();
    server.onDidOpenHandler({ textDocument: { uri, languageId: "funscript", version: 1, text: 'items = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]\n' } });
    const edits = server.onFormattingHandler({ textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } });
    expect(edits?.[0].newText).toContain('\n    "aaaaaaaaaaaa",');
  });
});
