/** Data-only project registry for external providers. This module never loads providers. */

export type ProviderTrustPolicy = "trusted" | "untrusted";

export interface ProviderRegistryEntry {
  /** Package-qualified identity, for example `@acme/catalog/provider`. */
  id: string;
  moduleSpecifier: string;
  version: string;
  trust: ProviderTrustPolicy;
}

export type ProviderRegistry = ReadonlyMap<
  string,
  Readonly<ProviderRegistryEntry>
>;

const packageQualifiedId =
  /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/i;
const packageSpecifier =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i;
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Validate literal registry data without resolving or importing any module. */
export function createProviderRegistry(input: unknown): ProviderRegistry {
  if (!Array.isArray(input))
    throw new Error("provider registry must be an array");
  const entries = new Map<string, Readonly<ProviderRegistryEntry>>();
  for (const [index, value] of input.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`provider registry entry ${index} must be an object`);
    const entry = value as Record<string, unknown>;
    if (typeof entry.id !== "string" || !packageQualifiedId.test(entry.id))
      throw new Error(
        `provider registry entry ${index} has malformed package-qualified id`,
      );
    if (
      typeof entry.moduleSpecifier !== "string" ||
      !packageSpecifier.test(entry.moduleSpecifier)
    )
      throw new Error(
        `provider registry entry ${index} has malformed module specifier`,
      );
    if (typeof entry.version !== "string" || !semver.test(entry.version))
      throw new Error(`provider registry entry ${index} has malformed version`);
    if (entry.trust !== "trusted" && entry.trust !== "untrusted")
      throw new Error(
        `provider registry entry ${index} requires explicit trust`,
      );
    if (entries.has(entry.id))
      throw new Error(`duplicate provider id '${entry.id}'`);
    if (entry.trust !== "trusted")
      throw new Error(`provider '${entry.id}' is not trusted`);
    entries.set(
      entry.id,
      Object.freeze({
        id: entry.id,
        moduleSpecifier: entry.moduleSpecifier,
        version: entry.version,
        trust: entry.trust,
      }),
    );
  }
  return entries;
}
