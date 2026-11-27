import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Effect } from "effect";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  typeCheckSource,
  typeCheckVirtualFiles,
  typeCheckFiles,
  formatDiagnostics,
} from "../src/compiler/check.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve("./dist/cli/index.js");

describe("In-Memory Type-Checking (funscript check via TypeScript API)", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "funscript-check-test-"));
  });

  afterAll(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe("typeCheckSource unit checks", () => {
    it("type-checks brace-delimited Effect expressions", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
fetchValue = () => Effect.succeed(42)
export result: Effect<Number> = effect {
  value <- fetchValue()
  => value + 1
}
`.trim(),
          "brace-effect.fun",
        ),
      );
      expect(result.success).toBe(true);
      expect(result.diagnostics).toHaveLength(0);
    });

    it("passes cleanly on valid FunScript code with no diagnostics", async () => {
      const code = `
export name: String = "Ada"
export age: Number = 36
export greet = (n: String) => "Hello, " + n
export message = greet(name)
`.trim();

      const result = await Effect.runPromise(
        typeCheckSource(code, "valid.fun"),
      );
      expect(result.success).toBe(true);
      expect(result.diagnostics).toHaveLength(0);
      expect(result.errorCount).toBe(0);
      expect(result.formattedOutput).toBe("");
    });

    it("rejects reference equality for value-only types", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
export same = (left: Number, right: Number) => left @= right
`.trim(),
          "reference-equality.fun",
        ),
      );

      expect(result.success).toBe(false);
      expect(
        result.diagnostics.some((d) =>
          d.message.includes("cannot be used with primitive values"),
        ),
      ).toBe(true);
    });

    it("requires handling and validation for an untrusted js result", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
ts { declare function nativeJson(): Promise<any> }
export result = effect {
  payload <- js nativeJson()
  => payload.name
}
`.trim(),
          "untrusted-js.fun",
        ),
      );

      expect(result.success).toBe(false);
      expect(
        result.diagnostics.some((d) =>
          d.message.includes("Property 'name' does not exist"),
        ),
      ).toBe(true);
    });

    it("rejects binding raw Promises in effect blocks with PROMISE_BIND and actionable guidance", async () => {
      const code = `
run = (client: { hIncrBy: (k: String) => Promise<Number> }) =>
  effect {
    x <- client.hIncrBy("key")
    => x
  }
`.trim();

      const result = await Effect.runPromise(
        typeCheckSource(code, "raw-promise.fun"),
      );
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "PROMISE_BIND")).toBe(
        true,
      );
      const diag = result.diagnostics.find((d) => d.code === "PROMISE_BIND");
      expect(diag!.message).toContain(
        "Cannot bind raw Promise in effect block",
      );
      expect(diag!.message).toContain(
        "must be explicitly lifted using the 'js' operator",
      );
    });

    it("accepts Promise binds when explicitly lifted with the 'js' operator", async () => {
      const code = `
run = (client: { hIncrBy: (k: String) => Promise<Number> }) =>
  effect {
    x <- js client.hIncrBy("key")
    => x
  }
`.trim();

      const result = await Effect.runPromise(
        typeCheckSource(code, "js-promise.fun"),
      );
      expect(result.success).toBe(true);
      expect(result.diagnostics).toHaveLength(0);
    });

    it("rejects binding untyped any expressions in effect blocks with ANY_BIND", async () => {
      const code = `
ts {
  export const client: any = {};
}

run = () =>
  effect {
    x <- client.hIncrBy("key")
    => x
  }
`.trim();

      const result = await Effect.runPromise(
        typeCheckSource(code, "any-bind.fun"),
      );
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "ANY_BIND")).toBe(true);
      const diag = result.diagnostics.find((d) => d.code === "ANY_BIND");
      expect(diag!.message).toContain(
        "Cannot bind untyped 'any' expression in effect block",
      );
    });

    it("detects variable type mismatch and maps back to original line and column", async () => {
      const code = `
export title: String = "FunScript"
export count: Number = "not-a-number"
`.trim();

      const result = await Effect.runPromise(
        typeCheckSource(code, "type-err.fun"),
      );
      expect(result.success).toBe(false);
      expect(result.errorCount).toBeGreaterThanOrEqual(1);

      const err = result.diagnostics.find((d) =>
        d.message.includes("not assignable to type 'number'"),
      );
      expect(err).toBeDefined();
      expect(err?.diagnosticCode).toMatch(/^TS\d+$/);
      expect(err?.explanation).toContain("generated source");
      expect(err!.file).toBe("type-err.fun");
      expect(err!.line).toBe(2);
      expect(err!.column).toBeGreaterThan(0);
      expect(err!.frame).toBeDefined();
      expect(err!.frame).toContain('export count: Number = "not-a-number"');
      expect(err!.formatted).toContain("type-err.fun:2:");
    });

    it("detects function argument type mismatch with exact line and column", async () => {
      const code = `
calculate = (a: Number, b: Number) => a + b
export result = calculate("hello", 42)
`.trim();

      const result = await Effect.runPromise(
        typeCheckSource(code, "func-err.fun"),
      );
      expect(result.success).toBe(false);

      const err = result.diagnostics.find((d) =>
        d.message.includes(
          "Argument of type 'string' is not assignable to parameter of type 'number'",
        ),
      );
      expect(err).toBeDefined();
      expect(err!.file).toBe("func-err.fun");
      expect(err!.line).toBe(2);
      expect(err!.column).toBe(27); // Points to "hello"
      expect(err!.frame).toBeDefined();
      expect(err!.frame).toContain('calculate("hello", 42)');
    });

    it("reports repeated invalid members on their respective source lines", async () => {
      const code =
        "export check = (value: Number) =>\n  first = value.missingMember()\n  => value.missingMember()";
      const result = await Effect.runPromise(
        typeCheckSource(code, "repeated.fun"),
      );
      const errors = result.diagnostics.filter((d) =>
        d.message.includes("missingMember"),
      );
      expect(errors.map((d) => d.line).sort()).toEqual([2, 3]);
    });

    it("detects function return type mismatch", async () => {
      const code = `
getAnswer = (): Number => "forty-two"
`.trim();

      const result = await Effect.runPromise(
        typeCheckSource(code, "ret-err.fun"),
      );
      expect(result.success).toBe(false);
      const err = result.diagnostics.find((d) =>
        d.message.includes("Type 'string' is not assignable to type 'number'"),
      );
      expect(err).toBeDefined();
      expect(err!.line).toBeGreaterThanOrEqual(1);
    });

    it("type checks Schema definitions and detects property type mismatches", async () => {
      const code = `
schema User = {
  id: Number
  email: String
}

export user: User = {
  id: "wrong-id",
  email: 12345
}
`.trim();

      const result = await Effect.runPromise(
        typeCheckSource(code, "schema-err.fun"),
      );
      expect(result.success).toBe(false);
      expect(result.errorCount).toBeGreaterThanOrEqual(2);

      const idErr = result.diagnostics.find((d) =>
        d.message.includes("Type 'string' is not assignable to type 'number'"),
      );
      expect(idErr).toBeDefined();
      expect(idErr!.line).toBe(7);

      const emailErr = result.diagnostics.find((d) =>
        d.message.includes("Type 'number' is not assignable to type 'string'"),
      );
      expect(emailErr).toBeDefined();
      expect(emailErr!.line).toBe(8);
    });

    it("type checks Effect structures imported from effect", async () => {
      const code = `
export eff: Effect<Number, Never, Never> = Effect.succeed("string-value")
`.trim();

      const result = await Effect.runPromise(
        typeCheckSource(code, "effect-err.fun"),
      );
      expect(result.success).toBe(false);
      const err = result.diagnostics.find(
        (d) =>
          d.message.includes(
            "Type 'string' is not assignable to type 'number'",
          ) || d.message.includes("Effect<string, never, never>"),
      );
      expect(err).toBeDefined();
      expect(err!.line).toBe(1);
    });

    it("handles FunScript syntax errors gracefully as diagnostics with code frames", async () => {
      const code = `
x = (
`.trim();

      const result = await Effect.runPromise(
        typeCheckSource(code, "syntax-err.fun"),
      );
      expect(result.success).toBe(false);
      expect(result.errorCount).toBe(1);
      expect(result.diagnostics[0].category).toBe("error");
      expect(result.diagnostics[0].code).toBe("SYNTAX");
      expect(result.diagnostics[0].diagnosticCode).toBe("FS_SYNTAX");
      expect(result.diagnostics[0].line).toBe(1);
      expect(result.diagnostics[0].frame).toBeDefined();
    });

    it("makes ambient type-fest utility types available in .fun source files and passes type checking", async () => {
      const code = `
ts {
  type Base = { id: string } & { name: string; age: number }
  type Flattened = Simplify<Base>
  type Prettified = Prettify<Base>
  type WithoutAge = Except<Flattened, "age">
  type OptAge = SetOptional<Flattened, "age">
  type UserId = Tagged<string, "UserId">
}

export schema User = from ts<Flattened>
export schema UserWithoutAge = from ts<WithoutAge>
export schema UserOptAge = from ts<OptAge>
`.trim();

      const result = await Effect.runPromise(
        typeCheckSource(code, "type-fest-ambient.fun"),
      );
      expect(result.success).toBe(true);
      expect(result.diagnostics).toHaveLength(0);
      expect(result.errorCount).toBe(0);
    });

    it("enforces nominal typing with ambient Tagged<T, Tag>", async () => {
      const code = `
ts {
  type UserId = Tagged<string, "UserId">
  type OrderId = Tagged<string, "OrderId">
  const takesUserId = (id: UserId) => id
  const raw: string = "user-1"
  takesUserId(raw)
}
`.trim();

      const result = await Effect.runPromise(
        typeCheckSource(code, "tagged-err.fun"),
      );
      expect(result.success).toBe(false);
      expect(result.errorCount).toBeGreaterThanOrEqual(1);
      const tagErr = result.diagnostics.find(
        (d) =>
          d.message.includes(
            "Argument of type 'string' is not assignable to parameter of type 'UserId'",
          ) || d.message.includes('Tag<"UserId", never>'),
      );
      expect(tagErr).toBeDefined();
    });
  });

  describe("typeCheckVirtualFiles multi-file checks", () => {
    it("resolves and type checks imports between virtual modules", async () => {
      const files = {
        "src/utils.fun": `
export multiply = (a: Number, b: Number) => a * b
`.trim(),
        "src/main.fun": `
import { multiply } from "./utils.js"
export res = multiply(6, "invalid")
`.trim(),
      };

      const result = await Effect.runPromise(typeCheckVirtualFiles(files));
      expect(result.success).toBe(false);

      const err = result.diagnostics.find((d) =>
        d.message.includes(
          "Argument of type 'string' is not assignable to parameter of type 'number'",
        ),
      );
      expect(err).toBeDefined();
      expect(err!.file).toBe("src/main.fun");
      expect(err!.line).toBe(2);
      expect(err!.column).toBe(26);
    });

    it("passes cleanly when multiple virtual modules have correct types", async () => {
      const files = {
        "src/types.fun": `
schema Config = {
  port: Number
  host: String
}
export config: Config = { port: 8080, host: "localhost" }
`.trim(),
        "src/server.fun": `
import { config } from "./types.js"
export getUrl = () => "http://" + config.host + ":" + config.port
`.trim(),
      };

      const result = await Effect.runPromise(typeCheckVirtualFiles(files));
      expect(result.success).toBe(true);
      expect(result.diagnostics).toHaveLength(0);
    });
  });

  describe(".funx component type checking", () => {
    it("type checks .funx UI components and detects prop errors", async () => {
      const code = `
schema Props = {
  label: String
}

export Button = (props: Props) =>
  => <button>{props.unknownProp}</button>
`.trim();

      const result = await Effect.runPromise(
        typeCheckSource(code, "Button.funx"),
      );
      expect(result.success).toBe(false);
      const err = result.diagnostics.find((d) =>
        d.message.includes("Property 'unknownProp' does not exist"),
      );
      expect(err).toBeDefined();
      expect(err!.file).toBe("Button.funx");
      expect(err!.line).toBe(6);
    });
  });

  describe("formatDiagnostics utility", () => {
    it("formats empty diagnostics as empty string", () => {
      expect(formatDiagnostics([])).toBe("");
    });

    it("formats multiple diagnostics with headers, frames, and error summary", () => {
      const formatted = formatDiagnostics([
        {
          file: "a.fun",
          line: 1,
          column: 5,
          message: "Type mismatch",
          category: "error",
          code: 2322,
          formatted: "a.fun:1:5 - error TS2322: Type mismatch\n  1 | test",
        },
        {
          file: "b.fun",
          line: 3,
          column: 2,
          message: "Unused variable",
          category: "warning",
          code: 6133,
          formatted:
            "b.fun:3:2 - warning TS6133: Unused variable\n  3 | let unused",
        },
      ]);

      expect(formatted).toContain("a.fun:1:5 - error TS2322: Type mismatch");
      expect(formatted).toContain(
        "b.fun:3:2 - warning TS6133: Unused variable",
      );
      expect(formatted).toContain("Found 1 error and 1 warning.");
    });
  });

  describe("CLI integration (funscript check)", () => {
    it("maps a generic constraint violation to its FunScript call", async () => {
      const testFile = path.join(tmpDir, "cli-generic.fun");
      await fs.writeFile(
        testFile,
        'ts { type Client = { close: () => void } }\nexport connect = <A extends Client>(factory: () => A) => factory()\nexport bad = connect(() => "bad")',
        "utf-8",
      );
      const result = await execFileAsync("node", [
        CLI_PATH,
        "check",
        testFile,
      ]).then(
        () => undefined,
        (error: any) => error,
      );
      expect(result?.code).toBe(1);
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(output).toContain("cli-generic.fun:3:");
      expect(output).toContain("not assignable to type 'Client'");
      expect(output).toContain('connect(() => "bad")');
    });

    it("exits with 0 and prints success message for a valid FunScript file", async () => {
      const testFile = path.join(tmpDir, "cli-valid.fun");
      await fs.writeFile(
        testFile,
        `
export square = (x: Number) => x * x
export res = square(5)
`.trim(),
        "utf-8",
      );

      const { stdout, stderr } = await execFileAsync("node", [
        CLI_PATH,
        "check",
        testFile,
      ]);
      expect(stderr).toBe("");
      expect(stdout).toContain(`✓ ${testFile} checked successfully (0 errors`);
    });

    it("exits with 1 and prints mapped diagnostics with @babel/code-frame for a file with type errors", async () => {
      const testFile = path.join(tmpDir, "cli-invalid.fun");
      await fs.writeFile(
        testFile,
        `
greet = (name: String) => "Hello, " + name
export res = greet(12345)
`.trim(),
        "utf-8",
      );

      let failed = false;
      try {
        await execFileAsync("node", [CLI_PATH, "check", testFile]);
      } catch (err: any) {
        failed = true;
        expect(err.code).toBe(1);
        const output = (err.stderr || "") + (err.stdout || "");
        expect(output).toContain("cli-invalid.fun:2:");
        expect(output).toContain(
          "Argument of type 'number' is not assignable to parameter of type 'string'",
        );
        expect(output).toContain("greet(12345)");
        expect(output).toContain("Found 1 error.");
      }
      expect(failed).toBe(true);
    });

    it("checks multiple files passed on the command line", async () => {
      const fileA = path.join(tmpDir, "cli-multi-a.fun");
      const fileB = path.join(tmpDir, "cli-multi-b.fun");
      await fs.writeFile(fileA, 'export name = "Ada"\n', "utf-8");
      await fs.writeFile(fileB, "export age = 36\n", "utf-8");

      const { stdout } = await execFileAsync("node", [
        CLI_PATH,
        "check",
        fileA,
        fileB,
      ]);
      expect(stdout).toContain("✓ Checked 2 files successfully (0 errors");
    });
  });

  describe("Pit of Success enforcements: Hidden inputs & Structured Concurrency", () => {
    it("rejects hidden non-deterministic inputs (Date.now, Date, performance.now, crypto.randomUUID)", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
export checkTime = () => Date.now()
export checkDate = () => Date()
export checkPerf = () => performance.now()
export checkUuid = () => crypto.randomUUID()
`.trim(),
          "time.fun",
        ),
      );

      expect(result.success).toBe(false);
      expect(result.errorCount).toBe(4);
      const codes = result.diagnostics.map((d) => d.code);
      expect(codes).toContain("HIDDEN_INPUT");
      expect(result.formattedOutput).toContain("Date.now()");
      expect(result.formattedOutput).toContain("Date()");
      expect(result.formattedOutput).toContain("performance.now()");
      expect(result.formattedOutput).toContain("crypto.randomUUID()");
      expect(result.formattedOutput).toContain("Time is an Effect service");
    });

    it("allows Date.now inside raw ts escape hatches", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
ts {
  export const getNow = () => Date.now();
  export const getRand = () => Math.random();
}
export value = 42
`.trim(),
          "escape.fun",
        ),
      );

      expect(result.success).toBe(true);
      expect(result.errorCount).toBe(0);
    });

    it("rejects Effect.forkDetach outside entry modules", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect } from "effect"

export task = Effect.succeed(42)
export leakCall = Effect.forkDetach(task)
export leakPipe = task |> Effect.forkDetach
`.trim(),
          "worker.fun",
        ),
      );

      expect(result.success).toBe(false);
      const codes = result.diagnostics.map((d) => d.code);
      expect(codes).toContain("DETACHED_FIBER");
      expect(result.formattedOutput).toContain("Effect.forkDetach");
      expect(result.formattedOutput).toContain("Effect.forkScoped");
    });

    it("permits Effect.forkDetach in entry modules (main.fun or export main)", async () => {
      const resultMain = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect } from "effect"

task = Effect.succeed(42)
export main = Effect.forkDetach(task)
`.trim(),
          "src/main.fun",
        ),
      );

      expect(resultMain.success).toBe(true);
      expect(resultMain.errorCount).toBe(0);

      const resultExportMain = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect } from "effect"

task = Effect.succeed(42)
export main = Effect.forkDetach(task)
`.trim(),
          "server.fun",
        ),
      );

      expect(resultExportMain.success).toBe(true);
      expect(resultExportMain.errorCount).toBe(0);
    });

    it("warns on unbounded concurrency options in Effect calls", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect } from "effect"

