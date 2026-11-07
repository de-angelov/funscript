import { describe, expect, expectTypeOf, it } from "vitest";
import { Context, Effect, Layer } from "effect";
import { cacheSuccess } from "../examples/interop/cache-success.js";

describe("caller-owned Effect cache spike", () => {
  it("retains the exact success, error and requirement channels", () => {
    type Client = { close: () => void; name: string };
    type ConnectError = { readonly _tag: "ConnectError" };
    type Config = { readonly _tag: "Config" };
    const assertChannels = (acquire: Effect.Effect<Client, ConnectError, Config>) => {
      const cached = cacheSuccess(acquire);
      expectTypeOf(cached).toEqualTypeOf<Effect.Effect<Effect.Effect<Client, ConnectError, Config>>>();
    };
    expect(assertChannels).toBeTypeOf("function");
  });

  it("shares concurrent successful acquisition and retries failures", async () => {
    let attempts = 0;
    const program = Effect.gen(function* () {
      const cached = yield* cacheSuccess(Effect.suspend(() => {
        attempts++;
        return attempts === 1
          ? Effect.fail("offline")
          : Effect.sleep("10 millis").pipe(Effect.as({ name: "redis" }));
      }));
      const first = yield* Effect.exit(cached);
      const clients = yield* Effect.all([cached, cached, cached], { concurrency: "unbounded" });
      const again = yield* cached;
      return { first, clients, again };
    });
    const result = await Effect.runPromise(program);
    expect(result.first._tag).toBe("Failure");
    expect(result.clients.map((client) => client.name)).toEqual(["redis", "redis", "redis"]);
    expect(result.again).toBe(result.clients[0]);
    expect(attempts).toBe(2);
  });

  it("shares a Layer-owned connection and closes it when the scope exits", async () => {
    class Redis extends Context.Service<Redis, { readonly name: string }>()("spike/Redis") {}
    let opened = 0;
    let closed = 0;
    const layer = Layer.effect(Redis,
      Effect.acquireRelease(
        Effect.sync(() => { opened++; return { name: "redis" }; }),
        () => Effect.sync(() => { closed++; }),
      ),
    );
    const program = Effect.gen(function* () {
      const connection = yield* Redis;
      const again = yield* Redis;
      expect(closed).toBe(0);
      expect(again).toBe(connection);
      return connection.name;
    });
    expect(await Effect.runPromise(Effect.provide(program, layer))).toBe("redis");
    expect(opened).toBe(1);
    expect(closed).toBe(1);
  });
});
