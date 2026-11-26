// Service keys vs service shapes.
// `Greeter` is the Context key. A bound instance (`greeter <- Greeter`) has the
// service's *shape* type, which is `Greeter["Service"]`. When a helper takes a
// bound instance as a parameter, name that shape once with a type-only `ts {}` bridge.
//
// Direct calls like `Greeter.greet(...)` are desugared to `(yield* Greeter).greet(...)`
// in effect-block statements. Inside nested callbacks, bind the instance first and
// call `greeter.greet(...)` instead.
import { Console, Effect, Layer, Option } from "effect"

ts { type GreeterShape = Greeter["Service"]; }

export service Greeter
  greet: (name: String) => Effect<String>

greetTwice = (greeter: GreeterShape, name: String) =>
  effect {
    first <- greeter.greet(name)
    second <- greeter.greet(name)
    => first + " / " + second
  }

GreeterLive = Layer.succeed(Greeter, {
  greet: (name) => Effect.succeed("Hello, {name}!")
})

export main =
  effect {
    direct <- Greeter.greet("Ada")
    greeter <- Greeter
    twice <- greetTwice(greeter, "Ada")
    _ <- Console.log(direct)
    _ <- Console.log(twice)
    _ <- Option.some("Grace")
    |> Option.match({
      onNone: () => Effect.void
      onSome: (name) => greeter.greet(name) |> Effect.flatMap((line) => Console.log(line))
    })
    => twice
  }
  |> Effect.provide(GreeterLive)