task = Effect.succeed(42)
export run = Effect.all([task], { concurrency: "unbounded" })
`.trim(),
          "tasks.fun",
        ),
      );

      expect(result.warningCount).toBe(1);
      const warn = result.diagnostics.find(
        (d) => d.code === "UNBOUNDED_CONCURRENCY",
      );
      expect(warn).toBeDefined();
      expect(warn?.category).toBe("warning");
      expect(warn?.message).toContain('concurrency: "unbounded"');
    });

    it("reports FS_REF_RACE on consecutive Ref.get and Ref.set calls", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect, Ref } from "effect"

export badIncrement = (counter: Ref) => effect {
  curr <- Ref.get(counter)
  _ <- Ref.set(counter, curr + 1)
  => curr
}
`.trim(),
          "counter.fun",
        ),
      );

      const race = result.diagnostics.find((d) => d.code === "REF_RACE");
      expect(race).toBeDefined();
      expect(race?.diagnosticCode).toBe("FS_REF_RACE");
      expect(race?.category).toBe("error");
      expect(race?.message).toContain("Insecure non-atomic Ref mutation");
    });

    it("reports FS_TOP_LEVEL_REF on module-level mutable Ref allocations", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
import { Ref } from "effect"

export counter = Ref.unsafeMake(0)
`.trim(),
          "lib/counter.fun",
        ),
      );

      const refDiag = result.diagnostics.find(
        (d) => d.code === "TOP_LEVEL_REF",
      );
      expect(refDiag).toBeDefined();
      expect(refDiag?.diagnosticCode).toBe("FS_TOP_LEVEL_REF");
      expect(refDiag?.category).toBe("error");
      expect(refDiag?.message).toContain(
        "allocates a mutable Ref at module scope",
      );
    });

    it("warns FS_EAGER_SUCCEED when calling functions inside Effect.succeed", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect } from "effect"

compute = () => 42
export task = Effect.succeed(compute())
export literal = Effect.succeed(42)
`.trim(),
          "task.fun",
        ),
      );

      const eager = result.diagnostics.find((d) => d.code === "EAGER_SUCCEED");
      expect(eager).toBeDefined();
      expect(eager?.diagnosticCode).toBe("FS_EAGER_SUCCEED");
      expect(eager?.category).toBe("warning");
      expect(eager?.message).toContain("Effect.succeed");
      expect(eager?.message).toContain("evaluates its argument eagerly");
    });

    it("reports FS_UNTYPED_ERROR when failing with raw string or number literals in library code", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect } from "effect"

