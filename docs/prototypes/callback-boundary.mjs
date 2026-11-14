// Exploratory runtime prototype, not part of FunScript's public API or compiler.
// Direction: FunScript supplies decoded values; the foreign callback expects
// encoded arguments and returns an encoded result. Only one argument is modeled.
import assert from "node:assert/strict";
import { Effect, Result, Schema } from "effect";

class BoundaryError extends Error {
  constructor(stage, cause) {
    super(`Callback boundary: ${stage}`, { cause });
    this.name = "BoundaryError";
    this.stage = stage;
  }
}

const guarded = (stage, operation) => {
  try { return operation(); } catch (cause) { throw new BoundaryError(stage, cause); }
};

function syncBoundary(callback, inputSchema, outputSchema) {
  if (typeof callback !== "function") throw new BoundaryError("not callable");
  return function (input) {
    const encoded = guarded("encode argument", () => Schema.encodeSync(inputSchema)(input));
    // A callback's own exception is deliberately preserved, not mislabeled as a schema error.
    const raw = Reflect.apply(callback, this, [encoded]);
    return guarded("decode result", () => Schema.decodeUnknownSync(outputSchema)(raw));
  };
}

function effectBoundary(callback, inputSchema, outputSchema) {
  if (typeof callback !== "function") throw new BoundaryError("not callable");
  return function (input) {
    const receiver = this;
    return Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(inputSchema)(input).pipe(
        Effect.mapError(cause => new BoundaryError("encode argument", cause)),
      );
      const returned = yield* Effect.try({
        try: () => Reflect.apply(callback, receiver, [encoded]),
        catch: cause => new BoundaryError("callback threw", cause),
      });
      if (!Effect.isEffect(returned)) return yield* Effect.fail(new BoundaryError("expected Effect"));
      // Existing callback failures stay in the original error channel.
      const raw = yield* returned;
      return yield* Schema.decodeUnknownEffect(outputSchema)(raw).pipe(
        Effect.mapError(cause => new BoundaryError("decode result", cause)),
      );
    });
  };
}

const numericWire = Schema.FiniteFromString;
let calls = 0;
const original = function (raw) { calls++; assert.equal(this.prefix, "#"); return `${Number(raw) + 1}`; };
const sync = syncBoundary(original, numericWire, numericWire);
assert.notEqual(sync, original); // Wrapping changes callback identity.
assert.equal(sync.call({ prefix: "#" }, 3), 4);
assert.equal(calls, 1);
assert.throws(() => sync.call({ prefix: "#" }, NaN), e => e.stage === "encode argument");
assert.equal(calls, 1); // Invalid arguments never reach the callback.
assert.throws(() => syncBoundary(() => "invalid", numericWire, numericWire)(3), e => e.stage === "decode result");
const originalError = new Error("callback error");
assert.throws(() => syncBoundary(() => { throw originalError; }, numericWire, numericWire)(3), e => e === originalError);
assert.throws(() => syncBoundary(null, numericWire, numericWire), e => e.stage === "not callable");

let effectCalls = 0;
const wrappedEffect = effectBoundary(raw => { effectCalls++; return Effect.succeed(`${Number(raw) + 1}`); }, numericWire, numericWire);
const pending = wrappedEffect(3);
assert.equal(effectCalls, 0); // Callback invocation stays lazy.
assert.equal(await Effect.runPromise(pending), 4);
assert.equal(effectCalls, 1);
const failure = await Effect.runPromise(Effect.result(effectBoundary(() => Effect.succeed("invalid"), numericWire, numericWire)(3)));
assert.ok(Result.isFailure(failure));
assert.equal(failure.failure.stage, "decode result");
const callbackFailure = { tag: "domain failure" };
const domainResult = await Effect.runPromise(Effect.result(effectBoundary(() => Effect.fail(callbackFailure), numericWire, numericWire)(3)));
assert.ok(Result.isFailure(domainResult));
assert.equal(domainResult.failure, callbackFailure);
const invalidResult = await Effect.runPromise(Effect.result(effectBoundary(() => "not an Effect", numericWire, numericWire)(3)));
assert.ok(Result.isFailure(invalidResult));
assert.equal(invalidResult.failure.stage, "expected Effect");
console.log("Callback boundary prototype: all checks passed");
