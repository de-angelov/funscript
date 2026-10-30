# Fixture 02: Functions & Pipelines

export add = (a: Number, b: Number) -> a + b

export multiplyBy = (factor: Number) ->
  (n: Number) -> n * factor

export clamp = (min: Number, max: Number, value: Number) ->
  match
    | value |> Number.lessThan(min) -> min
    | value |> Number.greaterThan(max) -> max
    | _ -> value

export processed =
  5
  |> add(10, _)
  |> multiplyBy(2)
  |> clamp(0, 100, _)
