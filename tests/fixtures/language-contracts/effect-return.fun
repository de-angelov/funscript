import { Effect } from "effect"

export program = effect {
  value <- Effect.succeed(2)
  => value + 1
}
