import { fileURLToPath } from "node:url";
import type { DatabaseDeclaration, Program } from "../ast/types.js";
import {
  PROVIDER_CONTRACT_V1_1,
  type ProviderManifestV1,
  type ProviderRequestV1,
  type ProviderResultV1,
} from "../providers/contract.js";
import { authorizeProviderPaths } from "./provider-paths.js";
import {
  invokeTrustedProvider,
  type ProviderModuleLoader,
} from "./provider-invocation.js";
import type { ProviderRegistry } from "./provider-registry.js";

export class ProviderResolutionError extends Error {
  constructor(
    message: string,
    readonly declaration: DatabaseDeclaration,
  ) {
    super(message);
    this.name = "ProviderResolutionError";
  }
}

export interface PreparedProviderResult {
  name: string;
  providerId: string;
  declarationId: string;
  span: DatabaseDeclaration["span"];
  exported: boolean;
  result: ProviderResultV1;
}

export interface PreparedProviderResults {
  results: ReadonlyArray<PreparedProviderResult>;
  dependencies: ProviderResultV1["dependencies"];
}

/** Resolve database declarations without emitting source or retaining provider data. */
export async function prepareProviderResults(
  program: Program,
  sourceFile: string,
  registry: ProviderRegistry,
  authorizedRoots: ReadonlyArray<string>,
  load: ProviderModuleLoader,
): Promise<PreparedProviderResults> {
  const source = sourceFile.startsWith("file:")
    ? fileURLToPath(sourceFile)
    : sourceFile;
  const declarations = program.body.flatMap((item) => {
    const exported = item.kind === "ExportDeclaration";
    const decl = exported ? item.declaration : item;
    return decl.kind === "DatabaseDeclaration"
      ? [{ declaration: decl, exported }]
      : [];
  });
  const results: PreparedProviderResult[] = [];
  const dependencyMap = new Map<
    string,
    ProviderResultV1["dependencies"][number]
  >();

  for (const { declaration, exported } of declarations) {
    try {
      const matches = [...registry.values()].filter(
        (entry) => entry.id.split("/").at(-1) === declaration.provider,
      );
      if (matches.length !== 1)
        throw new Error(
          matches.length === 0
            ? `Provider '${declaration.provider}' is not registered`
            : `Provider '${declaration.provider}' is ambiguous in the registry`,
        );
      const entry = matches[0];
      if (entry.trust !== "trusted")
        throw new Error(`Provider '${entry.id}' is not trusted`);

      const request: ProviderRequestV1 = {
        // Offer the highest contract minor implemented by this host. The
        // invocation layer negotiates down against the loaded manifest.
        contract: PROVIDER_CONTRACT_V1_1,
        provider: { id: entry.id, version: entry.version },
        declaration: {
          source,
          name: declaration.id.name,
          span: declaration.span,
        },
        arguments: declaration.arguments,
        paths: [],
      };
      let authorizedPaths: ProviderRequestV1["paths"] = [];
      const preparedLoader: ProviderModuleLoader = async (specifier) => {
        const loaded = await load(specifier);
        const provider =
          isRecord(loaded) && "default" in loaded ? loaded.default : loaded;
        if (!isRecord(provider) || !isManifest(provider.manifest))
          throw new Error(
            "Trusted provider does not implement the V1 interface",
          );
        authorizedPaths = authorizeProviderPaths(
          provider.manifest,
          source,
          declaration.arguments,
          authorizedRoots,
        );
        return {
          ...provider,
          provide: (received: ProviderRequestV1) =>
            (
              provider.provide as (
                request: ProviderRequestV1,
              ) => Promise<unknown>
            )({ ...received, paths: authorizedPaths }),
        };
      };
      const result = await invokeTrustedProvider(
        registry,
        request,
        preparedLoader,
      );
      if (
        result.diagnostics.some(
          (diagnostic) =>
            !isRecord(diagnostic) ||
            typeof diagnostic.code !== "string" ||
            (diagnostic.severity !== "error" &&
              diagnostic.severity !== "warning") ||
            typeof diagnostic.message !== "string",
        )
      )
        throw new Error("Provider returned malformed diagnostics");
      const errorDiagnostic = result.diagnostics.find(
        (diagnostic) => diagnostic.severity === "error",
      );
      if (errorDiagnostic)
        throw new Error(`Provider reported ${errorDiagnostic.code}`);
      results.push({
        name: declaration.id.name,
        providerId: entry.id,
        declarationId: `${declaration.span.start.offset}:${declaration.span.end.offset}`,
        span: declaration.span,
        exported,
        result,
      });
      for (const dependency of result.dependencies)
        dependencyMap.set(dependencyKey(dependency), dependency);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Provider resolution failed";
      throw new ProviderResolutionError(
        `Database '${declaration.id.name}' (${declaration.provider}): ${message}`,
        declaration,
      );
    }
  }

  return {
    results,
    dependencies: [...dependencyMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, dependency]) => dependency),
  };
}

function dependencyKey(
  dependency: ProviderResultV1["dependencies"][number],
): string {
  return dependency.kind === "file"
    ? `file:${dependency.path}`
    : `external:${dependency.key}:${dependency.fingerprint}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isManifest(value: unknown): value is ProviderManifestV1 {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.version === "string" &&
    Array.isArray(value.parameters)
  );
}
