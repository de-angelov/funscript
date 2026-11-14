import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execute, typeCheck } from "./helpers/index.js";
import { Effect, Result, Schema } from "effect";
import { CallbackBoundaryError, checkedEffect, checkedSync, decodeCheckedRecord } from "../src/interop/callback.js";

const args = Schema.Tuple([Schema.FiniteFromString]);
const result = Schema.FiniteFromString;

describe("checked callback boundaries", () => {
  it("encodes arguments, decodes results, and preserves receiver and callback exceptions", () => {
    const original = function (this: { offset: number }, input: string) { return String(Number(input) + this.offset); };
    const wrapped = checkedSync(original, args, result);
    expect(wrapped).not.toBe(original);
    expect(wrapped.call({ offset: 2 }, 3)).toBe(5);
    const thrown = new Error("foreign callback failed");
    expect(() => checkedSync(() => { throw thrown; }, args, result)(1)).toThrow(thrown);
  });

  it("rejects non-functions, invalid inputs and invalid outputs at the right stage", () => {
    expect(() => checkedSync(null, args, result)).toThrowError(CallbackBoundaryError);
    let invoked = false;
    const wrapped = checkedSync(() => { invoked = true; return "bad"; }, args, result);
    expect(() => wrapped(NaN)).toThrowError(expect.objectContaining({ stage: "arguments" }));
    expect(invoked).toBe(false);
    expect(() => wrapped(2)).toThrowError(expect.objectContaining({ stage: "result" }));
  });

  it("runs Effect callbacks lazily, preserves failures and reports invalid results", async () => {
    let calls = 0;
    const wrapped = checkedEffect((n: string) => { calls++; return Effect.succeed(String(Number(n) + 1)); }, args, result);
    const pending = wrapped(1);
    expect(calls).toBe(0);
    expect(await Effect.runPromise(pending)).toBe(2);
    expect(calls).toBe(1);
    const domainError = { _tag: "DomainError" as const };
    const failed = checkedEffect((_n: string) => Effect.fail(domainError), args, result);
    expect(await Effect.runPromise(Effect.result(failed(1)))).toEqual(Result.fail(domainError));
    const invalid = checkedEffect((_n: string) => Effect.succeed("bad"), args, result);
    const outcome = await Effect.runPromise(Effect.result(invalid(1)));
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) expect(outcome.failure).toMatchObject({ _tag: "CallbackBoundaryError", stage: "result" });
    const thrown = new Error("invoke");
    const throwing = checkedEffect((_n: string): Effect.Effect<unknown> => { throw thrown; }, args, result);
    const thrownOutcome = await Effect.runPromise(Effect.result(throwing(1)));
    expect(Result.isFailure(thrownOutcome)).toBe(true);
    if (Result.isFailure(thrownOutcome)) expect(thrownOutcome.failure).toMatchObject({ stage: "invocation", originalCause: thrown });
    const dishonest = checkedEffect(((_n: string) => "not an Effect") as unknown as (_n: string) => Effect.Effect<unknown>, args, result);
    const nonEffect = await Effect.runPromise(Effect.result(dishonest(1)));
    expect(Result.isFailure(nonEffect)).toBe(true);
    if (Result.isFailure(nonEffect)) expect(nonEffect.failure).toMatchObject({ stage: "invocation" });
  });

  it("decodes data and explicitly wraps a required foreign callback", () => {
    const source = { label: "Vote", submit: (n: string) => String(Number(n) + 1) };
    const decoded = decodeCheckedRecord(source, Schema.Struct({ label: Schema.String }), {
      submit: (raw) => checkedSync(raw, args, result),
    });
    const onlyCallback = decodeCheckedRecord({ submit: source.submit, secret: "discard" }, Schema.Struct({}), {
      submit: (raw) => checkedSync(raw, args, result),
    });
    expect(Object.keys(onlyCallback)).toEqual(["submit"]);
    expect(onlyCallback.submit(2)).toBe(3);
    expect(decoded.label).toBe("Vote");
    expect(decoded.submit(2)).toBe(3);
    expect(decoded.submit).not.toBe(source.submit);
    expect(() => decodeCheckedRecord({ label: 42, submit: source.submit }, Schema.Struct({ label: Schema.String }), {
      submit: (raw) => checkedSync(raw, args, result),
    })).toThrow();
    expect(() => decodeCheckedRecord({ label: "Vote" }, Schema.Struct({ label: Schema.String }), {
      submit: (raw) => checkedSync(raw, args, result),
    })).toThrowError(expect.objectContaining({ stage: "arguments", originalCause: expect.objectContaining({ message: "Missing callback field 'submit'" }) }));
    expect(() => decodeCheckedRecord({ label: "Vote", submit: 12 }, Schema.Struct({ label: Schema.String }), {
      submit: (raw) => checkedSync(raw, args, result),
    })).toThrowError(CallbackBoundaryError);
    expect(() => decodeCheckedRecord(source, Schema.Struct({ label: Schema.String, submit: Schema.Unknown }), {
      submit: (raw) => checkedSync(raw, args, result),
    })).toThrow(/must not occur/);
  });

  it("checks and runs the Country Rank 2-inspired FunScript boundary", async () => {
    const file = "examples/fixtures/vote-callback-boundary.fun";
    const source = readFileSync(file, "utf8");
    const checked = await typeCheck(source, file);
    expect(checked.success, checked.formattedOutput).toBe(true);
    const { createVoteHandler, castVote, checkTypedVoteHandler } = await execute(source, { filename: file, scope: { checkedEffect, $funscriptCheckedEffect: checkedEffect, $funscriptCheckedSync: checkedSync, $funscriptDecodeCheckedRecord: decodeCheckedRecord } });
    const vote = { countryCode: "BG", voteType: "like" };
    const good = createVoteHandler(() => Effect.succeed({ countryCode: "BG", likes: 1, dislikes: 0 }));
    expect(await Effect.runPromise(castVote(good, vote))).toEqual({ countryCode: "BG", likes: 1, dislikes: 0 });
    const bad = createVoteHandler(() => Effect.succeed({ countryCode: "BG", likes: "bad", dislikes: 0 }));
    const failure = await Effect.runPromise(Effect.result(castVote(bad, vote)));
    expect(Result.isFailure(failure)).toBe(true);
    if (Result.isFailure(failure)) expect(failure.failure).toMatchObject({ code: "vote_failed", cause: { _tag: "CallbackBoundaryError", stage: "result" } });
    const storageError = { code: "storage_unavailable", cause: "offline" };
    const domain = createVoteHandler(() => Effect.fail(storageError));
    expect(await Effect.runPromise(Effect.result(castVote(domain, vote)))).toEqual(Result.fail({ code: "vote_failed", cause: storageError }));
    const typed = checkTypedVoteHandler({ submit: () => Effect.succeed({ countryCode: "BG", likes: 2, dislikes: 1 }) });
    expect(await Effect.runPromise(typed.submit(vote))).toEqual({ countryCode: "BG", likes: 2, dislikes: 1 });
  }, 60000);

});
