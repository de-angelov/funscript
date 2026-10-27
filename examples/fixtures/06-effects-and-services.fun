# Fixture 06: Effects, Services, Error Union Tracking & orDie

import { Console, Effect, Layer } from "effect"

export error NotFound(id: string)
export error PaymentDeclined(reason: string)

export service UserRepo
  find: (id: string) -> Effect<string, NotFound>

export service PaymentGateway
  charge: (amount: number) -> Effect<void, PaymentDeclined>

export service ConfigRepo
  loadDefaults: () -> Effect<string, NotFound>

export checkout = (userId: string, amount: number) ->
  effect
    user <- UserRepo.find(userId)
    _ <- PaymentGateway.charge(amount)
    defaultConfig <- ConfigRepo.loadDefaults() |> orDie
    _ <- Console.log("Completed checkout for {user}")
    user
