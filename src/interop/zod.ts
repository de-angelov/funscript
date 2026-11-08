import { z } from "zod";
import { Schema, SchemaIssue, SchemaAST, Effect, Result } from "effect";

/**
 * Callable Effect schema wrapping a Zod validator.
 * Can be decoded with Schema.decodeUnknown, Schema.decodeUnknownSync, etc.,
 * or called directly as a constructor `schema(input)`.
 */
export interface ZodEffectSchema<Output, Input = unknown> extends Schema.Codec<Output, Input> {
  (input: unknown): Output;
  readonly "~standard"?: z.ZodTypeAny["~standard"];
}

function convertZodErrorToIssue(
  ast: SchemaAST.AST,
  error: z.ZodError,
  input: unknown,
  options: any
): SchemaIssue.Issue {
  if (error.issues.length === 0) {
    return new SchemaIssue.InvalidType(ast, input, options);
  }

  const issues: SchemaIssue.Issue[] = error.issues.map((iss) => {
    const leaf = new SchemaIssue.InvalidValue({ message: iss.message }, input, options);
    if (iss.path && iss.path.length > 0) {
      return new SchemaIssue.Pointer(iss.path, leaf);
    }
    return leaf;
  });

  if (issues.length === 1) {
    return issues[0];
  }

  return new SchemaIssue.Composite(
    ast,
    issues as unknown as readonly [SchemaIssue.Issue, ...SchemaIssue.Issue[]],
    input,
    options
  );
}

/**
 * Wraps an external Zod schema into an Effect Schema for use in
 * FunScript pipelines, schema decoding, and pattern matching.
 *
 * @param zodSchema Any Zod schema (z.ZodTypeAny)
 * @returns An Effect Schema with type inference, callable constructor, and error preservation
 */
export function fromZod<T extends z.ZodTypeAny>(
  zodSchema: T
): ZodEffectSchema<z.output<T>, z.input<T>> {
  const rawSchema = Schema.declareConstructor<z.output<T>, z.input<T>>()([], () => (input, ast, options) => {
    try {
      const parsed = zodSchema.safeParse(input);
      if (parsed.success) {
        return Effect.succeed(parsed.data as z.output<T>);
      }
      return Effect.fail(convertZodErrorToIssue(ast, parsed.error, input, options));
    } catch {
      return Effect.tryPromise({
        try: () => zodSchema.safeParseAsync(input),
        catch: (err) =>
          new SchemaIssue.InvalidValue(
            { message: err instanceof Error ? err.message : String(err) },
            input,
            options
          ),
      }).pipe(
        Effect.flatMap((parsed) => {
          if (parsed.success) {
            return Effect.succeed(parsed.data as z.output<T>);
          }
          return Effect.fail(convertZodErrorToIssue(ast, parsed.error, input, options));
        })
      );
    }
  });

  const schema = Object.assign(function (input: unknown): z.output<T> {
    return Schema.decodeUnknownSync(rawSchema)(input);
  }, rawSchema) as unknown as ZodEffectSchema<z.output<T>, z.input<T>>;

  for (const sym of Object.getOwnPropertySymbols(rawSchema)) {
    (schema as any)[sym] = (rawSchema as any)[sym];
  }
  Object.setPrototypeOf(schema, Object.getPrototypeOf(rawSchema));

  if (zodSchema["~standard"]) {
    (schema as any)["~standard"] = zodSchema["~standard"];
  }

  return schema;
}

/**
 * Exposes a FunScript/Effect Schema as a standard Zod schema
 * that passes .safeParse, .parse, .safeParseAsync, and .parseAsync checks,
 * preserves validation error paths/messages, and supports schema composition.
 *
 * @param schema An Effect Schema or Codec
 * @returns A Zod schema implementing z.ZodType with standard parsing methods
 */
export function toZod<A, I = unknown>(
  schema: Schema.Schema<A> | Schema.Codec<A, I>
): z.ZodType<A, z.ZodTypeDef, I> {
  return z.unknown().transform((val, ctx) => {
    try {
      const res = Schema.decodeUnknownResult(schema as any)(val, { errors: "all" });
      if (Result.isSuccess(res)) {
        return (res.success ?? (res as any).value) as A;
      }
      const formatted = SchemaIssue.makeFormatterStandardSchemaV1()(res.failure.issue);
      for (const issue of formatted.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: issue.path as (string | number)[],
          message: issue.message,
        });
      }
      return z.NEVER;
    } catch {
      return Schema.decodeUnknownPromise(schema as any)(val, { errors: "all" }).then(
        (decoded) => decoded as A,
        (err) => {
          if (err && err.issue) {
            const formatted = SchemaIssue.makeFormatterStandardSchemaV1()(err.issue);
            for (const issue of formatted.issues) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: issue.path as (string | number)[],
                message: issue.message,
              });
            }
          } else {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: err instanceof Error ? err.message : String(err),
            });
          }
          return z.NEVER;
        }
      );
    }
  }) as unknown as z.ZodType<A, z.ZodTypeDef, I>;
}

/**
 * Schema decoder helper compatible across Effect versions.
 * In Effect v4, delegates to Schema.decodeUnknownEffect.
 */
export const decodeUnknown = (Schema as any).decodeUnknown ?? Schema.decodeUnknownEffect;
export const decodeUnknownSync = Schema.decodeUnknownSync;
export const decodeUnknownPromise = Schema.decodeUnknownPromise;
export const decodeUnknownResult = Schema.decodeUnknownResult;

/**
 * Schema proxy ensuring `Schema.decodeUnknown` is available in all runtimes.
 */
export const InteropSchema: typeof Schema & {
  decodeUnknown: typeof Schema.decodeUnknownEffect;
} = new Proxy(Schema as any, {
  get(target, prop, receiver) {
    if (prop === "decodeUnknown") {
      return (target as any).decodeUnknown ?? (target as any).decodeUnknownEffect;
    }
    return Reflect.get(target, prop, receiver);
  },
});
