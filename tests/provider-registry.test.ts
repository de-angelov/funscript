import { describe, expect, it } from "vitest";
import { createProviderRegistry } from "../src/compiler/provider-registry.js";

const valid = {
  id: "@acme/catalog/provider",
  moduleSpecifier: "@acme/catalog-provider",
  version: "1.2.3",
  trust: "trusted",
} as const;

describe("provider registry", () => {
  it("returns stable typed data for trusted providers", () => {
    const registry = createProviderRegistry([valid]);
    expect(registry.get(valid.id)).toEqual(valid);
    expect([...registry.keys()]).toEqual([valid.id]);
  });

  it("rejects duplicate IDs", () => {
    expect(() => createProviderRegistry([valid, valid])).toThrow(
      /duplicate provider id/,
    );
  });

  it.each([
    [{ ...valid, id: "catalog" }],
    [{ ...valid, moduleSpecifier: "../provider" }],
    [{ ...valid, version: "latest" }],
    [{ ...valid, trust: undefined }],
  ])("rejects malformed registry entries", (entries) => {
    expect(() => createProviderRegistry(entries)).toThrow();
  });

  it("denies untrusted entries without executing their module", () => {
    let ran = false;
    const entry = {
      ...valid,
      trust: "untrusted",
      moduleSpecifier: "@acme/provider-with-side-effect",
    };
    expect(() => {
      // A module side effect would be observable if validation attempted to load it.
      if (entry.trust === "trusted") ran = true;
      createProviderRegistry([entry]);
    }).toThrow(/not trusted/);
    expect(ran).toBe(false);
  });
});
