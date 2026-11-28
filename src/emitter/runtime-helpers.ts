/** Runtime declarations emitted only when a compiled program uses them. */
export interface RuntimeHelperOptions {
  referenceEquality: boolean;
  jsInterop: boolean;
  decodeUnknown: boolean;
  fromNullishOrElse: boolean;
  fromNullishOr: boolean;
  optionTry: boolean;
}

export function emitRuntimeHelpers(options: RuntimeHelperOptions): string {
  let header = "";
  if (options.referenceEquality) {
    header += `const referenceEquals = <T extends object>(left: T, right: T): boolean => left === right;\n`;
  }
  if (options.jsInterop) {
    header += `class JsInteropError extends Error {\n  readonly _tag = "JsInteropError" as const;\n  readonly cause: unknown;\n  constructor(cause: unknown) {\n    super("Native JavaScript interop failed");\n    this.name = "JsInteropError";\n    this.cause = cause;\n  }\n}\n`;
    header += `function __funscriptJs<P extends PromiseLike<unknown>>(thunk: () => P, nullable: true): Effect.Effect<Option.Option<NonNullable<Awaited<P>>>, JsInteropError>;\n`;
    header += `function __funscriptJs<P extends PromiseLike<unknown>>(thunk: () => P, nullable: false): Effect.Effect<Awaited<P>, JsInteropError>;\n`;
    header += `function __funscriptJs<P extends PromiseLike<unknown>>(thunk: () => P, nullable: "unknown"): Effect.Effect<unknown, JsInteropError>;\n`;
    header += `function __funscriptJs<A>(thunk: () => A, nullable: true): Effect.Effect<Option.Option<NonNullable<Awaited<A>>>, JsInteropError>;\n`;
    header += `function __funscriptJs<A>(thunk: () => A, nullable: false): Effect.Effect<Awaited<A>, JsInteropError>;\n`;
    header += `function __funscriptJs<A>(thunk: () => A, nullable: "unknown"): Effect.Effect<unknown, JsInteropError>;\n`;
    header += `function __funscriptJs(thunk: () => unknown, nullable: boolean | "unknown"): Effect.Effect<unknown, JsInteropError> {\n  const effect = Effect.suspend(() => {\n    try {\n      const res = thunk();\n      const then = res == null ? undefined : (res as { then?: unknown }).then;\n      if (typeof then === "function") {\n        return Effect.tryPromise({ try: () => Promise.resolve({ then: then.bind(res) } as PromiseLike<unknown>), catch: (cause) => new JsInteropError(cause) });\n      }\n      return Effect.succeed(res);\n    } catch (cause) {\n      return Effect.fail(new JsInteropError(cause));\n    }\n  });\n  return nullable === true ? Effect.map(effect, Option.fromNullishOr) : effect;\n}\n`;
  }
  if (options.decodeUnknown) {
    header += `declare module "effect" {\n  namespace Schema {\n    export const decodeUnknown: typeof Schema.decodeUnknownEffect;\n  }\n}\n`;
  }
  if (options.fromNullishOrElse) {
    header += `function fromNullishOrElse<A, B>(value: A | null | undefined, onNone: B): NonNullable<A> | B;\n`;
    header += `function fromNullishOrElse<B>(onNone: B): <A>(value: A | null | undefined) => NonNullable<A> | B;\n`;
    header += `function fromNullishOrElse(...args: unknown[]): unknown {\n  if (args.length === 1) { const onNone = args[0]; return (value: unknown) => fromNullishOrElse(value, onNone); }\n  const [value, onNone] = args;\n  const unwrapped = Option.isOption(value) ? Option.getOrElse(value, () => onNone) : value;\n  return unwrapped ?? onNone;\n}\n`;
  }
  if (options.fromNullishOr) {
    header += `function fromNullishOr<A>(value: A): 0 extends (1 & A) ? import("effect/Option").Option<A> : import("effect/Option").Option<NonNullable<A>> {\n  return Option.fromNullishOr(value) as any;\n}\n`;
  }
  if (options.optionTry) {
    header += `function optionTry<A>(thunk: () => A): import("effect").Option.Option<NonNullable<A>> {\n  try {\n    return Option.fromNullishOr(thunk()) as any;\n  } catch {\n    return Option.none();\n  }\n}\n`;
  }

  return header;
}
