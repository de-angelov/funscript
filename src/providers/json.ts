/** Convert a deliberately bounded JSON Schema subset to an Effect schema expression. */
export function jsonSchema(source: string): string {
  const root: unknown = JSON.parse(source);
  function convert(value: unknown, at: string): string {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`${at}: expected a JSON Schema object`);
    const schema = value as Record<string, unknown>;
    const allowed = new Set([
      "$schema",
      "$id",
      "title",
      "description",
      "type",
      "properties",
      "required",
      "items",
      "enum",
      "const",
    ]);
    for (const key of Object.keys(schema))
      if (!allowed.has(key))
        throw new Error(`${at}: unsupported JSON Schema keyword '${key}'`);
    const literal = (v: unknown): string => {
      if (v === null) return "Schema.Null";
      if (
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean"
      )
        return `Schema.Literal(${JSON.stringify(v)})`;
      throw new Error(`${at}: only scalar enum and const values are supported`);
    };
    if ("enum" in schema || "const" in schema) {
      if (
        "type" in schema ||
        "properties" in schema ||
        "items" in schema ||
        "required" in schema ||
        ("enum" in schema && "const" in schema)
      )
        throw new Error(
          `${at}: enum or const cannot be combined with other validation keywords`,
        );
      const values = "const" in schema ? [schema.const] : schema.enum;
      if (!Array.isArray(values) || values.length === 0)
        throw new Error(`${at}: enum must be a nonempty array`);
      const members = values.map(literal);
      return members.length === 1
        ? members[0]
        : `Schema.Union([${members.join(", ")}])`;
    }
    if (typeof schema.type !== "string")
      throw new Error(`${at}: an explicit type is required`);
    if (schema.type === "object") {
      if ("items" in schema) throw new Error(`${at}: items requires an array`);
      if (
        !schema.properties ||
        typeof schema.properties !== "object" ||
        Array.isArray(schema.properties)
      )
        throw new Error(`${at}: object requires properties`);
      const fields = schema.properties as Record<string, unknown>;
      const required = schema.required ?? [];
      if (
        !Array.isArray(required) ||
        required.some((v) => typeof v !== "string") ||
        new Set(required).size !== required.length
      )
        throw new Error(
          `${at}: required must be an array of unique property names`,
        );
      for (const name of required)
        if (!Object.hasOwn(fields, name))
          throw new Error(`${at}: required property '${name}' has no schema`);
      return `Schema.Struct({ ${Object.entries(fields)
        .map(([name, child]) => {
          const expression = convert(
            child,
            `${at}.properties[${JSON.stringify(name)}]`,
          );
          return `[${JSON.stringify(name)}]: ${required.includes(name) ? expression : `Schema.optionalKey(${expression})`}`;
        })
        .join(", ")} })`;
    }
    if ("properties" in schema || "required" in schema)
      throw new Error(`${at}: properties and required require an object`);
    if (schema.type === "array") {
      if (!("items" in schema))
        throw new Error(`${at}: arrays require an items schema`);
      return `Schema.Array(${convert(schema.items, `${at}.items`)})`;
    }
    if ("items" in schema) throw new Error(`${at}: items requires an array`);
    const primitives: Record<string, string> = {
      string: "Schema.String",
      number: "Schema.Finite",
      integer: "Schema.Int",
      boolean: "Schema.Boolean",
      null: "Schema.Null",
    };
    if (!Object.hasOwn(primitives, schema.type))
      throw new Error(`${at}: unsupported JSON Schema type '${schema.type}'`);
    return primitives[schema.type];
  }
  return convert(root, "$");
}

/** Infer a structural schema from a JSON example; samples are not guarantees. */
export function jsonSample(source: string): string {
  const root: unknown = JSON.parse(source);
  function infer(value: unknown, at: string): string {
    if (value === null) return "Schema.Null";
    if (typeof value === "string") return "Schema.String";
    if (typeof value === "number") return "Schema.Finite";
    if (typeof value === "boolean") return "Schema.Boolean";
    if (Array.isArray(value)) {
      if (!value.length)
        throw new Error(
          `${at}: cannot infer the element type of an empty array`,
        );
      if (value.length > 1000)
        throw new Error(`${at}: sample arrays cannot exceed 1000 elements`);
      const members = [
        ...new Set(value.map((item, index) => infer(item, `${at}[${index}]`))),
      ];
      const element =
        members.length === 1
          ? members[0]
          : `Schema.Union([${members.join(", ")}])`;
      return `Schema.Array(${element})`;
    }
    if (typeof value === "object") {
      const fields = Object.entries(value as Record<string, unknown>).map(
        ([name, child]) =>
          `[${JSON.stringify(name)}]: ${infer(child, `${at}[${JSON.stringify(name)}]`)}`,
      );
      return `Schema.Struct({ ${fields.join(", ")} })`;
    }
    throw new Error(`${at}: unsupported JSON value`);
  }
  return infer(root, "$");
}
