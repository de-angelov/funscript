# Fixture 06: Effects, Services, Error Union Tracking & orDie

import { Console, Effect, Layer } from "effect"

export error NotFound(id: String)
export error PaymentDeclined(reason: String)

export service UserRepo
  find: (id: String) -> Effect<String, NotFound>

export service PaymentGateway
  charge: (amount: Number) -> Effect<Void, PaymentDeclined>

export service ConfigRepo
  loadDefaults: () -> Effect<String, NotFound>

export checkout = (userId: String, amount: Number) ->
  effect
    user <- UserRepo.find(userId)
    _ <- PaymentGateway.charge(amount)
    defaultConfig <- ConfigRepo.loadDefaults() |> orDie
    _ <- Console.log("Completed checkout for {user}")
    user