export failStr = () => Effect.fail("Not found")
export failNum = () => Effect.fail(404)
`.trim(),
          "lib/users.fun",
        ),
      );

      const untyped = result.diagnostics.filter(
        (d) => d.code === "UNTYPED_ERROR",
      );
      expect(untyped.length).toBe(2);
      expect(untyped[0].diagnosticCode).toBe("FS_UNTYPED_ERROR");
      expect(untyped[0].category).toBe("warning");
      expect(untyped[0].message).toContain("Effect.fail");
      expect(untyped[0].message).toContain("untyped literal");
    });

    it("reports FS_NESTED_MATCH on nested match expressions (match abuse)", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
export checkLock = (pid: Number) =>
  res = match
    | pid > 0 =>
      alive = true
      match alive
        | true => 1
        | false => 2
    | _ => 0
  => res
`.trim(),
          "lock.fun",
        ),
      );

      const nested = result.diagnostics.find((d) => d.code === "NESTED_MATCH");
      expect(nested).toBeDefined();
      expect(nested?.diagnosticCode).toBe("FS_NESTED_MATCH");
      expect(nested?.category).toBe("error");
      expect(nested?.message).toContain("Nested 'match' expression detected");
      expect(nested?.suggestedAction).toContain("Flatten the match");
    });

    it("supports multi-value tuple matching match (a, b) with tuple patterns", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
export classifyPair = (a: Boolean, b: Boolean): String =>
  match (a, b)
  | (true, true) => "both"
  | (true, false) => "first"
  | (false, _) => "not-first"

export combineOpts = (x: Option<Number>, y: Option<Number>): Number =>
  match (x, y)
  | (Some(n), Some(m)) => n + m
  | (Some(n), None) => n
  | (None, Some(m)) => m
  | (None, None) => 0
`.trim(),
          "tuple_match.fun",
        ),
      );

      expect(result.diagnostics.filter((d) => d.category === "error")).toEqual(
        [],
      );
    });

    it("narrows Unknown types using type guards in match arms and flags Reflect.* as UNSAFE_REFLECT", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
import { Predicate, Option } from "effect"

export describeUnknown = (x: Unknown): Number =>
  match x
  | _ when Predicate.isString(x) => x.length
  | _ when Predicate.isNumber(x) => x + 1
  | _ => 0

export readBlockGuard = (x: Unknown): Number =>
  match
  | Predicate.isString(x) =>
      len = x.length
      => len + 1
  | Option.isOption(x) =>
      hasVal = Option.isSome(x)
      => match hasVal
        | true => 1
        | false => 0
  | _ => 0

export unsafeReflectCall = (obj: Record<String, Unknown>): Unknown =>
  Reflect.get(obj, "key")
`.trim(),
          "narrow_guard.fun",
        ),
      );

      const errors = result.diagnostics.filter(
        (d) => d.category === "error" && d.code !== "NESTED_MATCH",
      );
      expect(errors).toEqual([]);
      const reflectWarn = result.diagnostics.find(
        (d) => d.code === "UNSAFE_REFLECT",
      );
      expect(reflectWarn).toBeDefined();
      expect(reflectWarn?.category).toBe("warning");
    });

    it("supports JSOptional<T> with fromNullishOr and match Some / None / None(null) / None(undefined)", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
export toLenViaPipe = (x: JSOptional<String>): Number =>
  x
  |> fromNullishOr
  |> Option.map((s) => s.length)
  |> Option.getOrElse(() => 0)

export matchJSOptional = (x: JSOptional<String>): Number =>
  match x
  | Some(s) => s.length
  | None => 0

export matchJSOptionalVariants = (x: JSOptional<String>): String =>
  match x
  | Some(s) => s
  | None(Null) => "null"
  | None(Undefined) => "undefined"
`.trim(),
          "js_optional.fun",
        ),
      );

      expect(result.diagnostics.filter((d) => d.category === "error")).toEqual(
        [],
      );
    });

    it("enforces exhaustive JSOptional match and rejects redundant Option wrapping", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
export missingNone = (x: JSOptional<String>): Number =>
  match x
  | Some(s) => s.length

export doubleWrap = (o: Option<String>) =>
  Option.fromNullishOr(o)
`.trim(),
          "js_optional_safe.fun",
        ),
      );

      const errors = result.diagnostics.filter((d) => d.category === "error");
      expect(errors.length).toBeGreaterThanOrEqual(2);
      expect(errors.some((d) => d.code === "REDUNDANT_OPTION_WRAP")).toBe(true);
    });

    it("reports FS_CAPTURED_MUT when outer mut variables are captured in effect or par blocks", async () => {
      // 1. Top-level mut variable captured in effect block
      const res1 = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect } from "effect"

mut globalCounter = 0

export inc = () => effect {
  globalCounter = globalCounter + 1
  => globalCounter
}
`.trim(),
          "bad_effect.fun",
        ),
      );

      const captured1 = res1.diagnostics.filter(
        (d) => d.code === "CAPTURED_MUT",
      );
      expect(captured1.length).toBeGreaterThan(0);
      expect(captured1[0].diagnosticCode).toBe("FS_CAPTURED_MUT");
      expect(captured1[0].category).toBe("error");
      expect(captured1[0].message).toContain(
        "Mutable variable 'globalCounter' declared outside this effect block cannot be captured inside an effect block",
      );
      expect(captured1[0].suggestedAction).toContain("Ref.make");

      // 2. Local mut variable in outer function captured in effect block
      const res2 = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect } from "effect"

export run = () =>
  mut count = 0
  effect {
    count = count + 1
    => count
  }
`.trim(),
          "bad_local.fun",
        ),
      );

      const captured2 = res2.diagnostics.filter(
        (d) => d.code === "CAPTURED_MUT",
      );
      expect(captured2.length).toBeGreaterThan(0);
      expect(captured2[0].diagnosticCode).toBe("FS_CAPTURED_MUT");
      expect(captured2[0].message).toContain(
        "Mutable variable 'count' declared outside this effect block cannot be captured inside an effect block",
      );

      // 3. Mut variable captured in par block
      const res3 = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect } from "effect"

