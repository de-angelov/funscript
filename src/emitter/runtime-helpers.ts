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
    header += `function __funscriptJs<P extends Promise<unknown>>(thunk: () => P, nullable: true): Effect.Effect<Option.Option<NonNullable<Awaited<P>>>, JsInteropError>;\n`;
    header += `function __funscriptJs<P extends Promise<unknown>>(thunk: () => P, nullable: false): Effect.Effect<Awaited<P>, JsInteropError>;\n`;
    header += `function __funscriptJs<P extends Promise<unknown>>(thunk: () => P, nullable: "unknown"): Effect.Effect<Option.Option<unknown>, JsInteropError>;\n`;
    header += `function __funscriptJs(thunk: () => Promise<unknown>, nullable: boolean | "unknown"): Effect.Effect<unknown, JsInteropError> {\n  const effect = Effect.tryPromise({ try: thunk, catch: (cause) => new JsInteropError(cause) });\n  return nullable === false ? effect : Effect.map(effect, Option.fromNullishOr);\n}\n`;
  }
  if (options.decodeUnknown) {
    header += `declare module "effect" {\n  namespace Schema {\n    export const decodeUnknown: typeof Schema.decodeUnknownEffect;\n  }\n}\n`;
  }
  if (options.fromNullishOrElse) {
    header += `function fromNullishOrElse<A, B>(value: A | null | undefined, onNone: B): NonNullable<A> | B;\n`;
    header += `function fromNullishOrElse<B>(onNone: B): <A>(value: A | null | undefined) => NonNullable<A> | B;\n`;
    header += `function fromNullishOrElse(...args: unknown[]): unknown {\n  if (args.length === 1) { const onNone = args[0]; return (value: unknown) => fromNullishOrElse(value, onNone); }\n  let [value, onNone] = args;\n  while (value !== null && value !== undefined && typeof value === "object" && "_tag" in value) {\n    const candidate = value as { readonly _tag: string; readonly value?: unknown };\n    if (candidate._tag === "Some") value = candidate.value;\n    else if (candidate._tag === "None") return onNone;\n    else break;\n  }\n  if (value !== null && value !== undefined) return value;\n  return onNone;\n}\n`;
  }
  if (options.fromNullishOr) {
    header += `function fromNullishOr<A>(value: A): A extends import("effect").Option.Option<any> ? A : import("effect").Option.Option<NonNullable<A>> {\n  if (Option.isOption(value)) return value as any;\n  return Option.fromNullishOr(value) as any;\n}\n`;
  }
  if (options.optionTry) {
    header += `function optionTry<A>(thunk: () => A): import("effect").Option.Option<NonNullable<A>> {\n  try {\n    return Option.fromNullishOr(thunk()) as any;\n  } catch {\n    return Option.none();\n  }\n}\n`;
  }

  return header;
}
