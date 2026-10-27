import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compileString } from "../src/compiler.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("dist/cli/index.js");

describe("Sample Applications & Real-World Programs", () => {
  const programsDir = path.resolve("programs");
  const examplesDir = path.resolve("examples");

  describe("04-order-fulfillment.fun end-to-end showcase", () => {
    const programPath = path.join(programsDir, "04-order-fulfillment.fun");
    const examplePath = path.join(examplesDir, "order-fulfillment.fun");

    it("compiles cleanly to TypeScript with Effect, ts-pattern, and Mutative constructs", async () => {
      const source = await fs.readFile(programPath, "utf-8");
      const res = await Effect.runPromise(compileString(source, programPath));

      expect(res.typescript).toBeDefined();

      // Effect imports & features
      expect(res.typescript).toContain('import { Context, Data, Effect, Number, Schema, pipe } from "effect";');
      expect(res.typescript).toContain('import { Array, Console, Effect, Fiber, Layer, Number, Schedule, pipe } from "effect";');
      expect(res.typescript).toContain('import { match, P } from "ts-pattern";');
      expect(res.typescript).toContain('import { create } from "mutative";');

      // Tagged unions & pattern matching
      expect(res.typescript).toContain("export type DeliveryTier = Data.TaggedEnum<{");
      expect(res.typescript).toContain("export type PaymentMethod = Data.TaggedEnum<{");
      expect(res.typescript).toContain("export type OrderResult = Data.TaggedEnum<{");
      expect(res.typescript).toContain("match(tier)");
      expect(res.typescript).toContain(".exhaustive()");

      // Mutative deep updates & draft recipe
      expect(res.typescript).toContain("draft.shipping.carrier = carrier;");
      expect(res.typescript).toContain("draft.shipping.trackingNumber = trackingNumber;");
      expect(res.typescript).toContain("draft.push(entry);");

      // Effect concurrency, retry, fiber, and layers
      expect(res.typescript).toContain("Effect.all(checks, { concurrency: \"unbounded\" })");
      expect(res.typescript).toContain("Effect.retry(Schedule.recurs(2))");
      expect(res.typescript).toContain("Effect.fork(");
      expect(res.typescript).toContain("Fiber.join(");
      expect(res.typescript).toContain("Layer.succeed(InventoryService,");
      expect(res.typescript).toContain("Layer.merge(PaymentGatewayLive)");
    });

    it("executes programs/04-order-fulfillment.fun via CLI and verifies expected output", async () => {
      const { stdout, stderr } = await execFileAsync("node", [cliPath, "run", programPath]);
      expect(stderr).toBe("");

      // Scenario 1: Happy path with retry recovery and dispatch
      expect(stdout).toContain("=== Starting Fulfillment for Order ORD-9402 ===");
      expect(stdout).toContain("Stock available across all warehouses: 2 checked");
      expect(stdout).toContain("[PaymentGateway] Transient network glitch on attempt 1! Retrying...");
      expect(stdout).toContain("[PaymentGateway] Payment authorized successfully!");
      expect(stdout).toContain("[NotificationService] Sent confirmation to Grace Hopper");
      expect(stdout).toContain("Audit trail: 4 events logged immutably");
      expect(stdout).toContain("SUCCESS: Order ORD-9402 settled (Tx: TXN-90210) and dispatched with tracking #TRACK-GLO-8849");

      // Scenario 2: Error handling with catchAll
      expect(stdout).toContain("=== Starting Fulfillment for Order ORD-9999 ===");
      expect(stdout).toContain("[PaymentGateway] Transaction denied: credit limit exceeded");
      expect(stdout).toContain("[Workflow Recovery] Caught domain error: CreditLimitExceeded");
      expect(stdout).toContain("FAILED: Order ORD-9999 processing stopped: CreditLimitExceeded");
    });

    it("executes examples/order-fulfillment.fun identically", async () => {
      const { stdout, stderr } = await execFileAsync("node", [cliPath, "run", examplePath]);
      expect(stderr).toBe("");
      expect(stdout).toContain("=== Scenario 1 Result ===");
      expect(stdout).toContain("SUCCESS: Order ORD-9402 settled (Tx: TXN-90210) and dispatched with tracking #TRACK-GLO-8849");
      expect(stdout).toContain("=== Scenario 2 Result ===");
      expect(stdout).toContain("FAILED: Order ORD-9999 processing stopped: CreditLimitExceeded");
    });
  });

  describe("Existing sample programs compilation and execution", () => {
    it("runs 01-fibonacci.fun with expected output", async () => {
      const p = path.join(programsDir, "01-fibonacci.fun");
      const { stdout } = await execFileAsync("node", [cliPath, "run", p]);
      expect(stdout).toContain("fib(0) = 0");
      expect(stdout).toContain("fib(10) = 55");
    });

    it("runs 02-bank-account.fun with expected output", async () => {
      const p = path.join(programsDir, "02-bank-account.fun");
      const { stdout } = await execFileAsync("node", [cliPath, "run", p]);
      expect(stdout).toContain("Account ACC-101 (Ada Lovelace): Balance = $300");
    });

    it("runs 03-todo-service.fun with expected output", async () => {
      const p = path.join(programsDir, "03-todo-service.fun");
      const { stdout } = await execFileAsync("node", [cliPath, "run", p]);
      expect(stdout).toContain("Created 3 initial todos.");
      expect(stdout).toContain("Completed tasks #1 and #2.");
      expect(stdout).toContain("[x] #1: Buy coffee beans");
      expect(stdout).toContain("[x] #2: Design FunScript parser");
      expect(stdout).toContain("[ ] #3: Write blog post");
    });
  });
});
