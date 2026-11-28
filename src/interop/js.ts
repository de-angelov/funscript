import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** Failure from a synchronous JavaScript throw or asynchronous rejection. */
export class JsInteropError extends Error {
  readonly _tag = "JsInteropError" as const;
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Native JavaScript interop failed");
    this.name = "JsInteropError";
    this.cause = cause;
  }
}

/** Runtime adapter used by generated JavaScript interop expressions. */
export function jsInterop<P extends PromiseLike<unknown>>(
  thunk: () => P,
  nullable: true,
): Effect.Effect<Option.Option<NonNullable<Awaited<P>>>, JsInteropError>;
export function jsInterop<P extends PromiseLike<unknown>>(
  thunk: () => P,
  nullable: false,
): Effect.Effect<Awaited<P>, JsInteropError>;
export function jsInterop<P extends PromiseLike<unknown>>(
  thunk: () => P,
  nullable: "unknown",
): Effect.Effect<unknown, JsInteropError>;
export function jsInterop<A>(
  thunk: () => A,
  nullable: true,
): Effect.Effect<Option.Option<NonNullable<Awaited<A>>>, JsInteropError>;
export function jsInterop<A>(
  thunk: () => A,
  nullable: false,
): Effect.Effect<Awaited<A>, JsInteropError>;
export function jsInterop<A>(
  thunk: () => A,
  nullable: "unknown",
): Effect.Effect<unknown, JsInteropError>;
export function jsInterop(
  thunk: () => unknown,
  nullable: boolean | "unknown",
): Effect.Effect<unknown, JsInteropError> {
  const effect = Effect.suspend(() => {
    try {
      const res = thunk();
      const then =
        res === null || res === undefined
          ? undefined
          : (res as { then?: unknown }).then;
      if (typeof then === "function") {
        const boundThen: unknown = then.bind(res);
        return Effect.tryPromise({
          try: () =>
            Promise.resolve({ then: boundThen } as PromiseLike<unknown>),
          catch: (cause) => new JsInteropError(cause),
        });
      }
      return Effect.succeed(res);
    } catch (cause) {
      return Effect.fail(new JsInteropError(cause));
    }
  });
  return nullable === true ? Effect.map(effect, Option.fromNullishOr) : effect;
}
