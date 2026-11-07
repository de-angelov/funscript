import { Duration, Effect, Exit } from "effect";

/** A caller-owned cache: successes are retained, failures can be retried. */
export const cacheSuccess = <A, E, R>(acquire: Effect.Effect<A, E, R>) =>
  Effect.cachedWithTTL(acquire, (exit) => Exit.isSuccess(exit) ? Duration.infinity : Duration.zero);
