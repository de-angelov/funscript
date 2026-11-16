import { describe, expect, it } from "vitest";
import { ParsedDocumentCache } from "../src/lsp/parsed-documents.js";

describe("parsed document cache", () => {
  it("reuses identical text and reparses after valid or invalid edits", () => {
    const cache = new ParsedDocumentCache();
    const uri = "file:///project/main.fun";
    const first = cache.get({ uri, text: "value = 1" });
    expect(cache.get({ uri, text: "value = 1" })).toBe(first);
    const broken = cache.get({ uri, text: "value = (" });
    expect(broken.ast).toBeNull();
    expect(cache.get({ uri, text: "value = (" })).toBe(broken);
    const fixed = cache.get({ uri, text: "value = 2" });
    expect(fixed.ast).not.toBeNull();
    expect(fixed).not.toBe(first);
    cache.retain([]);
    expect(cache.get({ uri, text: "value = 2" })).not.toBe(fixed);
  });
});
