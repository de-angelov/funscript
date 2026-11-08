// FunScript Showcase: Pipeline Helpers with es-toolkit
// Demonstrating pure string, math, and timing utilities in data-last pipelines.

import { Console } from "effect"

// Pure string transformations in pipelines
export formatPostSlug = (title: String): String =>
  => title
  |> trim
  |> slug

export toCamel = (name: String): String =>
  => name
  |> camelCase

export toSnake = (name: String): String =>
  => name
  |> snakeCase

// Math pipeline operations with data-last calling conventions
export normalizeScore = (raw: Number): Number =>
  => raw
  |> clamp(0, 100)
  |> round(1)

export summarizeNumbers = (values: Array<Number>): Number =>
  => values
  |> sum

// Timing helpers in pipelines
export createDebouncedAction = (action: (msg: String) => Void) =>
  => action
  |> debounce(100)

export main =
  effect {
    _ <- Console.log("Slug: {formatPostSlug("  FunScript 2.0 Released!  ")}")
    _ <- Console.log("Camel: {toCamel("order_fulfillment_service")}")
    _ <- Console.log("Snake: {toSnake("orderFulfillmentService")}")
    _ <- Console.log("Score: {normalizeScore(105.678)}")
    _ <- Console.log("Sum: {summarizeNumbers([10, 20, 30])}")
    => 0
  }
