import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import {
  migrateSource,
  migrateFile,
  migrateFiles,
  formatMigrationReport,
} from "../src/tooling/migrate.js";
import { Parser } from "../src/parser/parser.js";
import { Lexer } from "../src/lexer/lexer.js";

function parseStrict(source: string) {
  const tokens = new Lexer(source).tokenize();
  return new Parser(tokens, "test.fun", source).parse({ throwOnError: true });
}

describe("Safe Syntax Migration Tooling (TASK-166)", () => {
  describe("Safe Explicit-Return Transformations", () => {
    it("safely migrates indented function blocks ending in bare expressions", () => {
      const legacy = `increment = (value: Number) =>
  next = value + 1
  next
`;
      const result = migrateSource(legacy);
      expect(result.changed).toBe(true);
      expect(result.success).toBe(true);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].kind).toBe("explicit-return");
      expect(result.code).toBe(`increment = (value: Number) =>
  next = value + 1
  => next
`);

      // Verify transformed code parses cleanly under standard parser
      expect(() => parseStrict(result.code)).not.toThrow();
    });

    it("safely migrates braced function blocks", () => {
      const legacy = `calculate = (x: Number) => {
  multiplier = 2
  temp = x * multiplier
  temp + 1
}
`;
      const result = migrateSource(legacy);
      expect(result.changed).toBe(true);
      expect(result.success).toBe(true);
      expect(result.code).toBe(`calculate = (x: Number) => {
  multiplier = 2
  temp = x * multiplier
  => temp + 1
}
`);
      expect(() => parseStrict(result.code)).not.toThrow();
    });

    it("safely migrates single-line braced functions", () => {
      const legacy = `cube = (n: Number) => { n ** 3 }`;
      const result = migrateSource(legacy);
      expect(result.changed).toBe(true);
      expect(result.success).toBe(true);
      expect(result.code).toBe(`cube = (n: Number) => { => n ** 3 }`);
      expect(() => parseStrict(result.code)).not.toThrow();
    });

    it("preserves preceding, surrounding, and inline comments without disruption", () => {
      const legacy = `// Header comment for math operations
calculate = (x: Number) =>
  // Calculate temp
  temp = x * 2

  // Return final computation
  temp + 1 // inline comment after return
`;
      const result = migrateSource(legacy);
      expect(result.changed).toBe(true);
      expect(result.code).toBe(`// Header comment for math operations
calculate = (x: Number) =>
  // Calculate temp
  temp = x * 2

  // Return final computation
  => temp + 1 // inline comment after return
`);
      expect(() => parseStrict(result.code)).not.toThrow();
    });

    it("safely migrates nested functions and pipeline callbacks", () => {
      const legacy = `process = (items: Array<Number>) =>
  multiplier = 2
  items |> Array.map((x) =>
    doubled = x * multiplier
    doubled + 1
  )
`;
      const result = migrateSource(legacy);
      expect(result.changed).toBe(true);
      expect(result.success).toBe(true);
      // Both the outer function and inner callback block receive explicit returns
      expect(result.code).toBe(`process = (items: Array<Number>) =>
  multiplier = 2
  => items |> Array.map((x) =>
    doubled = x * multiplier
    => doubled + 1
  )
`);
      expect(() => parseStrict(result.code)).not.toThrow();
    });

    it("preserves early returns and migrates the final expression", () => {
      const legacy = `checkValue = (n: Number) =>
  when (n < 0) => 0
  doubled = n * 2
  doubled + 1
`;
      const result = migrateSource(legacy);
      expect(result.changed).toBe(true);
      expect(result.code).toBe(`checkValue = (n: Number) =>
  when (n < 0) => 0
  doubled = n * 2
  => doubled + 1
`);
      expect(() => parseStrict(result.code)).not.toThrow();
    });
  });

  describe("Preservation of Compliant Syntax", () => {
    it("does not modify concise expression-bodied functions", () => {
      const compliant = `add = (a: Number, b: Number) => a + b\n`;
      const result = migrateSource(compliant);
      expect(result.changed).toBe(false);
      expect(result.changes).toHaveLength(0);
      expect(result.code).toBe(compliant);
    });

    it("does not modify already compliant explicit returns", () => {
      const compliant = `increment = (value: Number) =>
  next = value + 1
  => next
`;
      const result = migrateSource(compliant);
      expect(result.changed).toBe(false);
      expect(result.changes).toHaveLength(0);
      expect(result.code).toBe(compliant);
    });

    it("does not modify mut draft blocks", () => {
      const source = `updateItem = (item: Item) => mut (draft) => {
  draft.count = draft.count + 1
}
`;
      const result = migrateSource(source);
      expect(result.changed).toBe(false);
      expect(result.changes).toHaveLength(0);
      expect(result.code).toBe(source);
    });

    it("does not modify when statement blocks", () => {
      const source = `validate = (n: Number) => {
  when (n < 0) {
    Logger.warn("negative")
  }
  => n
}
`;
      const result = migrateSource(source);
      expect(result.changed).toBe(false);
      expect(result.code).toBe(source);
    });

    it("preserves trailing match expression exemption by default", () => {
      const source = `describe = (n: Number) =>
  match n
    | 0 => "zero"
    | _ => "other"
`;
      const result = migrateSource(source);
      expect(result.changed).toBe(false);
      expect(result.code).toBe(source);
    });

    it("migrates trailing match expression when migrateTrailingMatch is requested", () => {
      const source = `describe = (n: Number) =>
  match n
    | 0 => "zero"
    | _ => "other"
`;
      const result = migrateSource(source, { migrateTrailingMatch: true });
      expect(result.changed).toBe(true);
      expect(result.code).toBe(`describe = (n: Number) =>
  => match n
    | 0 => "zero"
    | _ => "other"
`);
      expect(() => parseStrict(result.code)).not.toThrow();
    });
  });

  describe("Detection and Reporting of Ambiguous Constructs Without Modification", () => {
    it("reports ambiguous effect block trailing bare expressions without modifying them", () => {
      const source = `runProgram = () =>
  effect {
    user <- fetchUser("1")
    Console.log("done")
  }
`;
      const result = migrateSource(source);
      expect(result.changed).toBe(false);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].kind).toBe("ambiguous-effect-return");
      expect(result.diagnostics[0].severity).toBe("warning");
      expect(result.diagnostics[0].message).toContain("Effect block ends with a bare expression");
      expect(result.code).toBe(source);
    });

    it("reports ambiguous trailing binding declarations without modifying them", () => {
      const source = `buildUser = (id: String, name: String) =>
  normalized = name |> String.trim()
  user = { id, name: normalized }
`;
      const result = migrateSource(source);
      expect(result.changed).toBe(false);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].kind).toBe("ambiguous-trailing-binding");
      expect(result.diagnostics[0].message).toContain("user");
      expect(result.code).toBe(source);
    });

    it("reports empty function blocks without modifying them", () => {
      const source = `noop = () => {}\n`;
      const result = migrateSource(source);
      expect(result.changed).toBe(false);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].kind).toBe("ambiguous-empty-block");
      expect(result.code).toBe(source);
    });

    it("reports statement-only blocks without return expressions", () => {
      const source = `mutateOnly = () => {
  mut x = 1
  x = 2
}
`;
      const result = migrateSource(source);
      expect(result.changed).toBe(false);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].kind).toBe("ambiguous-missing-return");
      expect(result.code).toBe(source);
    });
  });

  describe("Migration Options and Safety Policies", () => {
    it("dry-run computes proposed changes without altering code", () => {
      const legacy = `inc = (x: Number) =>\n  x + 1\n`;
      const result = migrateSource(legacy, { dryRun: true });
      expect(result.changed).toBe(true);
      expect(result.changes).toHaveLength(1);
      expect(result.code).toBe(legacy); // Unmodified!
    });

    it("allowPartial: true applies safe changes while reporting ambiguous constructs", () => {
      const mixed = `// Safe function
inc = (x: Number) =>
  x + 1

// Ambiguous effect
run = () =>
  effect {
    user <- fetchUser("1")
    Console.log("done")
  }
`;
      const result = migrateSource(mixed, { allowPartial: true });
      expect(result.changed).toBe(true);
      expect(result.diagnostics.some((d) => d.kind === "ambiguous-effect-return")).toBe(true);
      // 'inc' got migrated safely, 'run' effect block remained unmodified
      expect(result.code).toContain("=> x + 1");
      expect(result.code).toContain("Console.log(\"done\")");
      expect(result.code).not.toContain("=> Console.log");
    });

    it("allowPartial: false rejects modifying file if any ambiguous construct exists", () => {
      const mixed = `inc = (x: Number) =>
  x + 1

run = () =>
  effect {
    user <- fetchUser("1")
    Console.log("done")
  }
`;
      const result = migrateSource(mixed, { allowPartial: false });
      expect(result.changed).toBe(false);
      expect(result.success).toBe(false);
      expect(result.code).toBe(mixed);
    });
  });

  describe("File-Based Migration and Sample Source Files", () => {
    let tmpDir: string;

    it("migrates sample fixture legacy-functions.fun", async () => {
      const fixturePath = path.resolve("tests/fixtures/migrate/legacy-functions.fun");
      const result = await migrateFile(fixturePath, { write: false });
      expect(result.changed).toBe(true);
      expect(result.changes.length).toBeGreaterThanOrEqual(3);
      expect(() => parseStrict(result.code)).not.toThrow();
    });

    it("reports ambiguous constructs in fixture ambiguous-effect.fun", async () => {
      const fixturePath = path.resolve("tests/fixtures/migrate/ambiguous-effect.fun");
      const result = await migrateFile(fixturePath, { write: false });
      expect(result.changed).toBe(false);
      expect(result.diagnostics.some((d) => d.kind === "ambiguous-effect-return")).toBe(true);
    });

    it("reports ambiguous constructs in fixture ambiguous-binding.fun", async () => {
      const fixturePath = path.resolve("tests/fixtures/migrate/ambiguous-binding.fun");
      const result = await migrateFile(fixturePath, { write: false });
      expect(result.changed).toBe(false);
      expect(result.diagnostics.some((d) => d.kind === "ambiguous-trailing-binding")).toBe(true);
    });

    it("leaves compliant.fun completely untouched", async () => {
      const fixturePath = path.resolve("tests/fixtures/migrate/compliant.fun");
      const result = await migrateFile(fixturePath, { write: false });
      expect(result.changed).toBe(false);
      expect(result.changes).toHaveLength(0);
      expect(result.diagnostics).toHaveLength(0);
    });

    it("batch migrates multiple files using migrateFiles", async () => {
      const filePaths = [
        path.resolve("tests/fixtures/migrate/legacy-functions.fun"),
        path.resolve("tests/fixtures/migrate/compliant.fun"),
      ];
      const results = await migrateFiles(filePaths, { write: false });
      expect(results.size).toBe(2);
      expect(results.get(filePaths[0])?.changed).toBe(true);
      expect(results.get(filePaths[1])?.changed).toBe(false);
    });

    it("writes back to disk when write: true", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-test-"));
      try {
        const filePath = path.join(tempDir, "sample.fun");
        await fs.writeFile(filePath, `f = (x: Number) =>\n  x * 2\n`, "utf-8");

        const result = await migrateFile(filePath, { write: true });
        expect(result.changed).toBe(true);

        const onDisk = await fs.readFile(filePath, "utf-8");
        expect(onDisk).toBe(`f = (x: Number) =>\n  => x * 2\n`);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("Migration Report Formatting", () => {
    it("formats a human-readable report", () => {
      const result = migrateSource(`f = (x: Number) =>\n  x + 1\n`);
      const report = formatMigrationReport(result);
      expect(report).toContain("Applied 1 safe transformation(s):");
      expect(report).toContain("Add explicit '=>' return");
    });

    it("formats diagnostic warnings in the report", () => {
      const result = migrateSource(`run = () => effect { Console.log("done") }`);
      const report = formatMigrationReport(result);
      expect(report).toContain("Reported");
      expect(report).toContain("[WARNING]");
      expect(report).toContain("ambiguous-effect-return");
    });
  });
});
