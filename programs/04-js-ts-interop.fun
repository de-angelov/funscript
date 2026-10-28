# Program 04: JS & TS Interop with Effect Fibers

import { Effect, Console } from "effect"

# 1. 'ts' escape hatch for raw TypeScript types
ts "type Timestamp = number;"

export schema Settings = ts "Record<string, string>"

# 2. Foreign JavaScript Promise simulation
jsGetGreeting = (name: string) ->
  Promise.resolve("Hello " + name + " from native JavaScript Promise!")

# 3. 'js' in Effect block: auto-wrapped with Effect.tryPromise
export fetchUserGreeting = (name: string) ->
  effect
    _ <- Console.log("[FunScript] Starting async fiber...")
    greeting <- js jsGetGreeting(name)
    _ <- Console.log("[FunScript] Received from JS: " + greeting)
    greeting

# 4. 'export js': Emits a function returning a native Promise for outside JS/TS
export js getPublicGreeting = (name: string) ->
  effect
    res <- fetchUserGreeting(name)
    res

# 5. 'eff |> js': Converts Effect to Promise in pipeline
export main = () ->
  effect
    _ <- fetchUserGreeting("Ada Lovelace")
    _ <- Console.log("[FunScript] Done!")
    0
