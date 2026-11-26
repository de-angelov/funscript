import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import * as SchemaIssue from "effect/SchemaIssue";
import * as v from "valibot";

type ValibotSchema = v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>;

/** Convert the supported Effect Schema AST subset to native Valibot schemas. */
export function toValibotSchema(schema: Schema.Constraint): ValibotSchema {
  return effectAstToValibot(schema.ast);
}

function effectAstToValibot(ast: SchemaAST.AST): ValibotSchema {
  switch (ast._tag) {
    case "String":
      return v.string();
    case "Number":
      return v.number();
    case "Boolean":
      return v.boolean();
    case "BigInt":
      return v.bigint();
    case "Literal":
      return v.literal(
        ast.literal as string | number | boolean | bigint | symbol,
      );
    case "Arrays": {
      const item = ast.rest[0];
      if (!item || ast.elements.length)
        throw new TypeError("Unsupported Effect array schema");
      return v.array(effectAstToValibot(item));
    }
    case "Objects": {
      const entries: Record<string, ValibotSchema> = {};
      for (const field of ast.propertySignatures) {
        const child = effectAstToValibot(field.type);
        const alreadyOptional =
          field.type._tag === "Union" &&
          field.type.types.length === 2 &&
          field.type.types.some((type) => type._tag === "Undefined");
        const isOptional = Boolean(field.type.context?.isOptional);
        entries[String(field.name)] =
          isOptional && !alreadyOptional ? v.optional(child) : child;
      }
      return v.object(entries);
    }
    case "Union": {
      if (
        ast.types.length === 2 &&
        ast.types.some((type) => type._tag === "Undefined")
      ) {
        const inner = ast.types.find((type) => type._tag !== "Undefined");
        if (!inner) return v.undefined();
        return v.optional(effectAstToValibot(inner));
      }
      const tagged = ast.types.every((type) => type._tag === "Objects")
        ? findTagKey(ast.types as SchemaAST.Objects[])
        : undefined;
      const members = ast.types.map(effectAstToValibot);
      return tagged
        ? v.variant(
            tagged,
            members as unknown as Parameters<typeof v.variant>[1],
          )
        : v.union(members);
    }
    case "Undefined":
      return v.undefined();
    default:
      throw new TypeError(`Unsupported Effect schema AST: ${ast._tag}`);
  }
}

function findTagKey(objects: SchemaAST.Objects[]): string | undefined {
  const candidates = objects[0]?.propertySignatures ?? [];
  return candidates.find(
    (field) =>
      field.type._tag === "Literal" &&
      objects.every((object) =>
        object.propertySignatures.some(
          (other) => other.name === field.name && other.type._tag === "Literal",
        ),
      ),
  )?.name as string | undefined;
}

/** Wrap a Valibot schema as an Effect codec, preserving Valibot paths/messages. */
export function fromValibotSchema<
  T extends v.BaseSchema<never, unknown, v.BaseIssue<unknown>>,
>(
  schema: T,
): Schema.Codec<v.InferOutput<T>, v.InferInput<T>> &
  ((input: unknown) => v.InferOutput<T>) {
  const wrapped = Schema.declareConstructor<unknown, unknown>()(
    [],
    () => (input, ast, options) => {
      const result = v.safeParse(schema, input);
      if (result.success) return Effect.succeed(result.output);
      const issues = result.issues.map((issue) => {
        const leaf = new SchemaIssue.InvalidValue(
          { message: issue.message },
          input,
          options,
        );
        return issue.path?.length
          ? new SchemaIssue.Pointer(
              issue.path.map((part) => part.key as PropertyKey),
              leaf,
            )
          : leaf;
      });
      const failure =
        issues.length === 1
          ? issues[0]
          : new SchemaIssue.Composite(
              ast,
              issues as unknown as readonly [
                SchemaIssue.Issue,
                ...SchemaIssue.Issue[],
              ],
              input,
              options,
            );
      return Effect.fail(failure);
    },
  );
  const callable = Object.assign(
    (input: unknown) => Schema.decodeUnknownSync(wrapped)(input),
    wrapped,
  ) as unknown as Schema.Codec<v.InferOutput<T>, v.InferInput<T>> &
    ((input: unknown) => v.InferOutput<T>);
  const wrappedRecord = wrapped as unknown as Record<symbol, unknown>;
  const callableRecord = callable as unknown as Record<symbol, unknown>;
  for (const symbol of Object.getOwnPropertySymbols(wrapped)) {
    callableRecord[symbol] = wrappedRecord[symbol];
  }
  const proto: unknown = Object.getPrototypeOf(wrapped);
  Object.setPrototypeOf(callable, proto as object | null);
  return callable;
}
