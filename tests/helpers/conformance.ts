import { expect } from "vitest";
import { format } from "../../src/formatter/index.js";

/**
 * Asserts that formatting the given FunScript source code is idempotent:
 * formatting once, then formatting that result a second time, produces the identical output.
 *
 * @param source FunScript source code to format.
 * @returns The formatted output string from the first pass for further assertions.
 */
export function assertFormattingIdempotent(source: string): string {
  const firstPass = format(source);
  const secondPass = format(firstPass);
  expect(secondPass, "Formatting must be idempotent across multiple passes").toBe(firstPass);
  return firstPass;
}
