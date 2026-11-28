/** Runtime declarations emitted only when a compiled program uses them. */
export interface RuntimeHelperOptions {
  referenceEquality: boolean;
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