mut total = 0

export run = () => par {
  total = total + 1
  => total
}
`.trim(),
          "bad_par.fun",
        ),
      );

      const captured3 = res3.diagnostics.filter(
        (d) => d.code === "CAPTURED_MUT",
      );
      expect(captured3.length).toBeGreaterThan(0);
      expect(captured3[0].diagnosticCode).toBe("FS_CAPTURED_MUT");

      // 4. Permitted: local mut variable declared inside the effect block itself
      const res4 = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect } from "effect"

export run = () => effect {
  mut local = 0
  local = local + 1
  => local
}
`.trim(),
          "ok_local.fun",
        ),
      );

      const captured4 = res4.diagnostics.filter(
        (d) => d.code === "CAPTURED_MUT",
      );
      expect(captured4.length).toBe(0);

      // 5. Permitted: immutable variables closed over across effect blocks
      const res5 = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect } from "effect"

factor = 2

export scale = (n: Number) => effect {
  => n * factor
}
`.trim(),
          "ok_immutable.fun",
        ),
      );

      const captured5 = res5.diagnostics.filter(
        (d) => d.code === "CAPTURED_MUT",
      );
      expect(captured5.length).toBe(0);
    });

    it("reports FS_MANUAL_SEMAPHORE on manual take or release calls", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect, Semaphore } from "effect"

export run = (sem: Semaphore) => effect {
  _ <- sem.take(1)
  _ <- Effect.sleep(100)
  _ <- sem.release(1)
  => "done"
}
`.trim(),
          "semaphore.fun",
        ),
      );

      const semDiag = result.diagnostics.find(
        (d) => d.code === "MANUAL_SEMAPHORE",
      );
      expect(semDiag).toBeDefined();
      expect(semDiag?.diagnosticCode).toBe("FS_MANUAL_SEMAPHORE");
      expect(semDiag?.category).toBe("error");
      expect(semDiag?.message).toContain(
        "Manual semaphore permit management leaks permits",
      );
    });

    it("warns FS_UNBOUNDED_QUEUE on Queue.unbounded() and bare Queue.make()", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect, Queue } from "effect"

