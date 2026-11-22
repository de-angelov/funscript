import { describe, expect, it } from "vitest";
import { convertPipelineStyle } from "../src/tooling/pipeline-style.js";
import { FunScriptLspServer } from "../src/lsp/server.js";

const filename = `${process.cwd()}/pipeline-style-example.fun`;

describe("pipeline style conversion", () => {
  it("converts both ways and preserves unrelated text", () => {
    const original = 'import { String } from "effect"\nexport result = "hello" |> String.startsWith("h")\n';
    const bare = convertPipelineStyle(original, filename, "bare");
    expect(bare.changed).toBe(1);
    expect(bare.text).toContain('|> startsWith("h")');
    expect(convertPipelineStyle(bare.text, filename, "qualified").text).toBe(original);
  }, 60000);

  it("does not replace a qualified stage with a shadowing local function", () => {
    const source = 'import { String } from "effect"\nstartsWith = (s: String) => false\nexport result = "hello" |> String.startsWith("h")\n';
    const result = convertPipelineStyle(source, filename, "bare");
    expect(result.text).toBe(source);
    expect(result.skipped).toBe(1);
  }, 60000);

  it("converts safe nested stages while preserving ambiguous or shadowed ones", () => {
    const source = 'import { String } from "effect"\nstartsWith = (s: String) => false\nexport test = (value: String) => (value |> String.startsWith("a")) or (value |> String.includes("b"))\n';
    const result = convertPipelineStyle(source, filename, "bare");
    expect(result.text).toContain('String.startsWith("a")');
    expect(result.text).toContain('|> includes("b")');
    expect(result.changed).toBe(1);
    expect(result.skipped).toBe(1);
  }, 60000);

  it("offers a selection-based editor action", () => {
    const server = new FunScriptLspServer();
    const uri = `file://${filename}`;
    const source = 'import { String } from "effect"\nexport result = "hello" |> String.startsWith("h")\n';
    server.onDidOpenHandler({ textDocument: { uri, languageId: "funscript", version: 1, text: source } });
    const actions = server.onCodeActionHandler({ textDocument: { uri }, range: { start: { line: 1, character: 30 }, end: { line: 1, character: 30 } }, context: { diagnostics: [] } });
    expect(actions.find(action => action.title === "Use bare pipeline stages")?.edit?.changes?.[uri]?.[0].newText).toContain('|> startsWith("h")');
  }, 60000);
});
