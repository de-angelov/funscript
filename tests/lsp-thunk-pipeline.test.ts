import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { findThunkPipelineCodeActions } from "../src/lsp/thunk-pipeline.js";
import { FunScriptLspServer } from "../src/lsp/index.js";
import { execute, typeCheck } from "./helpers/index.js";

const uri = `file://${process.cwd()}/thunk-action.fun`;
const cursor = {
  start: { line: 1, character: 20 },
  end: { line: 1, character: 20 },
};

describe("deferred pipeline code action", () => {
  it("rewrites a thunk without changing evaluation or outer pipeline precedence", async () => {
    const source = `ts { declare function next(): number }
export result = Effect.sync(() => next() + 1) |> Effect.map((value) => value * 2)`;
    const action = findThunkPipelineCodeActions(source, uri, cursor)[0];
    expect(action?.title).toContain("|>>");
    const edit = action.edit!.changes![uri][0];
    const start = source.indexOf("Effect.sync");
    const end = source.indexOf(" |> Effect.map");
    const rewritten = source.slice(0, start) + edit.newText + source.slice(end);
    expect(edit.newText).toBe("((next() + 1) |>> Effect.sync)");
    const checked = await typeCheck(rewritten, "thunk-action.fun");
    expect(checked.success, checked.formattedOutput).toBe(true);
    let count = 0;
    const { result } = await execute(rewritten, {
      scope: { next: () => ++count },
    });
    expect(count).toBe(0);
    expect(Effect.runSync(result)).toBe(4);
    expect(Effect.runSync(result)).toBe(6);
  });

  it("does not rewrite record overloads, multi-statement thunks, or unrelated calls", () => {
    for (const source of [
      'export x = Effect.try({ "try": () => work(), "catch": (e) => e })',
      "export x = Effect.sync(() =>\n  value = 1\n  => value)",
      "export x = Other.sync(() => work())",
      "export x = Effect.sync(() => /* comment */ work())",
    ]) {
      expect(
        findThunkPipelineCodeActions(source, uri, {
          start: { line: 0, character: 15 },
          end: { line: 0, character: 15 },
        }),
      ).toEqual([]);
    }
  });

  it("supports user-defined functions accepting a thunk", async () => {
    const source = "run = (f: () => Number) => f()\nexport x = run(() => 42)";
    const actions = findThunkPipelineCodeActions(source, uri, {
      start: { line: 1, character: 13 },
      end: { line: 1, character: 13 },
    });
    const edit = actions[0].edit!.changes![uri][0];
    expect(edit.newText).toBe("((42) |>> run)");
    const checked = await typeCheck(
      source.replace("run(() => 42)", edit.newText),
      "thunk-custom-action.fun",
    );
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("offers the action through the language server without an existing pipeline", () => {
    const server = new FunScriptLspServer();
    server.onDidOpenHandler({
      textDocument: {
        uri,
        languageId: "funscript",
        version: 1,
        text: "export x = Effect.sync(() => 42)",
      },
    });
    const actions = server.onCodeActionHandler({
      textDocument: { uri },
      range: {
        start: { line: 0, character: 20 },
        end: { line: 0, character: 20 },
      },
      context: { diagnostics: [] },
    });
    expect(actions.some((action) => action.title.includes("|>>"))).toBe(true);
  });
});
