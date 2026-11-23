/** CSV fields are strings; the provider never guesses a conversion from samples. */
export function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  input = input.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else field += c;
    } else if (c === '"' && field === "" && !closed) quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
      closed = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      closed = false;
    } else if (closed || c === '"') throw new Error("Invalid CSV quoting");
    else field += c;
  }
  if (quoted) throw new Error("Unterminated quoted CSV field");
  if (row.length || field || closed) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Parse CSV into records without coercing textual fields. */
export function parseCsv(input: string): Record<string, string>[] {
  const rows = parseCsvRows(input);
  const headers = rows[0];
  if (!headers?.length || headers.some((header) => !header.trim()))
    throw new Error("CSV requires nonempty column names");
  if (new Set(headers).size !== headers.length)
    throw new Error("CSV column names must be unique");
  return rows.slice(1).map((row, i) => {
    if (row.length !== headers.length)
      throw new Error(
        `CSV row ${i + 2} has ${row.length} fields; expected ${headers.length}`,
      );
    return Object.fromEntries(
      headers.map((header, index) => [header, row[index]]),
    );
  });
}