export run = effect {
  q1 <- Queue.unbounded()
  q2 <- Queue.make()
  => q1
}
`.trim(),
          "queue.fun",
        ),
      );

      const queueWarnings = result.diagnostics.filter(
        (d) => d.code === "UNBOUNDED_QUEUE",
      );
      expect(queueWarnings.length).toBe(2);
      expect(queueWarnings[0].diagnosticCode).toBe("FS_UNBOUNDED_QUEUE");
      expect(queueWarnings[0].category).toBe("warning");
      expect(queueWarnings[0].message).toContain(
        "Queue created with infinite capacity",
      );
    });

    it("rejects running Effects mid-program (EFFECT_RUN) outside entry modules", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect } from "effect"

task = Effect.succeed(42)
export calc = Effect.runPromise(task)
export sync = task |> Effect.runSync
`.trim(),
          "lib/calc.fun",
        ),
      );

      expect(result.success).toBe(false);
      const codes = result.diagnostics.map((d) => d.code);
      expect(codes).toContain("EFFECT_RUN");
      expect(result.formattedOutput).toContain("Effect.runPromise");
      expect(result.formattedOutput).toContain("Effect.runSync");
      expect(result.formattedOutput).toContain(
        "executes an Effect mid-program",
      );
    });

    it("permits running Effects in entry modules (main.fun or export main)", async () => {
      const resultMain = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect } from "effect"

task = Effect.succeed(42)
export result = Effect.runPromise(task)
`.trim(),
          "src/main.fun",
        ),
      );

      expect(resultMain.success).toBe(true);
      expect(resultMain.errorCount).toBe(0);

      const resultExportMain = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect } from "effect"

task = Effect.succeed(42)
export main = Effect.runPromise(task)
`.trim(),
          "server.fun",
        ),
      );

      expect(resultExportMain.success).toBe(true);
      expect(resultExportMain.errorCount).toBe(0);
    });

    it("rejects reading process.env / Deno.env / Bun.env outside entry modules", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
import process from "node:process"

export port = process.env.PORT
export host = process.env["HOST"]
`.trim(),
          "lib/config.fun",
        ),
      );

      expect(result.success).toBe(false);
      const codes = result.diagnostics.map((d) => d.code);
      expect(codes).toContain("ENV_GLOBAL");
      expect(result.formattedOutput).toContain("process.env");
      expect(result.formattedOutput).toContain("Config");
    });

    it("permits reading process.env in entry modules or ts escape hatches", async () => {
      const resultEntry = await Effect.runPromise(
        typeCheckSource(
          `
import process from "node:process"

port = Number(process.env.PORT)
export main = port
`.trim(),
          "server.fun",
        ),
      );

      expect(resultEntry.success).toBe(true);
      expect(resultEntry.errorCount).toBe(0);

      const resultEscape = await Effect.runPromise(
        typeCheckSource(
          `
ts {
  const p = process.env.PORT;
  export const port = p ? Number(p) : 3000;
}
`.trim(),
          "lib/escape-config.fun",
        ),
      );

      expect(resultEscape.success).toBe(true);
      expect(resultEscape.errorCount).toBe(0);
    });

    it("rejects direct process access and Reflect bypasses in library modules while allowing user-shadowed process", async () => {
      const resultArgs = await Effect.runPromise(
        typeCheckSource(
          `
import process from "node:process"

export args = process.argv
export dir = process.cwd()
export envVal = Reflect.get(process, "env")
`.trim(),
          "lib/runtime.fun",
        ),
      );

      expect(resultArgs.success).toBe(false);
      const codes = resultArgs.diagnostics.map((d) => d.code);
      expect(codes).toContain("PROCESS_GLOBAL");
      expect(resultArgs.formattedOutput).toContain("process.argv");
      expect(resultArgs.formattedOutput).toContain("process.cwd");
      const argvDiag = resultArgs.diagnostics.find((d) =>
        d.message.includes("process.argv"),
      );
      expect(argvDiag?.suggestedAction).toContain("@effect/cli");
      const cwdDiag = resultArgs.diagnostics.find((d) =>
        d.message.includes("process.cwd"),
      );
      expect(cwdDiag?.suggestedAction).toContain("FileSystem");

      const resultExit = await Effect.runPromise(
        typeCheckSource(
          `
import process from "node:process"

export main = process.exit(1)
`.trim(),
          "server.fun",
        ),
      );
      expect(resultExit.success).toBe(false);
      expect(resultExit.diagnostics.map((d) => d.code)).toContain(
        "PROCESS_EXIT",
      );

      const resultShadowed = await Effect.runPromise(
        typeCheckSource(
          `
process = (x: Number) => x * 2
export out = process(21)
`.trim(),
          "lib/math.fun",
        ),
      );
      expect(resultShadowed.success).toBe(true);
      expect(resultShadowed.errorCount).toBe(0);
    });

    it("rejects throw keyword and throwing functions (Option.getOrThrow, JSON.parse, Error) with THROW", async () => {
      // 1. Keyword throw
      const resultThrow = await Effect.runPromise(
        typeCheckSource(
          "export fail = () => throw new Error('boom')",
          "lib/throw.fun",
        ),
      );
      expect(resultThrow.success).toBe(false);
      expect(
        resultThrow.diagnostics.some(
          (d) => d.code === "THROW" || d.diagnosticCode === "FS_THROW",
        ),
      ).toBe(true);

      // 2. JSON.parse (checked at emission)
      const resultJson = await Effect.runPromise(
        typeCheckSource(
          "export parse = (s: String) => JSON.parse(s)",
          "lib/json-parse.fun",
        ),
      );
      expect(resultJson.success).toBe(false);
      expect(
        resultJson.diagnostics.some(
          (d) => d.code === "THROW" || d.diagnosticCode === "FS_THROW",
        ),
      ).toBe(true);
      expect(resultJson.formattedOutput).toContain("JSON.parse");

      // 3. Option.getOrThrow and Error(...)
      const resultThrowCalls = await Effect.runPromise(
        typeCheckSource(
          `
import { Option } from "effect"

export unwrap = (o: Option<Number>) => Option.getOrThrow(o)
export unwrapPipe = (o: Option<Number>) => o |> Option.getOrThrow
export rawError = (msg: String) => Error(msg)
`.trim(),
          "lib/throwing-helpers.fun",
        ),
      );

      expect(resultThrowCalls.success).toBe(false);
      const throwDiags = resultThrowCalls.diagnostics.filter(
        (d) => d.code === "THROW",
      );
      expect(throwDiags.length).toBeGreaterThanOrEqual(3);
      expect(resultThrowCalls.formattedOutput).toContain("Option.getOrThrow");
      expect(resultThrowCalls.formattedOutput).toContain("Error(...)");
    });

    it("rejects unmanaged native APIs (fetch, setTimeout, console.log in library) with NATIVE_API", async () => {
      const resultNative = await Effect.runPromise(
        typeCheckSource(
          `
export timer = (cb: () => Void) => setTimeout(cb, 100)
export callApi = (url: String) => fetch(url)
export log = (msg: String) => console.log(msg)
`.trim(),
          "lib/native-calls.fun",
        ),
      );

      expect(resultNative.success).toBe(false);
      const nativeDiags = resultNative.diagnostics.filter(
        (d) => d.code === "NATIVE_API",
      );
      expect(nativeDiags.length).toBeGreaterThanOrEqual(3);
      expect(resultNative.formattedOutput).toContain("setTimeout");
      expect(resultNative.formattedOutput).toContain("fetch");
      expect(resultNative.formattedOutput).toContain("console.log");
    });

    it("permits js fetch(...) and console.log in entry modules", async () => {
      const resultEntry = await Effect.runPromise(
        typeCheckSource(
          `
ts { declare function fetch(url: string): Promise<any> }

export main = () =>
  console.log("Starting server...")
`.trim(),
          "src/main.fun",
        ),
      );

      expect(resultEntry.success).toBe(true);
      expect(resultEntry.errorCount).toBe(0);

      const resultJsInterop = await Effect.runPromise(
        typeCheckSource(
          `
ts { declare function fetch(url: string): Promise<{ ok: boolean }> }

export fetchUser = (url: String) =>
  effect {
    res <- js fetch(url)
    => res
  }
`.trim(),
          "lib/api-interop.fun",
        ),
      );

      expect(resultJsInterop.success).toBe(true);
      expect(resultJsInterop.errorCount).toBe(0);
    });

    it("rejects returning an Effect from inside an effect block (NESTED_EFFECT)", async () => {
      const resultNested = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect } from "effect"

fetchData = () => Effect.succeed("data")

export task = effect {
  _ <- Effect.succeed(1)
  => fetchData()
}
`.trim(),
          "lib/nested-effect.fun",
        ),
      );

      expect(resultNested.success).toBe(false);
      const nestedDiag = resultNested.diagnostics.find(
        (d) => d.code === "NESTED_EFFECT",
      );
      expect(nestedDiag).toBeDefined();
      expect(nestedDiag?.diagnosticCode).toBe("FS_NESTED_EFFECT");
      expect(nestedDiag?.message).toContain(
        "Returning an Effect from inside an 'effect' block creates a nested 'Effect<Effect<...>>'",
      );
      expect(resultNested.formattedOutput).toContain("fetchData()");

      // Valid: binding with <- and returning result
      const resultValid = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect } from "effect"

fetchData = () => Effect.succeed("data")

export task = effect {
  fetched <- fetchData()
  => fetched
}
`.trim(),
          "lib/valid-effect.fun",
        ),
      );

      expect(resultValid.success).toBe(true);
      expect(resultValid.errorCount).toBe(0);
    });

    it("auto-imports standard library Effect modules and types without manual import headers", async () => {
      const resultPrelude = await Effect.runPromise(
        typeCheckSource(
          `
export num = Option.some(42)
export dur = Duration.millis(100)
export cfg = Config.String("PORT")
export readTime = effect {
  t <- Clock.currentTimeMillis
  => t
}
`.trim(),
          "lib/prelude-sample.fun",
        ),
      );

      expect(resultPrelude.success).toBe(true);
      expect(resultPrelude.errorCount).toBe(0);
    });

    it("quarantines in-place array mutation outside mut (draft) => with FS_INPLACE_MUTATION", async () => {
      // 1. Rejected outside mut block
      const resultMutate = await Effect.runPromise(
        typeCheckSource(
          `
export addItem = (arr: Array<Number>, item: Number) =>
  arr.push(item)
  => arr
`.trim(),
          "lib/bad-mutation.fun",
        ),
      );

      expect(resultMutate.success).toBe(false);
      const mutDiag = resultMutate.diagnostics.find(
        (d) =>
          d.code === "INPLACE_MUTATION" ||
          d.diagnosticCode === "FS_INPLACE_MUTATION",
      );
      expect(mutDiag).toBeDefined();
      expect(mutDiag?.diagnosticCode).toBe("FS_INPLACE_MUTATION");
      expect(mutDiag?.message).toContain(
        "In-place mutation '.push()' is quarantined in FunScript",
      );
      expect(mutDiag?.suggestedAction).toContain("mut (draft) =>");

      // 2. Permitted inside mut (draft) =>
      const resultValidMut = await Effect.runPromise(
        typeCheckSource(
          `
export addItem = (arr: Array<Number>, item: Number) =>
  arr |> mut (draft) =>
    draft.push(item)
    => draft
`.trim(),
          "lib/good-mutation.fun",
        ),
      );

      expect(resultValidMut.success).toBe(true);
      expect(resultValidMut.errorCount).toBe(0);
    });

    it("quarantines legacy TS globals and guides developer to proper Effect tools", async () => {
      // 1. Bare native API references and TypeError
      const resultLegacy = await Effect.runPromise(
        typeCheckSource(
          `
