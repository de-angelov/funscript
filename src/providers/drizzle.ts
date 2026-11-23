import Database from "better-sqlite3";

type Table = { name: string; strict: number; type: string };
type Column = {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  hidden: number;
};

/** Generate a Drizzle table module for SELECT queries against a STRICT SQLite table. */
export function generateSqliteDrizzleSchema(
  filename: string,
  tableName: string,
): string {
  if (!tableName) throw new Error("A SQLite table name is required");
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const table = db
      .prepare(
        "SELECT name, strict, type FROM pragma_table_list WHERE schema = 'main' AND name = ?",
      )
      .get(tableName) as Table | undefined;
    if (!table || table.type !== "table")
      throw new Error(`SQLite table '${tableName}' does not exist`);
    if (!table.strict)
      throw new Error(
        `SQLite table '${tableName}' must be STRICT for typed Drizzle columns`,
      );
    const columns = db
      .prepare(
        'SELECT name, type, "notnull", pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid',
      )
      .all(tableName) as Column[];
    if (!columns.length)
      throw new Error(`SQLite table '${tableName}' has no columns`);
    const fields = columns.map((column) => {
      if (column.hidden)
        throw new Error(
          `SQLite column '${column.name}' is generated or hidden; it is not supported`,
        );
      const type = column.type.toUpperCase();
      const name = JSON.stringify(column.name);
      let builder: string;
      switch (type) {
        case "INT":
        case "INTEGER":
          builder = `integer(${name})`;
          break;
        case "REAL":
          builder = `real(${name})`;
          break;
        case "TEXT":
          builder = `text(${name})`;
          break;
        case "BLOB":
          builder = `blob(${name}, { mode: "buffer" })`;
          break;
        default:
          throw new Error(
            `SQLite column '${column.name}' uses unsupported type '${column.type}'`,
          );
      }
      if (column.notnull || column.pk) builder += ".notNull()";
      return `  [${name}]: ${builder},`;
    });
    return `// Generated from SQLite metadata. Re-run after changing the table.\n// Read queries are supported; this does not model defaults, keys, or constraints for writes.\nimport { sqliteTable, integer, real, text, blob } from "drizzle-orm/sqlite-core";\n\nexport const table = sqliteTable(${JSON.stringify(tableName)}, {\n${fields.join("\n")}\n});\n\nexport type Row = typeof table.$inferSelect;\n`;
  } finally {
    db.close();
  }
}
