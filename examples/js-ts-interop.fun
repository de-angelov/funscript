// Program 04: JS & TS Interop with Effect Fibers

import { Effect, Console, Option, Schema } from "effect"
import { findNickname, loadProfile } from "./js-interop-native.js"

// 1. 'ts' escape hatch for raw TypeScript types
ts { type Timestamp = number; }

export schema Settings = ts { Record<string, string> }

export schema Profile = {
  name: String
}

// A missing nickname is an ordinary result; the caller chooses a fallback.
export nickname = (id: String) =>
  effect {
    found <- js findNickname(id)
    => Option.getOrElse(found, () => "Guest")
  }

// Unknown values are decoded whole, including any nullish value.
export profile =
  effect {
    raw <- js loadProfile()
    user <- Schema.decodeUnknownEffect(Profile)(raw)
    => user
  }

// Handle a rejected Promise or a synchronous throw at the interop seam.
export safeGreeting = (name: String) =>
  fetchUserGreeting(name)
  |> catchTag("JsInteropError", (_) => Effect.succeed("Greeting unavailable"))

// 2. Foreign JavaScript Promise simulation
jsGetGreeting = (name: String) =>
  Promise.resolve("Hello " + name + " from native JavaScript Promise!")

// 3. 'js' in Effect block: auto-wrapped with Effect.tryPromise
export fetchUserGreeting = (name: String) =>
  effect {
    _ <- Console.log("[FunScript] Starting async fiber...")
    greeting <- js jsGetGreeting(name)
    _ <- Console.log("[FunScript] Received from JS: " + greeting)
    => greeting
  }

// 4. 'export js': Emits a function returning a native Promise for outside JS/TS
export js getPublicGreeting = (name: String) =>
  effect {
    res <- fetchUserGreeting(name)
    => res
  }

// 5. Run the greeting workflow
export main = () =>
  effect {
    _ <- fetchUserGreeting("Ada Lovelace")
    _ <- Console.log("[FunScript] Done!")
    => 0
  }
