# FunScript — algebraic data types and exhaustive matching.
# Tagged-union `schema` lowers to Effect's Data.TaggedEnum + Schema; `match` lowers to ts-pattern.

import { Array, Console } from "effect"

export schema Shape =
  | Circle(radius: number)
  | Rect(width: number, height: number)

export area = (shape: Shape) ->
  match shape
    | Circle(r) -> Math.PI * r * r
    | Rect(w, h) -> w * h

export describe = (shape: Shape) ->
  match shape
    | Circle(r) when r |> Number.greaterThan(10) -> "large circle ({r})"
    | Circle(r) -> "circle ({r})"
    | Rect(w, h) -> "rectangle {w}x{h}"

export main =
  [Circle(2), Rect(3, 4), Circle(12)]
  |> Array.map(describe)
  |> Array.join(" | ")
  |> Console.log