export myFetch = fetch
export myTimer = setTimeout
export badErr = TypeError("invalid argument")
`.trim(),
          "lib/legacy-globals.fun",
        ),
      );

      expect(resultLegacy.success).toBe(false);
      const fetchDiag = resultLegacy.diagnostics.find((d) =>
        d.message.includes("fetch"),
      );
      expect(fetchDiag).toBeDefined();
      expect(fetchDiag?.category).toBe("error");
      expect(fetchDiag?.suggestedAction).toContain("HttpClient");

      const timerDiag = resultLegacy.diagnostics.find((d) =>
        d.message.includes("setTimeout"),
      );
      expect(timerDiag).toBeDefined();
      expect(timerDiag?.suggestedAction).toContain("Effect.sleep");

      const errorDiag = resultLegacy.diagnostics.find((d) =>
        d.message.includes("TypeError"),
      );
      expect(errorDiag).toBeDefined();
      expect(errorDiag?.code).toBe("THROW");
      expect(errorDiag?.suggestedAction).toContain("Effect.dieMessage");
    });

    it("supports ambient decodeJson and encodeJson codec helpers in pipelines and direct calls", async () => {
      const resultCodec = await Effect.runPromise(
        typeCheckSource(
          `
export schema User = {
  id: Number
  name: String
}

export parseEffect = (raw: String) =>
  effect {
    user <- raw |> decodeJson(User)
    jsonText <- user |> encodeJson(User)
    => jsonText
  }

export parseDirect = (raw: String) => decodeJson(User, raw)
export parseMember = (raw: String) => raw |> User.decodeJson
export parseSync = (raw: String) => raw |> decodeJsonSync(User)
export encodeMember = (u: User) => u |> User.encodeJson
export encodeSync = (u: User) => u |> encodeJsonSync(User)
`.trim(),
          "lib/json-codec.fun",
        ),
      );

      expect(resultCodec.success).toBe(true);
      expect(resultCodec.errorCount).toBe(0);
    });

    it("detects non-exhaustive pattern match with FS_NON_EXHAUSTIVE_MATCH and actionable guidance", async () => {
      // 1. Missing variant 'Overnight' without wildcard
      const resultMissing = await Effect.runPromise(
        typeCheckSource(
          `
export schema DeliveryTier =
  | Standard
  | Express
  | Overnight

export handle = (tier: DeliveryTier) =>
  match tier
    | Standard => "standard"
    | Express => "express"
`.trim(),
          "lib/missing-arm.fun",
        ),
      );

      expect(resultMissing.success).toBe(false);
      const exhDiag = resultMissing.diagnostics.find(
        (d) =>
          d.code === "NON_EXHAUSTIVE_MATCH" ||
          d.diagnosticCode === "FS_NON_EXHAUSTIVE_MATCH",
      );
      expect(exhDiag).toBeDefined();
      expect(exhDiag?.diagnosticCode).toBe("FS_NON_EXHAUSTIVE_MATCH");
      expect(exhDiag?.message).toContain("Pattern match is not exhaustive");
      expect(exhDiag?.message).toContain("Overnight");
      expect(exhDiag?.suggestedAction).toContain(
        "Add arm '| Overnight => ...'",
      );

      // 2. Exhaustive match with all arms passes cleanly
      const resultExhaustive = await Effect.runPromise(
        typeCheckSource(
          `
export schema DeliveryTier =
  | Standard
  | Express
  | Overnight

export handle = (tier: DeliveryTier) =>
  match tier
    | Standard => "standard"
    | Express => "express"
    | Overnight => "overnight"
`.trim(),
          "lib/exhaustive-arm.fun",
        ),
      );

      expect(resultExhaustive.success).toBe(true);
      expect(resultExhaustive.errorCount).toBe(0);
    });

    it("reports FS_UNHANDLED_ERROR for an Effect error-channel mismatch", async () => {
      const result = await Effect.runPromise(
        typeCheckSource(
          `
export error Boom(message: String)

export foo = (x: Number) => Effect.fail(Boom({ message: "x" }))

export bar = (): Effect<Number, Never, Never> => foo(1)
`.trim(),
          "lib/unhandled-error.fun",
        ),
      );

      expect(result.success).toBe(false);
      const diag = result.diagnostics.find(
        (d) => d.diagnosticCode === "FS_UNHANDLED_ERROR",
      );
      expect(diag).toBeDefined();
      expect(diag?.message).toContain("Effect error channel mismatch");
    });

    it("reports FS_INDEX_OPTION_PROPERTY when chaining property access onto an indexed array element", async () => {
      // 1. Chaining property access onto an indexed array element is rejected
      const resultInvalid = await Effect.runPromise(
        typeCheckSource(
          `
export schema Agent = { id: String }
export state = { agents: [{ id: "Dev Agent 1" }] }
export agentName = state.agents[0].id
`.trim(),
          "lib/invalid-index-prop.fun",
        ),
      );

      expect(resultInvalid.success).toBe(false);
      const diag = resultInvalid.diagnostics.find(
        (d) =>
          d.code === "INDEX_OPTION_PROPERTY" ||
          d.diagnosticCode === "FS_INDEX_OPTION_PROPERTY",
      );
      expect(diag).toBeDefined();
      expect(diag?.diagnosticCode).toBe("FS_INDEX_OPTION_PROPERTY");
      expect(diag?.category).toBe("error");
      expect(diag?.message).toBe(
        "Array indexing returns an Option<T>. Unwrap with match, Option.map, or Option.getOrElse before accessing properties.",
      );
      expect(diag?.suggestedAction).toContain("Option.map");

      // 2. Chaining a method call onto an indexed array element is also rejected
      const resultMethod = await Effect.runPromise(
        typeCheckSource(
          `
export schema Service = { getStatus: () => String }
export list: Array<Service> = []
export status = list[0].getStatus()
`.trim(),
          "lib/invalid-index-method.fun",
        ),
      );
      expect(resultMethod.success).toBe(false);
      const methodDiag = resultMethod.diagnostics.find(
        (d) =>
          d.code === "INDEX_OPTION_PROPERTY" ||
          d.diagnosticCode === "FS_INDEX_OPTION_PROPERTY",
      );
      expect(methodDiag).toBeDefined();

      // 3. String literal indexing (e.g. dictionary / record lookup) is allowed
      const resultStringKey = await Effect.runPromise(
        typeCheckSource(
          `
export lookup = { dev: { id: "d1" } }
export id = lookup["dev"].id
`.trim(),
          "lib/valid-string-key.fun",
        ),
      );
      const stringKeyDiag = resultStringKey.diagnostics.find(
        (d) =>
          d.code === "INDEX_OPTION_PROPERTY" ||
          d.diagnosticCode === "FS_INDEX_OPTION_PROPERTY",
      );
      expect(stringKeyDiag).toBeUndefined();

      // 4. Explicit unwrapping via Option.map passes cleanly
      const resultOptionMap = await Effect.runPromise(
        typeCheckSource(
          `
import { Option } from "effect"

export schema Agent = { id: String }
export state = { agents: [{ id: "Dev Agent 1" }] }
export agentName = state.agents[0] |> Option.map((a) => a.id)
`.trim(),
          "lib/valid-option-map.fun",
        ),
      );
      const optionMapDiag = resultOptionMap.diagnostics.find(
        (d) =>
          d.code === "INDEX_OPTION_PROPERTY" ||
          d.diagnosticCode === "FS_INDEX_OPTION_PROPERTY",
      );
      expect(optionMapDiag).toBeUndefined();
    });

    it("enforces effect (unscoped) for resource constructors with finalizers (FS_PREMATURE_FINALIZER_CLOSE)", async () => {
      // 1. Scoped effect returning a resource with Effect.addFinalizer triggers FS_PREMATURE_FINALIZER_CLOSE
      const badResult = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect } from "effect"

export spawnProcess = (cmd: Array<String>) => effect {
  proc = { pid: 1234, kill: () => Void }
  _ <- Effect.addFinalizer(() => proc.kill())
  => proc
}
`.trim(),
          "lib/spawn-bad.fun",
        ),
      );
      const badDiag = badResult.diagnostics.find(
        (d) =>
          d.code === "PREMATURE_FINALIZER_CLOSE" ||
          d.diagnosticCode === "FS_PREMATURE_FINALIZER_CLOSE",
      );
      expect(badDiag).toBeDefined();
      expect(badDiag?.category).toBe("error");
      expect(badDiag?.message).toContain(
        "Finalizer registered with 'Effect.addFinalizer' in a scoped effect block",
      );
      expect(badDiag?.suggestedAction).toContain(
        "Change 'effect' to 'effect (unscoped)'",
      );

      // 2. effect (unscoped) returning a resource passes cleanly without FS_PREMATURE_FINALIZER_CLOSE
      const goodUnscoped = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect } from "effect"

