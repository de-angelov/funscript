import type { ProviderSchemaNodeV1 } from "../providers/contract.js";

/** Render provider schema nodes as Effect Schema expressions. */
export function renderProviderSchema(node: ProviderSchemaNodeV1): string {
  switch (node.kind) {
    case "string":
      return "Schema.String";
    case "number":
      return "Schema.Finite";
    case "boolean":
      return "Schema.Boolean";
    case "bytes":
      return "Schema.Uint8Array";
    case "null":
      return "Schema.Null";
    case "array":
      return `Schema.Array(${renderProviderSchema(node.items)})`;
    case "object": {
      if (node.additionalProperties === "reject") {
        throw new Error(
          "Provider object additionalProperties 'reject' cannot be enforced by an Effect Schema expression; use 'allow' or validate excess keys at the decode boundary",
        );
      }
      const required = new Set(node.required);
      const fields = node.properties.map(({ name, schema }) => {
        const rendered = renderProviderSchema(schema);
        const value = required.has(name)
          ? rendered
          : `Schema.optional(${rendered})`;
        return `[${JSON.stringify(name)}]: ${value}`;
      });
      return `Schema.Struct({ ${fields.join(", ")} })`;
    }
    case "union":
      return `Schema.Union([${node.alternatives.map(renderProviderSchema).join(", ")}])`;
    default:
      throw new Error("Unsupported provider schema node");
  }
}
