import { describe, expect, it } from "vitest";
import type {
  FunscriptProviderV1,
  ProviderRequestV1,
} from "../src/providers/contract.js";
import { invokeTrustedProvider } from "../src/compiler/provider-invocation.js";
import { createProviderRegistry } from "../src/compiler/provider-registry.js";

const entry = {
  id: "@example/catalog/provider",
  moduleSpecifier: "@example/catalog-provider",
  version: "1.2.0",
  trust: "trusted" as const,
};
const fixture: FunscriptProviderV1 = {
  manifest: {
    id: entry.id,
    version: entry.version,
    contract: { major: 1, minMinor: 0, maxMinor: 0 },
    parameters: [
      { name: "source", kind: "string", required: true, path: true },
    ],
    inputRoots: [],
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
      dependencies: [],
      diagnostics: [],
    };
  },
};
const request: ProviderRequestV1 = {
  contract: { major: 1, minor: 0 },
  provider: { id: entry.id, version: entry.version },
  declaration: {
    source: "/project/main.fun",
    name: "Catalog",
    span: {
      start: { offset: 0, line: 1, column: 1 },
      end: { offset: 12, line: 1, column: 13 },
    },
  },
  arguments: ["catalog.json"],
  paths: [{ argumentIndex: 0, canonicalPath: "/project/data/catalog.json" }],
};

describe("trusted provider invocation", () => {
  it("accepts structured callable exports with negotiated contract minor 1", async () => {
    const callableRequest = {
      ...request,
      contract: { major: 1 as const, minor: 1 },
    };
    const callableFixture: FunscriptProviderV1 = {
      ...fixture,
      manifest: {
        ...fixture.manifest,
        contract: { major: 1, minMinor: 0, maxMinor: 1 },
      },
    };
    const result = await invokeTrustedProvider(
      createProviderRegistry([entry]),
      callableRequest,
      async () => ({
        ...callableFixture,
        async provide(req) {
          const output = await callableFixture.provide(req);
          return {
            ...output,
            contract: req.contract,
            runtimeModule: {
              specifier: "@example/catalog-runtime",
              exports: [
                {
                  name: "findCatalog",
                  parameters: [
                    { name: "id", type: { kind: "string" as const } },
                  ],
                  result: { kind: "string" as const },
                },
              ],
            },
          };
        },
      }),
    );
    expect(result.runtimeModule?.exports[0]).toMatchObject({
      name: "findCatalog",
      parameters: [{ name: "id", type: { kind: "string" } }],
    });
  });

  it("rejects malformed callable signatures and callables under contract 1.0", async () => {
    const registry = createProviderRegistry([entry]);
    const malformed = async (minor: number, callable: unknown) => {
      const requestAtVersion = {
        ...request,
        contract: { major: 1 as const, minor },
      };
      const provider: FunscriptProviderV1 = {
        ...fixture,
        manifest: {
          ...fixture.manifest,
          contract: { major: 1, minMinor: 0, maxMinor: 1 },
        },
        async provide(req) {
          const output = await fixture.provide(req);
          return {
            ...output,
            contract: req.contract,
            runtimeModule: {
              specifier: "@example/runtime",
              exports: [callable as never],
            },
          };
        },
      };
      return invokeTrustedProvider(
        registry,
        requestAtVersion,
        async () => provider,
      );
    };
    await expect(
      malformed(1, {
        name: "bad-name",
        parameters: [],
        result: { kind: "string" },
      }),
    ).rejects.toThrow(/malformed runtime module/);
    await expect(
      malformed(1, {
        name: "call",
        parameters: [{ name: "x", type: { kind: "string" }, optional: true }],
        result: { kind: "string" },
      }),
    ).rejects.toThrow(/malformed runtime module/);
    await expect(
      malformed(0, {
        name: "call",
        parameters: [],
        result: { kind: "string" },
      }),
    ).rejects.toThrow(/malformed runtime module/);
  });

  it("loads only an explicitly trusted registered module and returns its data", async () => {
    const load = async (specifier: string) => {
      expect(specifier).toBe(entry.moduleSpecifier);
      return { default: fixture };
    };
    const result = await invokeTrustedProvider(
      createProviderRegistry([entry]),
      request,
      load,
    );
    expect(result.schema.kind).toBe("object");
    expect(result.runtimeModule?.exports[0]?.name).toBe("Catalog");
  });

  it("does not load unregistered or untrusted providers", async () => {
    let loads = 0;
    const load = async () => {
      loads++;
      return fixture;
    };
    await expect(
      invokeTrustedProvider(createProviderRegistry([]), request, load),
    ).rejects.toThrow(/not registered/);
    const untrusted = new Map([
      [entry.id, { ...entry, trust: "untrusted" as const }],
    ]);
    await expect(
      invokeTrustedProvider(untrusted, request, load),
    ).rejects.toThrow(/not trusted/);
    expect(loads).toBe(0);
  });

  it("rejects version and static parameter mismatches before invocation", async () => {
    const registry = createProviderRegistry([entry]);
    const load = async () => fixture;
    await expect(
      invokeTrustedProvider(
        registry,
        { ...request, provider: { ...request.provider, version: "2.0.0" } },
        load,
      ),
    ).rejects.toThrow(/version mismatch/);
    await expect(
      invokeTrustedProvider(registry, { ...request, arguments: [42] }, load),
    ).rejects.toThrow(/must be string/);
  });

  it("rejects malformed provider responses and safely reports thrown failures", async () => {
    const registry = createProviderRegistry([entry]);
    const bad: FunscriptProviderV1 = {
      ...fixture,
      async provide() {
        return {
          contract: { major: 1, minor: 0 },
          schema: { kind: "made-up" },
        } as never;
      },
    };
    await expect(
      invokeTrustedProvider(registry, request, async () => bad),
    ).rejects.toThrow(/malformed result/);
    const throws: FunscriptProviderV1 = {
      ...fixture,
      async provide() {
        throw new Error("secret token");
      },
    };
    await expect(
      invokeTrustedProvider(registry, request, async () => throws),
    ).rejects.toThrow(/failed while processing 'Catalog'/);
    await expect(
      invokeTrustedProvider(registry, request, async () => throws),
    ).rejects.not.toThrow(/secret token/);
  });
});
