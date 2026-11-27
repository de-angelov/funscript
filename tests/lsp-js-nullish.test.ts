import { describe, expect, it } from "vitest";
import { findFillMatchArmsCodeActions } from "../src/lsp/match-arms.js";

const uri = "file:///tmp/nullish-actions.fun";
const range = {
  start: { line: 1, character: 0 },
  end: { line: 5, character: 0 },
};

describe("JSNullish match completion", () => {
  it("suggests each missing nullish case", () => {
    const source = `export show = (value: JSNullish<String>) =>
  match value
    | Success(text) => text`;
    const action = findFillMatchArmsCodeActions(source, uri, range)[0];
    const inserted = action.edit!.changes![uri][0].newText;
    expect(inserted).toContain("| Failure(Null) => ???");
    expect(inserted).toContain("| Failure(Undefined) => ???");
    expect(inserted).not.toContain("Success");
  });

  it("counts only unguarded branches and treats a failure binding as both nullish cases", () => {
    const source = `export show = (value: JSNullish<String>) =>
  match value
    | Success(text) when text.length #= 0 => "empty"
    | Failure(reason) => "missing"`;
    const inserted = findFillMatchArmsCodeActions(source, uri, range)[0].edit!
      .changes![uri][0].newText;
    expect(inserted).toContain("| Success(value) => ???");
    expect(inserted).not.toContain("Failure");
  });

  it("understands inline JSX-style props without mixing parameter scopes", () => {
    const source = `export view = (props: { text: JSNullish<String> }) =>
  match props.text
    | Failure(Null) => "null"`;
    const inserted = findFillMatchArmsCodeActions(source, uri, range)[0].edit!
      .changes![uri][0].newText;
    expect(inserted).toContain("| Success(value) => ???");
    expect(inserted).toContain("| Failure(Undefined) => ???");
    expect(inserted).not.toContain("Failure(Null)");
  });

  it("does not treat a different function's matching parameter as JSNullish", () => {
    const source = `first = (value: JSNullish<String>) => value
export show = (value: Unknown) =>
  match value
    | Success(text) => text`;
    expect(findFillMatchArmsCodeActions(source, uri, range)).toEqual([]);
  });

  it("does not offer an action after complete matching", () => {
    const source = `export show = (value: JSNullish<String>) =>
  match value
    | Success(text) => text
    | Failure(reason) => "missing"`;
    expect(findFillMatchArmsCodeActions(source, uri, range)).toEqual([]);
  });

  it("tracks BindingDeclaration annotations and OrPattern arms for JSNullish", () => {
    const source = `export out = () =>
  value: JSNullish<String> = "hi"
  => match value
    | Failure(Null) | Failure(Undefined) => "missing"`;
    const inserted = findFillMatchArmsCodeActions(source, uri, {
      start: { line: 2, character: 5 },
      end: { line: 2, character: 5 },
    })[0].edit!.changes![uri][0].newText;
    expect(inserted).toContain("| Success(value) => ???");
    expect(inserted).not.toContain("Failure(Null)");
    expect(inserted).not.toContain("Failure(Undefined)");
  });
});