export spawnProcess = (cmd: Array<String>) => effect (unscoped) {
  proc = { pid: 1234, kill: () => Void }
  _ <- Effect.addFinalizer(() => proc.kill())
  => proc
}
`.trim(),
          "lib/spawn-good.fun",
        ),
      );
      const unscopedDiag = goodUnscoped.diagnostics.find(
        (d) =>
          d.code === "PREMATURE_FINALIZER_CLOSE" ||
          d.diagnosticCode === "FS_PREMATURE_FINALIZER_CLOSE",
      );
      expect(unscopedDiag).toBeUndefined();

      // 3. Scoped effect returning Void is a valid consumer boundary and passes without diagnostic
      const goodUnit = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect } from "effect"

export runTask = (cmd: Array<String>) => effect {
  proc = { pid: 1234, kill: () => Void }
  _ <- Effect.addFinalizer(() => proc.kill())
  => Void
}
`.trim(),
          "lib/task-unit.fun",
        ),
      );
      const unitDiag = goodUnit.diagnostics.find(
        (d) =>
          d.code === "PREMATURE_FINALIZER_CLOSE" ||
          d.diagnosticCode === "FS_PREMATURE_FINALIZER_CLOSE",
      );
      expect(unitDiag).toBeUndefined();

      // 4. Scoped effect with Effect.acquireRelease returning a resource triggers diagnostic
      const badAcquire = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect } from "effect"

export openResource = effect {
  res <- Effect.acquireRelease(Effect.succeed({ fd: 1 }), () => Effect.void)
  => res
}
`.trim(),
          "lib/acquire-bad.fun",
        ),
      );
      const acquireDiag = badAcquire.diagnostics.find(
        (d) =>
          d.code === "PREMATURE_FINALIZER_CLOSE" ||
          d.diagnosticCode === "FS_PREMATURE_FINALIZER_CLOSE",
      );
      expect(acquireDiag).toBeDefined();
    });

    it("rejects typed holes (???) by default with actionable error code-frame and allows them when allowHoles is enabled", async () => {
      const code = `
export calculateTax = (amount: Number): Number => ???
`.trim();

      const resultBad = await Effect.runPromise(
        typeCheckSource(code, "src/billing.fun"),
      );
      expect(resultBad.success).toBe(false);
      expect(resultBad.errorCount).toBeGreaterThanOrEqual(1);

      const holeDiag = resultBad.diagnostics.find(
        (d) => d.code === "TYPED_HOLE" || d.diagnosticCode === "FS_TYPED_HOLE",
      );
      expect(holeDiag).toBeDefined();
      expect(holeDiag?.category).toBe("error");
      expect(holeDiag?.message).toContain(
        "Typed hole '???' is unfinished code.",
      );
      expect(holeDiag?.suggestedAction).toContain(
        "Implement this expression before building or type-checking.",
      );
      expect(holeDiag?.formatted).toContain("src/billing.fun");
      expect(holeDiag?.formatted).toContain("???");

      const resultGood = await Effect.runPromise(
        typeCheckSource(code, "src/billing.fun", { allowHoles: true }),
      );
      expect(resultGood.success).toBe(true);
      expect(resultGood.errorCount).toBe(0);
    });

    it("supports bare fromNullishOrElse in pipelines and direct calls with JSOptional params", async () => {
      const code = `
export greetWithFallback = (name: JSOptional<String>): String =>
  name |> fromNullishOrElse("stranger")

export greetDirect = (name: JSOptional<String>): String =>
  fromNullishOrElse(name, "stranger")
`.trim();

      const result = await Effect.runPromise(
        typeCheckSource(code, "src/greet.fun"),
      );
      expect(result.success).toBe(true);
      expect(result.errorCount).toBe(0);
    });

    it("enforces UNHANDLED_NULLISH when binding nullable JS/TS values without lifting", async () => {
      const badCode = `
ts {
  declare function lookup(key: string): string | null;
}

export run = () =>
  val = lookup("a")
  => val
`.trim();

      const badResult = await Effect.runPromise(
        typeCheckSource(badCode, "src/nullish-edge.fun"),
      );
      expect(badResult.success).toBe(false);
      expect(
        badResult.diagnostics.some((d) => d.code === "UNHANDLED_NULLISH"),
      ).toBe(true);

      const goodCode = `
ts {
  declare function lookup(key: string): string | null;
}

export run = () =>
  val = lookup("a") |> fromNullishOr
  => val
`.trim();

      const goodResult = await Effect.runPromise(
        typeCheckSource(goodCode, "src/nullish-edge.fun"),
      );
      expect(goodResult.success).toBe(true);
      expect(goodResult.errorCount).toBe(0);
    });

    it("enforces UNHANDLED_NULLISH when returning nullable JS/TS values without lifting", async () => {
      const badBlockReturn = `
ts {
  declare function lookup(key: string): string | null;
}

export run = () =>
  => lookup("a")
`.trim();

      const badBlockRes = await Effect.runPromise(
        typeCheckSource(badBlockReturn, "src/nullish-return.fun"),
      );
      expect(badBlockRes.success).toBe(false);
      expect(
        badBlockRes.diagnostics.some((d) => d.code === "UNHANDLED_NULLISH"),
      ).toBe(true);

      const badEffectReturn = `
ts {
  declare function lookup(key: string): string | null;
}

export run = () => effect {
  => lookup("a")
}
`.trim();

      const badEffectRes = await Effect.runPromise(
        typeCheckSource(badEffectReturn, "src/nullish-effect-return.fun"),
      );
      expect(badEffectRes.success).toBe(false);
      expect(
        badEffectRes.diagnostics.some((d) => d.code === "UNHANDLED_NULLISH"),
      ).toBe(true);

      const badArrowReturn = `
ts {
  declare function lookup(key: string): string | null;
}

export run = () => lookup("a")
`.trim();

      const badArrowRes = await Effect.runPromise(
        typeCheckSource(badArrowReturn, "src/nullish-arrow-return.fun"),
      );
      expect(badArrowRes.success).toBe(false);
      expect(
        badArrowRes.diagnostics.some((d) => d.code === "UNHANDLED_NULLISH"),
      ).toBe(true);

      const goodReturn = `
ts {
  declare function lookup(key: string): string | null;
  function rawHelper(): string | null { return null; }
}

export run = () =>
  => lookup("a") |> fromNullishOr

export runDefault = () => effect {
  => lookup("a") |> fromNullishOrElse("fallback")
}

export runExplicit = (): JSOptional<String> =>
  => lookup("a")
`.trim();

      const goodRes = await Effect.runPromise(
        typeCheckSource(goodReturn, "src/nullish-return-good.fun"),
      );
      expect(goodRes.success, goodRes.formattedOutput).toBe(true);
      expect(goodRes.errorCount).toBe(0);
    });

    it("rejects raw null and undefined literals in FunScript expressions while allowing ts escapes", async () => {
      const nullRes = await Effect.runPromise(
        typeCheckSource("export x = null", "src/null-lit.fun"),
      );
      expect(nullRes.success).toBe(false);
      expect(
        nullRes.diagnostics.some((d) =>
          d.message.includes("FunScript has no 'null'"),
        ),
      ).toBe(true);

      const undefRes = await Effect.runPromise(
        typeCheckSource("export x = undefined", "src/undef-lit.fun"),
      );
      expect(undefRes.success).toBe(false);
      expect(
        undefRes.diagnostics.some((d) =>
          d.message.includes("FunScript has no 'undefined'"),
        ),
      ).toBe(true);

      const tsEscapeRes = await Effect.runPromise(
        typeCheckSource(
          "export x = ts { null as unknown }",
          "src/ts-escape-null.fun",
        ),
      );
      expect(tsEscapeRes.success).toBe(true);
    });

    it("flags exact undefined/null returns and Option<T> | undefined with UNHANDLED_NULLISH without REDUNDANT_OPTION_WRAP", async () => {
      const exactUndefRes = await Effect.runPromise(
        typeCheckSource(
          `
