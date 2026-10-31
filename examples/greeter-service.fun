# FunScript — services, layers, and dependency injection.

import { Console, Effect, Layer } from "effect"

export service Greeter
  greet: (name: String) -> Effect<String>

export GreeterLive =
  Layer.succeed(Greeter, {
    greet: (name) -> Effect.succeed("Hello, {name}!")
  })

export main =
  effect {
    message <- Greeter.greet("Ada")
    _ <- Console.log(message)
    message
  }
  |> Effect.provide(GreeterLive)
