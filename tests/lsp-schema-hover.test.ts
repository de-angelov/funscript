import { describe, expect, it } from "vitest";
import { findHover } from "../src/lsp/hover.js";

function hoverName(source: string, name: string): string {
  const index = source.indexOf(name);
  const before = source.slice(0, index).split("\n");
  const hover = findHover(source, "file:///project/model.fun", { line: before.length - 1, character: before.at(-1)!.length });
  return (hover?.contents as { value?: string } | undefined)?.value ?? "";
}

describe("data schema and contract hover", () => {
  it("explains how to instantiate a generic data schema", () => {
    const hover = hoverName("export schema Page<A> = { items: Array<A>, next?: String }", "Page");
    expect(hover).toContain("Generic data schema");
    expect(hover).toContain("Page(schemaForA)");
    expect(hover).toContain("runtime schemas");
  });

  it("distinguishes generic callback contracts from validated data", () => {
    const hover = hoverName("export schema Handler<A> = { handle: (value: A) => Void }", "Handler");
    expect(hover).toContain("Compile-time contract");
    expect(hover).toContain("does not validate data or callbacks");
  });

  it("recognizes a contract that refers to another local contract", () => {
    const source = "schema Callback = (value: String) => Void\nexport schema Props = { run: Callback }";
    expect(hoverName(source, "Props")).toContain("Compile-time contract");
  });

  it("identifies ordinary data schemas and avoids claims for invalid declarations", () => {
    expect(hoverName("export schema Country = { name: String }", "Country")).toContain("Data schema");
    expect(hoverName("export schema Box<A> = { value: Unknown }", "Box")).not.toContain("Generic data schema");
  });

  it("does not label a shadowing parameter as the schema declaration", () => {
    const source = "schema Page<A> = { value: A }\nexport read = (Page: String) => Page";
    const line = source.split("\n")[1];
    const hover = findHover(source, "file:///project/model.fun", { line: 1, character: line.indexOf("Page") });
    expect(JSON.stringify(hover)).not.toContain("Generic data schema");
  });
});
