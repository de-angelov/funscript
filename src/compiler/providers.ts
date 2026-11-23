import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Program, ProviderSchema } from "../ast/types.js";
import { FunScriptError } from "../errors.js";

import { csvSchema } from "../providers/csv.js";
import { jsonSchema, jsonSample } from "../providers/json.js";
import { sqliteTableSchema } from "../providers/sqlite.js";

export function providerDependencies(ast: Program, filename: string): string[] {
  const source = filename.startsWith("file:")
    ? fileURLToPath(filename)
    : filename;
  return ast.body.flatMap((item) => {
    const decl = item.kind === "ExportDeclaration" ? item.declaration : item;
    if (
      decl.kind !== "SchemaDeclaration" ||
      decl.body.kind !== "ProviderSchema"
    )
      return [];
    const file = path.resolve(path.dirname(source), decl.body.path);
    return decl.body.provider === "sqlite"
      ? [file, `${file}-wal`, `${file}-journal`]
      : [file];
  });
}

export function resolveProviderSchemas(
  ast: Program,
  filename: string,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const item of ast.body) {
    const decl = item.kind === "ExportDeclaration" ? item.declaration : item;
    if (
      decl.kind !== "SchemaDeclaration" ||
      decl.body.kind !== "ProviderSchema"
    )
      continue;
    const body: ProviderSchema = decl.body;
    try {
      if (!body.path.startsWith("./") && !body.path.startsWith("../"))
        throw new Error("Provider path must be relative to the source file");
      if (decl.typeParams?.length)
        throw new Error("Provider schemas cannot have type parameters");
      const source = filename.startsWith("file:")
        ? fileURLToPath(filename)
        : filename;
      const file = path.resolve(path.dirname(source), body.path);
      let expression: string;
      switch (body.provider) {
        case "csv":
        case "json":
        case "jsonSchema":
          if (body.selector !== undefined)
            throw new Error(`${body.provider} does not accept a selector`);
          {
            const source = fs.readFileSync(file, "utf8");
            expression =
              body.provider === "csv"
                ? csvSchema(source)
                : body.provider === "json"
                  ? jsonSample(source)
                  : jsonSchema(source);
          }
          break;
        case "sqlite":
          if (body.selector === undefined)
            throw new Error(
              "SQLite provider requires a table name as its second argument",
            );
          expression = sqliteTableSchema(file, body.selector);
          break;
        default:
          throw new Error(`Unknown type provider '${body.provider}'`);
      }
      result.set(decl.id.name, expression);
    } catch (error) {
      throw new FunScriptError(
        `Type provider '${body.provider}': ${error instanceof Error ? error.message : String(error)}`,
        body.span,
      );
    }
  }
  return result;
}
