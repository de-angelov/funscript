import { describe, it, expect } from "../src/testing/index.js"
import { pipe, Array } from "effect"

export add = (a: Int, b: Int): Int => a + b
export multiply = (a: Int, b: Int): Int => a * b
export double = (x: Int): Int => x * 2

suite = describe("native FunScript test suite", () =>
  it("executes arithmetic functions correctly", () =>
    expect(add(2, 3)).toBe(5)
  )

  it("handles multiplication", () =>
    expect(multiply(3, 4)).toBe(12)
  )

  => it("processes arrays via pipelines", () =>
    res = pipe([1, 2, 3], Array.map(double))
    => expect(res).toEqual([2, 4, 6])
  )
)
