# Fixture 02: Functions & Pipelines

export add = (a: number, b: number) -> a + b

export multiplyBy = (factor: number) ->
  (n: number) -> n * factor

export clamp = (min: number, max: number, value: number) ->
  match
    | value |> Number.lessThan(min) -> min
    | value |> Number.greaterThan(max) -> max
    | _ -> value

export processed =
  5
  |> add(10, _)
  |> multiplyBy(2)
  |> clamp(0, 100, _)
