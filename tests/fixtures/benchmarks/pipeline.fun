// Minimal deterministic pipeline FunScript benchmark input
import { Array } from "effect"

export double = (n: Number) => n * 2

export increment = (n: Number) => n + 1

export transform =
  [1, 2, 3, 4, 5]
  |> Array.map(double)
  |> Array.map(increment)
  |> Array.filter((n: Number) => n > 2)
