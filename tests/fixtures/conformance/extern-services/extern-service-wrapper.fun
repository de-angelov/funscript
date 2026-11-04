schema RawWebhook = {
  payload: String
  signature: String
}

ts schema StripeEvent = {
  id: String
  type: String
}

schema StripeError = {
  message: String
}

export extern "stripe" service StripeClient {
  constructEvent: (body: String, sig: String, secret: String) => Effect<StripeEvent, StripeError>
}

export processWebhook = (dict: Unknown, secret: String) =>
  effect {
    hook <- dict |> decode(RawWebhook)
    event <- StripeClient.constructEvent(hook.payload, hook.signature, secret)
    => event
  }
