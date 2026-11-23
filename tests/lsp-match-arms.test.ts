import { describe, it, expect } from "vitest";
import { findFillMatchArmsCodeActions } from "../src/lsp/match-arms.js";
import { FunScriptLspServer } from "../src/lsp/index.js";
import * as path from "node:path";

describe("LSP Fill Missing Match Arms Code Action", () => {
  const uri = `file://${path.resolve(process.cwd(), "tests/fixtures/match.fun")}`;

  it("suggests missing schema variants for partial match expression", () => {
    const source = `
export schema Shape =
  | Circle(radius: Number)
  | Rect(width: Number, height: Number)
  | Point

export area = (shape: Shape) =>
  match shape
    | Circle(r) => 1
`;
    const actions = findFillMatchArmsCodeActions(source, uri, {
      start: { line: 7, character: 2 },
      end: { line: 8, character: 10 },
    });

    expect(actions.length).toBe(1);
    expect(actions[0].title).toBe("Fill missing match arms (Rect, Point)");
    expect(actions[0].kind).toBe("quickfix");
    const edit = actions[0].edit?.changes?.[uri]?.[0];
    expect(edit).toBeDefined();
    expect(edit?.newText).toContain("| Rect(width, height) => ???");
    expect(edit?.newText).toContain("| Point => ???");
  });

  it("suggests all variants when match has no arms yet", () => {
    const source = `
export schema Color =
  | Red
  | Green
  | Blue

export name = (c: Color) =>
  match c
`;
    const actions = findFillMatchArmsCodeActions(source, uri, {
      start: { line: 7, character: 2 },
      end: { line: 7, character: 9 },
    });

    expect(actions.length).toBe(1);
    expect(actions[0].title).toBe("Fill missing match arms (Red, Green, Blue)");
    const edit = actions[0].edit?.changes?.[uri]?.[0];
    expect(edit?.newText).toContain("| Red => ???");
    expect(edit?.newText).toContain("| Green => ???");
    expect(edit?.newText).toContain("| Blue => ???");
  });

  it("suggests missing Option arms", () => {
    const source = `
export unwrap = (opt: Option<Number>) =>
  match opt
    | Some(val) => val
`;
    const actions = findFillMatchArmsCodeActions(source, uri, {
      start: { line: 2, character: 2 },
      end: { line: 3, character: 10 },
    });

    expect(actions.length).toBe(1);
    expect(actions[0].title).toContain("None");
    const edit = actions[0].edit?.changes?.[uri]?.[0];
    expect(edit?.newText).toContain("| None => ???");
  });

  it("does not suggest code action when all variants or wildcard are present", () => {
    const source = `
export schema Status =
  | Active
  | Inactive

export check = (s: Status) =>
  match s
    | Active => 1
    | Inactive => 0
`;
    const actions = findFillMatchArmsCodeActions(source, uri, {
      start: { line: 6, character: 2 },
      end: { line: 8, character: 10 },
    });

    expect(actions.length).toBe(0);
  });

  it("handles textDocument/codeAction via FunScriptLspServer", async () => {
    const server = new FunScriptLspServer();
    server.onInitializeHandler({
      capabilities: {},
      rootUri: `file://${process.cwd()}`,
    } as any);

    const docUri = `file://${process.cwd()}/test-match.fun`;
    const source = `
export schema Animal =
  | Dog(name: String)
  | Cat(name: String)

export sound = (a: Animal) =>
  match a
    | Dog(n) => "woof"
`;

    server.onDidOpenHandler({
      textDocument: {
        uri: docUri,
        languageId: "funscript",
        version: 1,
        text: source,
      },
    });

    const actions = server.onCodeActionHandler({
      textDocument: { uri: docUri },
      range: {
        start: { line: 6, character: 2 },
        end: { line: 7, character: 10 },
      },
      context: { diagnostics: [] },
    });

    expect(actions).toBeDefined();
    const matchAction = actions.find((a: any) =>
      a.title.includes("Fill missing match arms"),
    );
    expect(matchAction).toBeDefined();
    expect(matchAction.title).toContain("Cat");
  });
});
