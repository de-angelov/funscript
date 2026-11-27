// Raw JavaScript values stay raw across the interop boundary.
import { Console } from "effect"

export describe = (value: JSNullish<String>) =>
  match value
    | Success(text) => "Hello, {text}!"
    | Failure(Null) => "Explicitly empty"
    | Failure(Undefined) => "Missing value"

// Inline interop expressions simulate values supplied by JavaScript.
// JSNullish does not validate values received from a foreign API.

export main =
  effect {
    _ <- Console.log(describe("Ada"))
    _ <- Console.log(describe(ts { null }))
    _ <- Console.log(describe(ts { undefined }))
    => Void
  }
