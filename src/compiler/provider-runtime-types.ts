import type {
  ProviderRuntimeExportV1_1,
  ProviderSchemaNodeV1,
} from "../providers/contract.js";

/** Render validated provider runtime descriptions as TypeScript type text. */
export function renderProviderRuntimeType(node: ProviderSchemaNodeV1): string {
  return renderNode(node, new Set());
}

/** Render a data-only runtime export description as a TypeScript type. */
export function renderProviderRuntimeExportType(
  value: ProviderRuntimeExportV1_1,
): string {
  assertObject(value, "runtime export");
  assertName(value.name, "runtime export name");
  if (!("type" in value)) {
    if (!Array.isArray(value.parameters) || value.result === undefined) {
      throw new Error("Invalid provider callable runtime export");
    }
    const names = new Set<string>();
    const parameters = value.parameters.map((parameter) => {
      assertObject(parameter, "callable parameter");
      assertName(parameter.name, "callable parameter name");
      if (names.has(parameter.name))
        throw new Error(`Duplicate callable parameter '${parameter.name}'`);
      names.add(parameter.name);
      return `${parameter.name}: ${renderNode(parameter.type, new Set())}`;
    });
    return `(${parameters.join(", ")}) => ${renderNode(value.result, new Set())}`;
  }
  return renderNode(value.type, new Set());
}

function renderNode(
  node: ProviderSchemaNodeV1,
  ancestors: Set<object>,
): string {
  assertObject(node, "schema node");
  if (ancestors.has(node)) throw new Error("Cyclic provider schema node");
  const next = new Set(ancestors).add(node);
  switch (node.kind) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "bytes":
      return "Uint8Array";
    case "array":
      return `ReadonlyArray<${renderNode(node.items, next)}>`;
    case "union":
      if (!Array.isArray(node.alternatives) || node.alternatives.length === 0)
        throw new Error("Provider union must have alternatives");
      return node.alternatives
        .map((item) => renderNode(item, next))
        .join(" | ");
    case "object": {
      if (
        !Array.isArray(node.properties) ||
        !Array.isArray(node.required) ||
        (node.additionalProperties !== "allow" &&
          node.additionalProperties !== "reject")
      ) {
        throw new Error("Invalid provider object schema");
      }
      const properties = new Map<string, ProviderSchemaNodeV1>();
      for (const property of node.properties) {
        assertObject(property, "object property");
        assertName(property.name, "object property name");
        if (properties.has(property.name))
          throw new Error(`Duplicate provider property '${property.name}'`);
        properties.set(property.name, property.schema);
      }
      const required = new Set<string>();
      for (const name of node.required) {
        assertName(name, "required property name");
        if (!properties.has(name) || required.has(name))
          throw new Error(`Invalid required provider property '${name}'`);
        required.add(name);
      }
      const fields = [...properties].map(
        ([name, schema]) =>
          `${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${renderNode(schema, next)}`,
      );
      if (node.additionalProperties === "allow")
        fields.push("[key: string]: unknown");
      return `{ ${fields.join("; ")} }`;
    }
    default:
      throw new Error("Unsupported provider schema node");
  }
}

function assertObject(
  value: unknown,
  label: string,
): asserts value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid provider ${label}`);
}

function assertName(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
}
