import { describe, expect, it } from "vitest";
import { findWorkspaceDefinition, references, rename } from "../src/lsp/navigation.js";

const uri = "file:///project/main.fun";
const position = (line: number, character: number) => ({ line, character });

describe("workspace navigation", () => {
  it("finds symbol uses without treating comments, strings, or shadowed bindings as references", () => {
    const source = [
      "export value = 1",
      "first = value",
      'message = "value"',
      "// value",
      "local = (value: Number) => value + 1",
      "last = value",
    ].join("\n");
    const docs = [{ uri, text: source }];
    const refs = references(source, uri, position(0, 8), docs, true);
    expect(refs.map((ref) => ref.range.start.line)).toEqual([0, 1, 5]);
    const edits = rename(source, uri, position(0, 8), "amount", docs);
    expect(edits?.changes?.[uri].map((edit) => edit.range.start.line)).toEqual([0, 1, 5]);
  });

  it("resolves imported uses and respects a shadowing parameter", () => {
    const library = "file:///project/lib.fun";
    const libSource = "export value = 1\n";
    const source = 'import { value } from "./lib.fun"\nfirst = value\nlocal = (value: Number) => value + 1\n';
    const docs = [{ uri: library, text: libSource }, { uri, text: source }];
    const refs = references(source, uri, position(1, 9), docs, true);
    expect(refs.map((ref) => [ref.uri, ref.range.start.line])).toEqual([[library, 0], [uri, 0], [uri, 1]]);
    expect(findWorkspaceDefinition(source, uri, position(2, 29), docs)).toMatchObject({ uri });
    expect(findWorkspaceDefinition(source, uri, position(1, 9), docs)).toMatchObject({ uri: library });
  });

  it("renames exported names and local aliases independently", () => {
    const library = "file:///project/lib.fun";
    const libSource = "export value = 1\n";
    const source = 'import { value as other } from "./lib.fun"\nfirst = other\n';
    const docs = [{ uri: library, text: libSource }, { uri, text: source }];
    expect(references(libSource, library, position(0, 8), docs, true).map((ref) => [ref.uri, ref.range.start.line, ref.range.start.character])).toEqual([
      [uri, 0, 9], [uri, 0, 18], [uri, 1, 8], [library, 0, 7],
    ]);
    expect(references(source, uri, position(1, 9), docs, true).map((ref) => [ref.uri, ref.range.start.line, ref.range.start.character])).toEqual([
      [library, 0, 7], [uri, 0, 9], [uri, 0, 18], [uri, 1, 8],
    ]);
    const exported = rename(libSource, library, position(0, 8), "amount", docs);
    expect(exported?.changes?.[library].map((edit) => edit.range.start.character)).toEqual([7]);
    expect(exported?.changes?.[uri].map((edit) => [edit.range.start.line, edit.range.start.character])).toEqual([[0, 9]]);
    const alias = rename(source, uri, position(1, 9), "amount", docs);
    expect(Object.keys(alias?.changes ?? {})).toEqual([uri]);
    expect(alias?.changes?.[uri].map((edit) => [edit.range.start.line, edit.range.start.character])).toEqual([[0, 18], [1, 8]]);
    expect(rename(source, uri, position(0, 10), "amount", docs)?.changes).toEqual(exported?.changes);
  });

  it("refuses to rename an import when its declaration is not open", () => {
    const source = 'import { value } from "./lib.fun"\nfirst = value';
    expect(rename(source, uri, position(1, 9), "amount", [{ uri, text: source }])).toBeNull();
  });

  it("refuses renames that could capture another binding", () => {
    const source = "export value = 1\nother = 2\nresult = value + other";
    expect(rename(source, uri, position(0, 8), "other", [{ uri, text: source }])).toBeNull();
  });

  it("uses the latest document text on subsequent requests", () => {
    const source = "export value = 1\nfirst = value";
    expect(references(source, uri, position(0, 8), [{ uri, text: source }], true)).toHaveLength(2);
    const changed = source + "\nsecond = value";
    expect(references(changed, uri, position(0, 8), [{ uri, text: changed }], true)).toHaveLength(3);
  });
});
