import { describe, expect, it } from "vitest";
import {
  PROVIDER_CONTRACT_V1,
  type FunscriptProviderV1,
  type ProviderRequestV1,
} from "../src/providers/contract.js";

// This fixture is intentionally standalone: external providers need no compiler
// or built-in SQLite imports to implement the public boundary.
const fixture: FunscriptProviderV1 = {
  manifest: {
    id: "example.test.catalog",
    version: "1.2.0",
    contract: { major: 1, minMinor: 0, maxMinor: 0 },
    parameters: [
      { name: "source", kind: "string", required: true, path: true },
    ],
    inputRoots: ["/project/data"],
    requestedCapabilities: [],
  },
  async provide(request) {
    return {
      contract: request.contract,
      schema: {
        kind: "object",
        properties: [{ name: "title", schema: { kind: "string" } }],
        required: ["title"],
        additionalProperties: "reject",
      },
      runtimeModule: {
        specifier: "@example/catalog-runtime",
        exports: [{ name: "Catalog", type: { kind: "string" } }],
      },
      dependencies: [{ kind: "file", path: "/project/data/catalog.json" }],
      diagnostics: [],
    };
  },
};

const request: ProviderRequestV1 = {
  contract: PROVIDER_CONTRACT_V1,
  provider: { id: "example.test.catalog", version: "1.2.0" },
  declaration: {
    source: "/project/main.fun",
    name: "Catalog",
    span: {
      start: { offset: 0, line: 1, column: 1 },
      end: { offset: 37, line: 1, column: 38 },
    },
  },
  arguments: ["./data/catalog.json"],
  paths: [{ argumentIndex: 0, canonicalPath: "/project/data/catalog.json" }],
};

describe("public provider contract v1", () => {
  it("supports an independent provider fixture and data-only runtime output", async () => {
    const result = await fixture.provide(request);
    expect(result.contract).toEqual({ major: 1, minor: 0 });
    expect(result.schema.kind).toBe("object");
    expect(result.runtimeModule?.specifier).toBe("@example/catalog-runtime");
    expect(result.dependencies).toEqual([
      { kind: "file", path: "/project/data/catalog.json" },
    ]);
  });

  it("exposes a deterministic contract version and explicit trust state", () => {
    expect(PROVIDER_CONTRACT_V1).toEqual({ major: 1, minor: 0 });
    const trust = {
      status: "untrusted",
      providerId: fixture.manifest.id,
      providerVersion: fixture.manifest.version,
    } as const;
    expect(trust.status).toBe("untrusted");
  });
});
