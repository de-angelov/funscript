import type { ProviderSchemaNodeV1 } from "../providers/contract.js";

/** Render the primitive subset of the V1 provider schema contract. */
export function renderProviderSchema(node: ProviderSchemaNodeV1): string {
  switch (node.kind) {
    case "string":
      return "Schema.String";
    case "number":
      return "Schema.Finite";
    case "boolean":
      return "Schema.Boolean";
    case "null":
      return "Schema.Null";
    default:
      throw new Error(`Unsupported provider schema node '${node.kind}'`);
  }
}
