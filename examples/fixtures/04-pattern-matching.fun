# Fixture 04: Pattern Matching

import { Shape, Circle, Rect, Point } from "./03-schemas-and-unions.fun"

export area = (shape: Shape) ->
  match shape
    | Circle(r) when r |> Number.greaterThan(0) -> Math.PI * r * r
    | Rect(w, h) -> w * h
    | Point -> 0
    | _ -> 0

export evaluateScore = (score: number, isPro: boolean) ->
  match
    | score |> Number.greaterThanOrEqualTo(90) and isPro -> "champion"
    | score |> Number.greaterThanOrEqualTo(60) -> "passed"
    | _ -> "failed"
