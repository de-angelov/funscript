import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProjectConfig } from "../src/compiler/project-config.js";

const provider =
  '{ name: "catalog", id: "@acme/catalog/provider", moduleSpecifier: "@acme/catalog-provider", version: "1.2.3", trust: "trusted" }';

function load(source: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "funscript-provider-config-"));
  writeFileSync(path.join(dir, "funscript.config.fun"), source);
  return { dir, config: loadProjectConfig(dir) };
}

describe("provider project config", () => {
  it("loads trusted providers and host-owned project path roots as data", () => {
    const { dir, config } = load(
      `export config = { providers: [${provider}], providerRoots: ["data", "assets/input"] }`,
    );
    expect(config.providers?.get("@acme/catalog/provider")).toEqual({
      id: "@acme/catalog/provider",
      moduleSpecifier: "@acme/catalog-provider",
      version: "1.2.3",
      trust: "trusted",
    });
    expect(config.providerRoots).toEqual([
      path.join(dir, "data"),
      path.join(dir, "assets/input"),
    ]);
  });

  it.each([
    `providers: [{ name: "catalog", id: "catalog", moduleSpecifier: "@acme/catalog-provider", version: "1.2.3", trust: "trusted" }]`,
    `providers: [${provider}, { name: "catalog", id: "@acme/other/provider", moduleSpecifier: "@acme/other", version: "1.0.0", trust: "trusted" }]`,
    `providers: [{ name: "catalog", id: "@acme/catalog/provider", moduleSpecifier: "../provider", version: "1.2.3", trust: "trusted" }]`,
    `providers: [{ name: "catalog", id: "@acme/catalog/provider", moduleSpecifier: "@acme/catalog-provider", version: "latest", trust: "trusted" }]`,
    `providers: [{ name: "catalog", id: "@acme/catalog/provider", moduleSpecifier: "@acme/catalog-provider", version: "1.2.3" }]`,
    `providers: [{ name: "catalog", id: "@acme/catalog/provider", moduleSpecifier: "@acme/catalog-provider", version: "1.2.3", trust: "untrusted" }]`,
    `providerRoots: ["../outside"]`,
  ])("rejects invalid provider configuration: %s", (fields) => {
    expect(() => load(`export config = { ${fields} }`)).toThrow(
      "invalid FunScript config",
    );
  });

  it("does not execute modules while parsing provider configuration", () => {
    const { config } = load(`export config = { providers: [${provider}] }`);
    expect(
      config.providers?.get("@acme/catalog/provider")?.moduleSpecifier,
    ).toBe("@acme/catalog-provider");
  });
});
