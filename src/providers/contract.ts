/** Public, data-only contract for independently authored providers. */

export const PROVIDER_CONTRACT_V1 = { major: 1, minor: 0 } as const;

export type StaticProviderArgument = string | number | boolean;

export interface ProviderSourcePositionV1 {
  /** Zero-based UTF-16 offset in the source file. */
  offset: number;
  /** One-based line and column for display. */
  line: number;
  column: number;
}

export interface ProviderSourceSpanV1 {
  /** Half-open range in the declaring source. */
  start: ProviderSourcePositionV1;
  end: ProviderSourcePositionV1;
}

export interface ProviderStaticParameterV1 {
  name: string;
  kind: "string" | "number" | "boolean";
  required: boolean;
  /** A string path is resolved by the host and restricted to authorized roots. */
  path?: boolean;
}

export interface ProviderManifestV1 {
  id: string;
  version: string;
  contract: { major: 1; minMinor: number; maxMinor: number };
  parameters: ReadonlyArray<ProviderStaticParameterV1>;
  inputRoots: ReadonlyArray<string>;
  requestedCapabilities: ReadonlyArray<"external-refresh">;
}

export interface ProviderRequestV1 {
  contract: { major: 1; minor: number };
  provider: { id: string; version: string };
  declaration: { source: string; name: string; span: ProviderSourceSpanV1 };
  arguments: ReadonlyArray<StaticProviderArgument>;
  paths: ReadonlyArray<{ argumentIndex: number; canonicalPath: string }>;
}

export type ProviderSchemaNodeV1 =
  | { kind: "string" | "number" | "boolean" | "null" | "bytes" }
  | { kind: "array"; items: ProviderSchemaNodeV1 }
  | {
      kind: "object";
      properties: ReadonlyArray<{
        name: string;
        schema: ProviderSchemaNodeV1;
        description?: string;
      }>;
      required: ReadonlyArray<string>;
      additionalProperties: "allow" | "reject";
    }
  | { kind: "union"; alternatives: ReadonlyArray<ProviderSchemaNodeV1> };

export type ProviderDependencyV1 =
  | { kind: "file"; path: string }
  | { kind: "external"; key: string; fingerprint: string };

export interface ProviderDiagnosticV1 {
  code: string;
  severity: "error" | "warning";
  message: string;
  inputLocation?: { dependencyKey: string; start: number; end: number };
}

export interface ProviderRuntimeExportV1 {
  name: string;
  type: ProviderSchemaNodeV1;
}

export interface ProviderResultV1 {
  contract: { major: 1; minor: number };
  schema: ProviderSchemaNodeV1;
  runtimeModule?: {
    specifier: string;
    exports: ReadonlyArray<ProviderRuntimeExportV1>;
  };
  dependencies: ReadonlyArray<ProviderDependencyV1>;
  diagnostics: ReadonlyArray<ProviderDiagnosticV1>;
}

/** A provider is invoked by the host; its implementation is never loaded as a compiler plugin API. */
export interface FunscriptProviderV1 {
  manifest: ProviderManifestV1;
  provide(request: ProviderRequestV1): Promise<ProviderResultV1>;
}

/** Trust is granted by a host/user policy and is deliberately not a provider capability. */
export type ProviderTrustV1 =
  | { status: "trusted"; providerId: string; providerVersion: string }
  | { status: "untrusted"; providerId: string; providerVersion: string };
