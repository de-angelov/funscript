import { parseCsv, parseCsvRows } from "../interop/csv.js";

/** Derive an Effect schema for a CSV record without coercing values. */
export function csvSchema(source: string): string {
  parseCsv(source);
  const headers = parseCsvRows(source)[0];
  return `Schema.Struct({ ${headers.map((header) => `[${JSON.stringify(header)}]: Schema.String`).join(", ")} })`;
}