ts {
  declare function retUndef(): undefined;
  declare function retNull(): null;
}

export a = () => retUndef()
export b = () => retNull()
`.trim(),
          "src/exact-nullish-return.fun",
        ),
      );
      expect(exactUndefRes.success).toBe(false);
      expect(
        exactUndefRes.diagnostics.filter((d) => d.code === "UNHANDLED_NULLISH"),
      ).toHaveLength(2);

      const optUndefRes = await Effect.runPromise(
        typeCheckSource(
          `
import { Option } from "effect"

ts {
  declare function maybeOpt(): Option.Option<string> | undefined;
}

export bad = () => maybeOpt()
export wrapped = () => maybeOpt() |> fromNullishOr
`.trim(),
          "src/option-or-undefined.fun",
        ),
      );
      expect(optUndefRes.success).toBe(false);
      expect(
        optUndefRes.diagnostics.some((d) => d.code === "UNHANDLED_NULLISH"),
      ).toBe(true);
      expect(
        optUndefRes.diagnostics.some((d) => d.code === "REDUNDANT_OPTION_WRAP"),
      ).toBe(false);
    });

    it("suggests Either helpers for Either.getOrThrow in pipelines", async () => {
      const res = await Effect.runPromise(
        typeCheckSource(
          `
import { Either } from "effect"

export run = (e: Either.Either<Number, String>) => e |> Either.getOrThrow
`.trim(),
          "src/either-pipeline-throw.fun",
        ),
      );
      expect(res.success).toBe(false);
      const diag = res.diagnostics.find((d) => d.code === "THROW");
      expect(diag).toBeDefined();
      expect(diag?.suggestedAction).toContain("Either.getOrElse");
      expect(diag?.suggestedAction).toContain("Effect.fromEither");
      expect(diag?.suggestedAction).not.toContain("Option.");
    });

    it("classifies policy CompilerErrors as FS_POLICY rather than FS_SYNTAX", async () => {
      const noTsRes = await Effect.runPromise(
        typeCheckSource(
          `ts { const a = 1; }\nexport x = 1`,
          "src/no-ts-policy.fun",
          { noTs: true },
        ),
      );
      expect(noTsRes.success).toBe(false);
      expect(noTsRes.diagnostics[0]?.code).toBe("POLICY");
      expect(noTsRes.diagnostics[0]?.diagnosticCode).toBe("FS_POLICY");
      expect(noTsRes.diagnostics[0]?.explanation).not.toContain(
        "could not be parsed",
      );

      const earlyReturnRes = await Effect.runPromise(
        typeCheckSource(
          `export f = (x: Number) =>\n  when (x > 0) => 1\n  => 0`,
          "src/early-return-policy.fun",
        ),
      );
      expect(earlyReturnRes.success).toBe(false);
      expect(earlyReturnRes.diagnostics[0]?.code).toBe("POLICY");
      expect(earlyReturnRes.diagnostics[0]?.diagnosticCode).toBe("FS_POLICY");
    });

    it("does not suppress real TS2339 missing-property errors near fromNullishOr", async () => {
      const res = await Effect.runPromise(
        typeCheckSource(
          `
ts {
  declare function maybe(): string | null;
}
export bad = () =>
  x = fromNullishOr(maybe())
  => x.missingProp
`.trim(),
          "src/from-nullish-missing-prop.fun",
        ),
      );
      expect(res.success).toBe(false);
      expect(res.diagnostics.some((d) => d.code === 2339)).toBe(true);
    });

    it("only suggests String.Order in comparisonError when received type is string", async () => {
      const boolRes = await Effect.runPromise(
        typeCheckSource(
          `export bad = (a: Boolean, b: Boolean) => a < b`,
          "src/bool-compare.fun",
        ),
      );
      expect(boolRes.success).toBe(false);
      expect(boolRes.diagnostics[0]?.message).toContain(
        "Order.isLessThan(...)(...)",
      );
      expect(boolRes.diagnostics[0]?.message).not.toContain("String.Order");

      const strRes = await Effect.runPromise(
        typeCheckSource(
          `export bad = (a: String, b: String) => a < b`,
          "src/str-compare.fun",
        ),
      );
      expect(strRes.success).toBe(false);
      expect(strRes.diagnostics[0]?.message).toContain(
        "Order.isLessThan(String.Order)(...)",
      );
    });

    it("preserves per-declaration source map mappings when a file has imports", async () => {
      const { compileString } = await import("../src/compiler.js");
      const source = `import { Option } from "effect"\n\nexport x = Option.some(1)\nexport y = Option.some(2)`;
      const res = await Effect.runPromise(
        compileString(source, "src/with-imports.fun", { sourcemap: true }),
      );
      expect(res.map).toBeDefined();
      const mappings = res.map!.mappings;
      expect(mappings.split(";").length).toBeGreaterThanOrEqual(4);
    });

    it("flags ANY_BINDING and UNHANDLED_NULLISH in object and array destructuring", async () => {
      const res = await Effect.runPromise(
        typeCheckSource(
          `
ts {
  declare const jsAnyObj: any;
  declare const jsAnyArr: any[];
  declare const jsNullObj: { a: string | null };
  declare const jsNullArr: (number | undefined)[];
}

export run = () =>
  { a } = jsAnyObj
  [x] = jsAnyArr
  { a: b } = jsNullObj
  [y] = jsNullArr
  => [a, x, b, y]
`.trim(),
          "src/destructure-interop.fun",
        ),
      );
      expect(res.success).toBe(false);
      const anyDiags = res.diagnostics.filter((d) => d.code === "ANY_BINDING");
      const nullDiags = res.diagnostics.filter(
        (d) => d.code === "UNHANDLED_NULLISH",
      );
      expect(anyDiags.length).toBeGreaterThanOrEqual(2);
      expect(nullDiags.length).toBeGreaterThanOrEqual(2);
    });

    it("flags raw nullish values in object literals, arrays, Option.some, and Effect.succeed while skipping escapes and annotations", async () => {
      const res = await Effect.runPromise(
        typeCheckSource(
          `
import { Effect, Option } from "effect"

ts {
  declare function maybe(): string | undefined;
  type NullableBox = { a: string | undefined };
}

export badObj = () => ({ a: maybe() })
export badArr = () => [maybe()]
export badSome = () => Option.some(maybe())
export badSucceed = () => Effect.succeed(maybe())

export okEscaped = ts { ({ a: maybe() }) }
export okAnnotated: NullableBox = { a: maybe() }
export okAnnotatedArr: Array<JSOptional<String>> = [maybe()]
`.trim(),
          "src/nullish-containers.fun",
        ),
      );
      expect(res.success).toBe(false);
      const nullishDiags = res.diagnostics.filter(
        (d) => d.code === "UNHANDLED_NULLISH",
      );
      expect(nullishDiags.length).toBeGreaterThanOrEqual(4);
      expect(
        nullishDiags.some((d) => d.message.includes("Object property value")),
      ).toBe(true);
      expect(
        nullishDiags.some((d) => d.message.includes("Array element")),
      ).toBe(true);
      expect(nullishDiags.some((d) => d.message.includes("Option.some"))).toBe(
        true,
      );
      expect(
        nullishDiags.some((d) => d.message.includes("Effect.succeed")),
      ).toBe(true);
    });

    it("flags REDUNDANT_OPTION_WRAP for fromNullishOrElse and Option.fromNullable", async () => {
      const res = await Effect.runPromise(
        typeCheckSource(
          `
import { Option } from "effect"

export badElse = (x: Option<String>) => fromNullishOrElse(x, "fallback")
export badNullable = (x: Option<String>) => Option.fromNullable(x)
`.trim(),
          "src/redundant-wrap-extra.fun",
        ),
      );
      expect(res.success).toBe(false);
      const wrapDiags = res.diagnostics.filter(
        (d) => d.code === "REDUNDANT_OPTION_WRAP",
      );
      expect(wrapDiags).toHaveLength(2);
    });
  });
});
