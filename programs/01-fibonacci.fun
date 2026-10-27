# Program 01: Fibonacci & Math Pipelines

import { Console } from "effect"

export fib = (n: number): number ->
  match
    | n |> lessThanOrEqualTo(0) -> 0
    | n == 1 -> 1
    | _ -> fib(n - 1) + fib(n - 2)

export formatFib = (n: number) -> "fib({n}) = {fib(n)}"

export main =
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  |> map(formatFib)
  |> join("\n")
  |> Console.log
