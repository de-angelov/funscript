import { Context, Effect, Layer, Schema, pipe } from "effect";
import * as __extern_stripe from "stripe";
declare module "effect" {
  namespace Schema {
    export const decodeUnknown: typeof Schema.decodeUnknownEffect;
  }
}

const RawWebhook = Schema.Struct({
  payload: Schema.String,
  signature: Schema.String
});
type RawWebhook = typeof RawWebhook.Type;
const RawWebhookFromUnknown = (input: unknown): RawWebhook => Schema.decodeUnknownSync(RawWebhook)(input);

const StripeEvent = Schema.Struct({
  id: Schema.String,
  type: Schema.String
});
type StripeEvent = typeof StripeEvent.Type;
const StripeEventFromUnknown = (input: unknown): StripeEvent => Schema.decodeUnknownSync(StripeEvent)(input);

const StripeError = Schema.Struct({
  message: Schema.String
});
type StripeError = typeof StripeError.Type;
const StripeErrorFromUnknown = (input: unknown): StripeError => Schema.decodeUnknownSync(StripeError)(input);

export interface StripeClient {
  readonly constructEvent: (body: string, sig: string, secret: string) => Effect.Effect<StripeEvent, StripeError, never>;
}
export const StripeClient = Context.GenericTag<StripeClient>("StripeClient");
const __client_StripeClient: any = typeof __extern_stripe === "function" ? new (__extern_stripe as any)() : typeof (__extern_stripe as any).default === "function" ? new ((__extern_stripe as any).default)() : typeof (__extern_stripe as any).StripeClient === "function" ? new ((__extern_stripe as any).StripeClient)() : __extern_stripe;
export const StripeClientLive = Layer.succeed(StripeClient, {
  constructEvent: (body, sig, secret) =>
    Effect.try({
      try: () => __client_StripeClient.constructEvent(body, sig, secret),
      catch: (error: any) => error as StripeError,
    }),
});

export const processWebhook = (dict: unknown, secret: string) => {
  return Effect.gen(function* () {
    const hook = yield* pipe(
  dict,
  Schema.decodeUnknown(RawWebhook)
);
    const event = yield* (yield* StripeClient).constructEvent(hook.payload, hook.signature, secret);
    return event;
  });
};
