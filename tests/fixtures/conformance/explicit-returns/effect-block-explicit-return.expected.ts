import { Effect } from "effect";

export const compute = Effect.gen(function* () {
    const x = yield* Effect.succeed(21);
    const total = (x * 2);
    return total;
  });
