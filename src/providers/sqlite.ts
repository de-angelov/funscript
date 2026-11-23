import Database from "better-sqlite3";

type Table = { name: string; strict: number; wr: number; type: string };
type Column = {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  hidden: number;
};

/** Inspect a local SQLite table using a read-only connection. */
export function sqliteTableSchema(filename: string, tableName: string): string {
  if (!tableName) throw new Error("SQLite provider requires a table name");
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const table = db
      .prepare(
        "SELECT name, strict, wr, type FROM pragma_table_list WHERE schema = 'main' AND name = ?",
      )
      .get(tableName) as Table | undefined;
    if (!table || (table.type !== "table" && table.type !== "view"))
      throw new Error(`SQLite table or view '${tableName}' does not exist`);
    const columns = db
      .prepare(
        'SELECT name, type, "notnull", pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid',
      )
      .all(tableName) as Column[];
    const visible = columns.filter((column) => column.hidden !== 1);
    if (!visible.length)
      throw new Error(`SQLite table '${tableName}' has no visible columns`);
    const anyValue =
      "Schema.Union([Schema.Number, Schema.String, Schema.Uint8Array])";
    const fields = visible.map((column) => {
      let expression = anyValue;
      if (table.strict) {
        switch (column.type.toUpperCase()) {
          case "INTEGER":
          case "INT":
          case "REAL":
            expression = "Schema.Number";
            break;
          case "TEXT":
            expression = "Schema.String";
            break;
          case "BLOB":
            expression = "Schema.Uint8Array";
            break;
        }
      }
      // Primary keys in ordinary rowid tables can contain NULL unless explicitly NOT NULL.
      if (!column.notnull && !(column.pk && (table.strict || table.wr)))
        expression = `Schema.NullOr(${expression})`;
      return `[${JSON.stringify(column.name)}]: ${expression}`;
    });
    return `Schema.Struct({ ${fields.join(", ")} })`;
  } finally {
    db.close();
  }
}
