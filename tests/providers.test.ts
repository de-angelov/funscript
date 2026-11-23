import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { TypeView } from "../src/plugins/type-view.js";
import { parseCsv } from "../src/interop/csv.js";
import Database from "better-sqlite3";
import { jsonSchema, jsonSample } from "../src/providers/json.js";
import { generateSqliteDrizzleSchema } from "../src/providers/drizzle.js";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { compileString } from "../src/compiler.js";
import { format } from "../src/formatter/index.js";
import { incrementalDependencyKeys } from "../src/compiler/incremental-dependencies.js";
import { validateFunScript } from "../src/lsp/validation.js";

describe("CSV schema provider", () => {
  it("generates row schemas and invalidates when the CSV changes", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".provider-test-"));
    try {
      const file = path.join(dir, "main.fun"),
        csv = path.join(dir, "rows.csv");
      const source = 'export schema Row = from csv<"./rows.csv">\n';
      fs.writeFileSync(csv, 'id,"full name"\n1,"A, B"\n');
      const result = await Effect.runPromise(compileString(source, file));
      expect(result.typescript).toContain('["full name"]: Schema.String');
      expect(result.providerDependencies).toEqual([csv]);
      expect(format(source)).toBe(source);
      expect(validateFunScript(source, file)).toEqual([]);
      const sources = new Map([[file, source]]);
      const before = incrementalDependencyKeys(sources, dir).get(file);
      fs.writeFileSync(csv, "id,email\n1,a@example.com\n");
      expect(incrementalDependencyKeys(sources, dir).get(file)).not.toBe(
        before,
      );
      expect(
        (await Effect.runPromise(compileString(source, file))).typescript,
      ).toContain('["email"]: Schema.String');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("reports invalid CSV at the provider declaration", () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".provider-test-"));
    try {
      fs.writeFileSync(path.join(dir, "rows.csv"), "id,id\n1,2\n");
      const diagnostics = validateFunScript(
        'schema Row = from csv<"./rows.csv">',
        path.join(dir, "main.fun"),
      );
      expect(diagnostics[0].message).toContain("column names must be unique");
      expect(diagnostics[0].range.start.character).toBe(13);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("validates runtime rows and checks generated types with TypeScript 7.1", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".provider-test-"));
    try {
      const file = path.join(dir, "main.fun");
      fs.writeFileSync(path.join(dir, "rows.csv"), "id,name\n1,Ada\n");
      const { typescript } = await Effect.runPromise(
        compileString('export schema Row = from csv<"./rows.csv">', file),
      );
      const cjs = ts.transpileModule(typescript, {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
      }).outputText;
      const module = { exports: {} as any };
      new Function("exports", "require", "module", cjs)(
        module.exports,
        createRequire(import.meta.url),
        module,
      );
      expect(module.exports.RowFromUnknown({ id: "1", name: "Ada" })).toEqual({
        id: "1",
        name: "Ada",
      });
      expect(
        parseCsv('id,name\n1,"Ada, Lovelace"\n').map(
          module.exports.RowFromUnknown,
        ),
      ).toEqual([{ id: "1", name: "Ada, Lovelace" }]);
      expect(() =>
        module.exports.RowFromUnknown({ id: 1, name: "Ada" }),
      ).toThrow();
      const generated = path.join(dir, "generated.ts");
      fs.writeFileSync(
        generated,
        `${typescript}\nconst row: Row = { id: "1", name: "Ada" };\n`,
      );
      execFileSync(
        process.execPath,
        [
          path.resolve("node_modules/typescript71/bin/tsc"),
          "--ignoreConfig",
          "--noEmit",
          "--skipLibCheck",
          "--target",
          "es2022",
          "--module",
          "nodenext",
          generated,
        ],
        { stdio: "pipe" },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("refreshes the type view when a provider dependency changes", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".provider-test-"));
    try {
      fs.mkdirSync(path.join(dir, "app"));
      const csv = path.join(dir, "app", "rows.csv");
      fs.writeFileSync(
        path.join(dir, "app", "main.fun"),
        'export schema Row = from csv<"./rows.csv">\n',
      );
      fs.writeFileSync(csv, "id\n1\n");
      const view = new TypeView(dir);
      await view.generate();
      const output = path.join(dir, ".funscript", "types", "app", "main.ts");
      expect(fs.readFileSync(output, "utf8")).toContain(
        '["id"]: Schema.String',
      );
      fs.writeFileSync(csv, "name\nAda\n");
      await view.refreshDependency(csv);
      expect(fs.readFileSync(output, "utf8")).toContain(
        '["name"]: Schema.String',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Drizzle SQLite schema generation", () => {
  it("generates a typed table and executes a Drizzle select", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".provider-test-"));
    const database = path.join(dir, "data.db");
    const db = new Database(database);
    try {
      db.exec(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL) STRICT; INSERT INTO users VALUES (1, 'Ada', 2.5)",
      );
      const code = generateSqliteDrizzleSchema(database, "users");
      const cliOutput = execFileSync(
        process.execPath,
        [
          path.resolve("dist/cli/index.js"),
          "drizzle-schema",
          database,
          "users",
        ],
        { encoding: "utf8" },
      );
      expect(cliOutput).toBe(code);
      const generated = path.join(dir, "schema.ts");
      fs.writeFileSync(generated, code);
      fs.writeFileSync(
        path.join(dir, "db.ts"),
        'import Database from "better-sqlite3";\nimport { drizzle } from "drizzle-orm/better-sqlite3";\nexport { table } from "./schema.js";\nexport const db = drizzle(new Database(":memory:"));\n',
      );
      const funSource =
        'import { db, table } from "./db.js"\nexport rows = db.select().from(table).all()\n';
      const compiled = await Effect.runPromise(
        compileString(funSource, path.join(dir, "query.fun")),
      );
      const funOutput = path.join(dir, "query-fun.ts");
      fs.writeFileSync(funOutput, compiled.typescript);
      const query = path.join(dir, "query.ts");
      fs.writeFileSync(
        query,
        'import { table } from "./schema.js";\nimport { eq } from "drizzle-orm";\neq(table.name, "Ada");\n// @ts-expect-error unknown columns must be rejected\ntable.missing;\n// @ts-expect-error numeric column requires a number\neq(table.id, "wrong");\n',
      );
      execFileSync(process.execPath, [
        path.resolve("node_modules/typescript71/bin/tsc"),
        "--ignoreConfig",
        "--noEmit",
        "--skipLibCheck",
        "--target",
        "es2022",
        "--module",
        "nodenext",
        query,
        funOutput,
      ]);
      const cjs = ts.transpileModule(code, {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
      }).outputText;
      const module = { exports: {} as any };
      new Function("exports", "require", "module", cjs)(
        module.exports,
        createRequire(import.meta.url),
        module,
      );
      const table = module.exports.table;
      const rows = drizzle(db)
        .select()
        .from(table)
        .where(eq(table.name, "Ada"))
        .all();
      expect(rows).toEqual([{ id: 1, name: "Ada", score: 2.5 }]);
      db.exec("CREATE TABLE flexible (name TEXT)");
      expect(() => generateSqliteDrizzleSchema(database, "flexible")).toThrow(
        "must be STRICT",
      );
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("JSON Schema and SQLite providers", () => {
  it("generates nested schemas and rejects unsupported JSON Schema keywords", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".provider-test-"));
    try {
      const file = path.join(dir, "main.fun");
      const spec = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "integer" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["name"],
      };
      fs.writeFileSync(path.join(dir, "customer.json"), JSON.stringify(spec));
      const source =
        'export schema Customer = from jsonSchema<"./customer.json">\n';
      const result = await Effect.runPromise(compileString(source, file));
      expect(result.typescript).toContain(
        '["age"]: Schema.optionalKey(Schema.Int)',
      );
      expect(result.typescript).toContain(
        '["tags"]: Schema.optionalKey(Schema.Array(Schema.String))',
      );
      const cjs = ts.transpileModule(result.typescript, {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
      }).outputText;
      const module = { exports: {} as any };
      new Function("exports", "require", "module", cjs)(
        module.exports,
        createRequire(import.meta.url),
        module,
      );
      expect(module.exports.CustomerFromUnknown({ name: "Ada" })).toEqual({
        name: "Ada",
      });
      expect(() =>
        module.exports.CustomerFromUnknown({ name: "Ada", age: 1.5 }),
      ).toThrow();
      expect(() => jsonSchema('{"type":"string","pattern":"^a"}')).toThrow(
        "unsupported JSON Schema keyword 'pattern'",
      );
      fs.writeFileSync(
        path.join(dir, "sample.json"),
        '{"items":[1,null,2],"name":"Ada"}',
      );
      const sample = await Effect.runPromise(
        compileString('schema Sample = from json<"./sample.json">', file),
      );
      expect(sample.typescript).toContain(
        "Schema.Array(Schema.Union([Schema.Finite, Schema.Null]))",
      );
      expect(() => jsonSample('{"items":[]}')).toThrow("empty array");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("inspects SQLite tables read-only and observes WAL schema changes", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".provider-test-"));
    let db: Database.Database | undefined;
    try {
      const file = path.join(dir, "main.fun"),
        database = path.join(dir, "data.db");
      db = new Database(database);
      db.pragma("journal_mode = WAL");
      db.exec(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL, payload BLOB) STRICT; CREATE TABLE loose (value TEXT)",
      );
      const source = 'export schema User = from sqlite<"./data.db", "users">\n';
      expect(format(source)).toBe(source);
      const result = await Effect.runPromise(compileString(source, file));
      expect(result.typescript).toContain('["id"]: Schema.Number');
      expect(result.typescript).toContain('["name"]: Schema.String');
      expect(result.typescript).toContain(
        '["score"]: Schema.NullOr(Schema.Number)',
      );
      db.prepare(
        "INSERT INTO users (id, name, score, payload) VALUES (?, ?, ?, ?)",
      ).run(1, "Ada", 2.5, Buffer.from([42]));
      const cjs = ts.transpileModule(result.typescript, {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
      }).outputText;
      const module = { exports: {} as any };
      new Function("exports", "require", "module", cjs)(
        module.exports,
        createRequire(import.meta.url),
        module,
      );
      expect(
        module.exports.UserFromUnknown(db.prepare("SELECT * FROM users").get()),
      ).toMatchObject({ id: 1, name: "Ada", score: 2.5 });
      expect(result.providerDependencies).toContain(`${database}-wal`);
      const sources = new Map([[file, source]]);
      const before = incrementalDependencyKeys(sources, dir).get(file);
      db.exec("ALTER TABLE users ADD COLUMN email TEXT");
      expect(incrementalDependencyKeys(sources, dir).get(file)).not.toBe(
        before,
      );
      expect(
        (await Effect.runPromise(compileString(source, file))).typescript,
      ).toContain('["email"]: Schema.NullOr(Schema.String)');
      const loose = await Effect.runPromise(
        compileString('schema Loose = from sqlite<"./data.db", "loose">', file),
      );
      expect(loose.typescript).toContain(
        "Schema.Union([Schema.Number, Schema.String, Schema.Uint8Array])",
      );
      await expect(
        Effect.runPromise(
          compileString(
            'schema Missing = from sqlite<"./data.db", "missing">',
            file,
          ),
        ),
      ).rejects.toThrow("does not exist");
    } finally {
      db?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
