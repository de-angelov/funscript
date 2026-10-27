# FunScript — hello world
# Indentation, interpolation, pipelines, and an Effect entry point.

import { Array, Console } from "effect"

export greet = (name: string) ->
  "Hello, {name}!"

export main =
  ["Ada", "Grace", "Alan"]
  |> Array.map(greet)
  |> Array.join(", ")
  |> Console.log
