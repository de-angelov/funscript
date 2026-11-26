import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A failure at an explicitly checked foreign callback boundary. */
export class CallbackBoundaryError extends Error {
  readonly _tag = "CallbackBoundaryError";
  constructor(
    readonly stage: "not-callable" | "arguments" | "invocation" | "result",
    readonly originalCause: unknown,
  ) {
    super(`Callback boundary failed: ${stage}`, { cause: originalCause });
    this.name = "CallbackBoundaryError";
  }
}

type SyncArgs = Schema.ConstraintCodec<
  readonly unknown[],
  readonly unknown[],
  never,
  never
>;
type SyncResult = Schema.ConstraintCodec<unknown, unknown, never, never>;

/**
 * Adapt a foreign synchronous function. Arguments are encoded and results decoded.
 * The callback's own throws propagate unchanged. Each call produces schema failures
 * as CallbackBoundaryError. Wrapping changes identity; retain the returned function.
 */
export function checkedSync<A extends SyncArgs, B extends SyncResult>(
  callback: unknown,
  args: A,
  result: B,
): (...values: A["Type"]) => B["Type"] {
  if (typeof callback !== "function")
    throw new CallbackBoundaryError("not-callable", callback);
  return function (this: unknown, ...values: A["Type"]): B["Type"] {
    let encoded: A["Encoded"];
    try {
      encoded = Schema.encodeSync(args)(values);
    } catch (cause) {
      throw new CallbackBoundaryError("arguments", cause);
    }
    const output: unknown = Reflect.apply(callback, this, encoded);
    try {
      return Schema.decodeUnknownSync(result)(output);
    } catch (cause) {
      throw new CallbackBoundaryError("result", cause);
    }
  };
}

/** Like checkedSync, but ignore the foreign return value as JavaScript void APIs do. */
export function checkedSyncVoid<A extends SyncArgs>(
  callback: unknown,
  args: A,
  maxArgs?: number,
): (...values: A["Type"]) => void {
  if (typeof callback !== "function")
    throw new CallbackBoundaryError("not-callable", callback);
  return function (this: unknown, ...values: A["Type"]): void {
    let encoded: A["Encoded"];
    try {
      encoded = Schema.encodeSync(args)(
        maxArgs === undefined ? values : values.slice(0, maxArgs),
      );
    } catch (cause) {
      throw new CallbackBoundaryError("arguments", cause);
    }
    Reflect.apply(callback, this, encoded);
  };
}

/**
 * Adapt a statically typed foreign Effect callback. Its failure channel and service
 * requirements are preserved; boundary failures are added to its error channel.
 * Callback invocation is deferred until the returned Effect runs.
 */
export function checkedEffect<A extends SyncArgs, B extends SyncResult, E, R>(
  callback: (...values: A["Encoded"]) => Effect.Effect<unknown, E, R>,
  args: A,
  result: B,
): (
  ...values: A["Type"]
) => Effect.Effect<B["Type"], E | CallbackBoundaryError, R> {
  if (typeof callback !== "function")
    throw new CallbackBoundaryError("not-callable", callback);
  return function (this: unknown, ...values: A["Type"]) {
    const receiver = this;
    return Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(args)(values).pipe(
        Effect.mapError(
          (cause) => new CallbackBoundaryError("arguments", cause),
        ),
      );
      const effect = yield* Effect.try<
        Effect.Effect<unknown, E, R>,
        CallbackBoundaryError
      >({
        try: () => Reflect.apply(callback, receiver, encoded),
        catch: (cause) => new CallbackBoundaryError("invocation", cause),
      });
      if (!Effect.isEffect(effect))
        return yield* Effect.fail(
          new CallbackBoundaryError("invocation", effect),
        );
      const output = yield* effect;
      return yield* Schema.decodeUnknownEffect(result)(output).pipe(
        Effect.mapError((cause) => new CallbackBoundaryError("result", cause)),
      );
    });
  };
}

/**
 * Decode ordinary fields and explicitly adapt required callbacks from one untrusted
 * object. The data schema must produce a plain record and must not include the callback
 * keys. Callback adapters are trusted functions, typically built with checkedSync.
 * This creates a new object and only accepts own callback properties.
 */
export function decodeCheckedRecord<
  S extends Schema.ConstraintDecoder<object>,
  A extends Record<string, (value: unknown) => unknown>,
  O extends readonly (keyof A)[] = readonly [],
>(
  input: unknown,
  data: S,
  adapters: A,
  optionalKeys?: O,
): S["Type"] & { [K in Exclude<keyof A, O[number]>]: ReturnType<A[K]> } & {
  [K in O[number]]?: ReturnType<A[K]> | undefined;
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new CallbackBoundaryError(
      "arguments",
      new TypeError("Expected an object"),
    );
  }
  const parsed = Schema.decodeUnknownSync(data)(input);
  // Effect's empty Struct accepts and returns the entire input object. An empty
  // declared data shape must not leak unknown properties or collide with callbacks.
  const structFields = "fields" in data ? data.fields : undefined;
  const emptyStruct =
    typeof structFields === "object" &&
    structFields !== null &&
    Reflect.ownKeys(structFields).length === 0;
  const decoded = emptyStruct ? {} : parsed;
  const prototype = Object.getPrototypeOf(decoded);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("The data schema must decode to a plain record");
  }
  const output = Object.create(prototype) as S["Type"] & {
    [K in Exclude<keyof A, O[number]>]: ReturnType<A[K]>;
  } & {
    [K in O[number]]?: ReturnType<A[K]> | undefined;
  };
  for (const key of Reflect.ownKeys(decoded)) {
    const descriptor = Object.getOwnPropertyDescriptor(decoded, key);
    if (descriptor?.enumerable) Object.defineProperty(output, key, descriptor);
  }
  for (const key of Object.keys(adapters)) {
    if (Object.prototype.hasOwnProperty.call(decoded, key)) {
      throw new TypeError(
        `Callback field '${key}' must not occur in the data schema`,
      );
    }
    const optional =
      (optionalKeys as readonly PropertyKey[] | undefined)?.includes(key) ??
      false;
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      if (optional) continue;
      throw new CallbackBoundaryError(
        "arguments",
        new TypeError(`Missing callback field '${key}'`),
      );
    }
    const raw = Reflect.get(input, key);
    Object.defineProperty(output, key, {
      value: optional && raw === undefined ? undefined : adapters[key](raw),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}
