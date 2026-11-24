import type {
  FunscriptProviderV1,
  ProviderRequestV1,
  ProviderResultV1,
  ProviderSchemaNodeV1,
} from "../providers/contract.js";
import type { ProviderRegistry } from "./provider-registry.js";

export type ProviderModuleLoader = (
  moduleSpecifier: string,
) => Promise<unknown>;

/**
 * Invoke a provider only after registry trust has been established. The caller
 * owns any module cache and must discard provider-owned state after invocation;
 * this helper retains neither loaded modules nor request/response data.
 */
export async function invokeTrustedProvider(
  registry: ProviderRegistry,
  request: ProviderRequestV1,
  load: ProviderModuleLoader,
): Promise<ProviderResultV1> {
  const entry = registry.get(request.provider.id);
  if (!entry)
    throw new Error(`Provider '${request.provider.id}' is not registered`);
  if (entry.trust !== "trusted")
    throw new Error(`Provider '${entry.id}' is not trusted`);
  if (entry.version !== request.provider.version)
    throw new Error(
      `Provider '${entry.id}' version mismatch: declared ${request.provider.version}, registered ${entry.version}`,
    );
  let module: unknown;
  try {
    module = await load(entry.moduleSpecifier);
  } catch {
    throw new Error(
      `Could not load trusted provider '${entry.id}' from '${entry.moduleSpecifier}'`,
    );
  }
  const provider =
    isRecord(module) && "default" in module ? module.default : module;
  if (!isProvider(provider))
    throw new Error(
      `Trusted provider '${entry.id}' does not implement the V1 interface`,
    );
  if (provider.manifest.id !== entry.id)
    throw new Error(
      `Provider identity mismatch: registry declares '${entry.id}', module declares '${provider.manifest.id}'`,
    );
  if (provider.manifest.version !== entry.version)
    throw new Error(
      `Provider '${entry.id}' version mismatch: registry declares ${entry.version}, module declares ${provider.manifest.version}`,
    );
  validateRequest(provider, request);

  let result: unknown;
  try {
    result = await provider.provide(request);
  } catch {
    throw new Error(
      `Provider '${entry.id}' failed while processing '${request.declaration.name}'`,
    );
  }
  if (
    !isRecord(result) ||
    !isContract(result.contract) ||
    result.contract.major !== 1 ||
    result.contract.minor !== request.contract.minor
  )
    throw new Error(
      `Provider '${entry.id}' returned an incompatible result envelope`,
    );
  if (
    !isSchema(result.schema) ||
    !Array.isArray(result.dependencies) ||
    !Array.isArray(result.diagnostics)
  )
    throw new Error(`Provider '${entry.id}' returned a malformed result`);
  if (
    result.runtimeModule !== undefined &&
    !isRuntimeModule(result.runtimeModule, request.contract.minor)
  )
    throw new Error(
      `Provider '${entry.id}' returned a malformed runtime module`,
    );
  return result as unknown as ProviderResultV1;
}

function validateRequest(
  provider: FunscriptProviderV1,
  request: ProviderRequestV1,
): void {
  const manifest = provider.manifest;
  if (
    request.contract.major !== manifest.contract.major ||
    request.contract.minor < manifest.contract.minMinor ||
    request.contract.minor > manifest.contract.maxMinor
  )
    throw new Error(
      `Provider '${manifest.id}' does not support contract ${request.contract.major}.${request.contract.minor}`,
    );
  for (let i = 0; i < manifest.parameters.length; i++) {
    const parameter = manifest.parameters[i];
    const value = request.arguments[i];
    if (value === undefined) {
      if (parameter.required)
        throw new Error(
          `Provider '${manifest.id}' requires parameter '${parameter.name}'`,
        );
      continue;
    }
    if (typeof value !== parameter.kind)
      throw new Error(
        `Provider '${manifest.id}' parameter '${parameter.name}' must be ${parameter.kind}`,
      );
  }
  if (request.arguments.length > manifest.parameters.length)
    throw new Error(`Provider '${manifest.id}' received too many parameters`);
  for (const path of request.paths) {
    const parameter = manifest.parameters[path.argumentIndex];
    if (
      !parameter?.path ||
      typeof request.arguments[path.argumentIndex] !== "string" ||
      !path.canonicalPath
    )
      throw new Error(
        `Provider '${manifest.id}' received an invalid resolved path parameter`,
      );
  }
}

function isProvider(value: unknown): value is FunscriptProviderV1 {
  return (
    isRecord(value) &&
    isRecord(value.manifest) &&
    typeof value.manifest.id === "string" &&
    typeof value.manifest.version === "string" &&
    isContractRange(value.manifest.contract) &&
    Array.isArray(value.manifest.parameters) &&
    typeof value.provide === "function"
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isContract(value: unknown): value is { major: number; minor: number } {
  return (
    isRecord(value) &&
    Number.isInteger(value.major) &&
    Number.isInteger(value.minor)
  );
}
function isContractRange(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.major === "number" &&
    Number.isInteger(value.major) &&
    typeof value.minMinor === "number" &&
    Number.isInteger(value.minMinor) &&
    typeof value.maxMinor === "number" &&
    Number.isInteger(value.maxMinor) &&
    value.minMinor <= value.maxMinor
  );
}
function isSchema(value: unknown): value is ProviderSchemaNodeV1 {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "string":
    case "number":
    case "boolean":
    case "null":
    case "bytes":
      return true;
    case "array":
      return isSchema(value.items);
    case "union":
      return (
        Array.isArray(value.alternatives) &&
        value.alternatives.length > 0 &&
        value.alternatives.every(isSchema)
      );
    case "object":
      return (
        Array.isArray(value.properties) &&
        value.properties.every(
          (p: unknown) =>
            isRecord(p) && typeof p.name === "string" && isSchema(p.schema),
        ) &&
        Array.isArray(value.required) &&
        value.required.every((n: unknown) => typeof n === "string") &&
        (value.additionalProperties === "allow" ||
          value.additionalProperties === "reject")
      );
    default:
      return false;
  }
}
function isRuntimeModule(value: unknown, minor: number): boolean {
  return (
    isRecord(value) &&
    typeof value.specifier === "string" &&
    value.specifier.length > 0 &&
    Array.isArray(value.exports) &&
    uniqueBy(value.exports, (item) =>
      isRecord(item) ? item.name : undefined,
    ) &&
    value.exports.every((item: unknown) => {
      if (!isRecord(item) || !isIdentifier(item.name)) return false;
      if ("type" in item)
        return (
          Object.keys(item).every((key) => key === "name" || key === "type") &&
          isSchema(item.type)
        );
      if (minor < 1 || !("parameters" in item) || !("result" in item))
        return false;
      return (
        Object.keys(item).every(
          (key) => key === "name" || key === "parameters" || key === "result",
        ) &&
        Array.isArray(item.parameters) &&
        uniqueBy(item.parameters, (parameter) =>
          isRecord(parameter) ? parameter.name : undefined,
        ) &&
        item.parameters.every(
          (parameter: unknown) =>
            isRecord(parameter) &&
            Object.keys(parameter).every(
              (key) => key === "name" || key === "type",
            ) &&
            isIdentifier(parameter.name) &&
            isSchema(parameter.type),
        ) &&
        isSchema(item.result)
      );
    })
  );
}
function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_$][\w$]*$/.test(value);
}
function uniqueBy(
  values: unknown[],
  keyOf: (value: unknown) => unknown,
): boolean {
  const keys = values.map(keyOf);
  return (
    keys.every((key) => key !== undefined) && new Set(keys).size === keys.length
  );
}
