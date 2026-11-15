import { describe, expect, it } from "vitest";
import { findWorkspaceDefinition, prepareRename, references, rename } from "../src/lsp/navigation.js";

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

  it("follows named re-exports while renaming each alias independently", () => {
    const library = "file:///project/country.fun";
    const barrel = "file:///project/barrel.fun";
    const outer = "file:///project/outer.fun";
    const libSource = "export schema Country = { code: String }";
    const barrelSource = 'export { Country as Place } from "./country.js"';
    const outerSource = 'export { Place as Nation } from "./barrel.js"';
    const source = 'import { Nation as Local } from "./outer.js"\nexport read = (value: Local) => value';
    const docs = [{ uri: library, text: libSource }, { uri: barrel, text: barrelSource }, { uri: outer, text: outerSource }, { uri, text: source }];
    expect(findWorkspaceDefinition(source, uri, position(1, source.split("\n")[1].indexOf("Local")), docs)).toMatchObject({ uri: library });
    expect(findWorkspaceDefinition(barrelSource, barrel, position(0, barrelSource.indexOf("Place")), docs)).toMatchObject({ uri: library });
    const original = rename(libSource, library, position(0, libSource.indexOf("Country")), "Region", docs);
    expect(original?.changes?.[library]).toHaveLength(1);
    expect(original?.changes?.[barrel]?.map(edit => edit.range.start.character)).toEqual([barrelSource.indexOf("Country")]);
    expect(original?.changes?.[outer]).toBeUndefined();
    expect(original?.changes?.[uri]).toBeUndefined();
    const firstAlias = rename(barrelSource, barrel, position(0, barrelSource.indexOf("Place")), "Area", docs);
    expect(firstAlias?.changes?.[barrel]?.map(edit => edit.range.start.character)).toEqual([barrelSource.indexOf("Place")]);
    expect(firstAlias?.changes?.[outer]?.map(edit => edit.range.start.character)).toEqual([outerSource.indexOf("Place")]);
    expect(firstAlias?.changes?.[uri]).toBeUndefined();
    const secondAlias = rename(outerSource, outer, position(0, outerSource.indexOf("Nation")), "Region", docs);
    expect(secondAlias?.changes?.[outer]?.map(edit => edit.range.start.character)).toEqual([outerSource.indexOf("Nation")]);
    expect(secondAlias?.changes?.[uri]?.map(edit => edit.range.start.character)).toEqual([source.indexOf("Nation")]);
    const localAlias = rename(source, uri, position(1, source.split("\n")[1].indexOf("Local")), "Area", docs);
    expect(localAlias?.changes?.[uri]?.map(edit => [edit.range.start.line, edit.range.start.character])).toEqual([[0, source.indexOf("Local")], [1, source.split("\n")[1].indexOf("Local")]]);
    expect(localAlias?.changes?.[outer]).toBeUndefined();
  });

  it("propagates renames through unaliased re-exports and rejects unresolved paths", () => {
    const library = "file:///project/lib.fun";
    const barrel = "file:///project/barrel.fun";
    const libSource = "export schema Country = { code: String }";
    const barrelSource = 'export { Country } from "./lib.js"';
    const source = 'import { Country } from "./barrel.js"\nexport read = (value: Country) => value';
    const docs = [{ uri: library, text: libSource }, { uri: barrel, text: barrelSource }, { uri, text: source }];
    const edits = rename(libSource, library, position(0, libSource.indexOf("Country")), "Region", docs);
    expect(edits?.changes?.[library]).toHaveLength(1);
    expect(edits?.changes?.[barrel]).toHaveLength(1);
    expect(edits?.changes?.[uri]).toHaveLength(2);
    const missing = docs.filter(doc => doc.uri !== library);
    expect(findWorkspaceDefinition(source, uri, position(1, source.split("\n")[1].indexOf("Country")), missing)).toBeNull();
    expect(rename(source, uri, position(1, source.split("\n")[1].indexOf("Country")), "Region", missing)).toBeNull();
    expect(prepareRename(source, uri, position(1, source.split("\n")[1].indexOf("Country")), missing)).toBeNull();
    const cyclic = [{ uri: library, text: 'export { Country } from "./barrel.js"' }, { uri: barrel, text: barrelSource }, { uri, text: source }];
    expect(rename(source, uri, position(1, source.split("\n")[1].indexOf("Country")), "Region", cyclic)).toBeNull();
    const ambiguous = [...docs, { uri: "file:///project/lib.ts", text: "export const Country = {}" }];
    expect(findWorkspaceDefinition(source, uri, position(1, source.split("\n")[1].indexOf("Country")), ambiguous)).toBeNull();
    expect(rename(source, uri, position(1, source.split("\n")[1].indexOf("Country")), "Region", ambiguous)).toBeNull();
  });

  it("refuses unresolved or ambiguous imports at the first hop", () => {
    const source = 'import { Country } from "./lib.js"\nexport read = (value: Country) => value';
    const pos = position(1, source.split("\n")[1].indexOf("Country"));
    const missing = [{ uri, text: source }];
    expect(findWorkspaceDefinition(source, uri, pos, missing)).toMatchObject({ uri });
    expect(prepareRename(source, uri, pos, missing)).toBeNull();
    const ambiguous = [...missing, { uri: "file:///project/lib.fun", text: "export schema Country = { code: String }" }, { uri: "file:///project/lib.ts", text: "export const Country = {}" }];
    expect(findWorkspaceDefinition(source, uri, pos, ambiguous)).toMatchObject({ uri });
    expect(rename(source, uri, pos, "Region", ambiguous)).toBeNull();
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
