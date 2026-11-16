import { Effect } from "effect";

export const compute = Effect.scoped(Effect.gen(function* () {
    const x = yield* Effect.succeed(21);
    const total = (x * 2);
    return total;
  }));
