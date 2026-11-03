export compute = effect {
  x <- Effect.succeed(21)
  total = x * 2
}
