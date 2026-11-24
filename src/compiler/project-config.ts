import * as fs from "node:fs";
import * as path from "node:path";
import { toErrorMessage } from "../errors.js";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";

export interface FunScriptProjectConfig {
  format?: { indentSize?: number; lineWidth?: number };
  noTs?: boolean | string[];
  noGlobalThis?: boolean | string[];
  noOptional?: boolean | string[];
  barePipelines?: boolean | string[];
  effectOnly?: string[];
  modularEffectImports?: boolean;
}

/** Read a literal FunScript record without compiling or executing project code. */
export function loadProjectConfig(cwd: string): FunScriptProjectConfig {
  const file = path.resolve(cwd, "funscript.config.fun");
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error: unknown) {
    if ((error as { code?: string })?.code === "ENOENT") return {};
    throw error;
  }
  try {
    const ast = new Parser(
      new Lexer(source, file).tokenize(),
      file,
      source,
    ).parse();
    if (ast.body.length !== 1 || ast.body[0].kind !== "ExportDeclaration")
      throw new Error("expected only 'export config = { ... }'");
    const binding = ast.body[0].declaration;
    if (
      binding.kind !== "BindingDeclaration" ||
      binding.id.kind !== "Identifier" ||
      binding.id.name !== "config" ||
      binding.init.kind !== "RecordExpression"
    ) {
      throw new Error("expected 'export config = { ... }'");
    }
    const config: FunScriptProjectConfig = {};
    const seen = new Set<string>();
    for (const entry of binding.init.entries) {
      if (
        entry.kind !== "FieldEntry" ||
        ![
          "noTs",
          "noGlobalThis",
          "noOptional",
          "barePipelines",
          "effectOnly",
          "format",
          "modularEffectImports",
        ].includes(entry.key.name)
      ) {
        throw new Error(
          "config accepts only 'noTs', 'noGlobalThis', 'noOptional', 'barePipelines', 'effectOnly', 'format', and 'modularEffectImports'",
        );
      }
      const name = entry.key.name;
      if (seen.has(name)) throw new Error(`duplicate config field '${name}'`);
      seen.add(name);
      if (name === "format") {
        if (entry.value.kind !== "RecordExpression")
          throw new Error("format must be a literal record");
        const format: NonNullable<FunScriptProjectConfig["format"]> = {};
        for (const field of entry.value.entries) {
          if (
            field.kind !== "FieldEntry" ||
            !["indentSize", "lineWidth"].includes(field.key.name)
          )
            throw new Error("format accepts only indentSize and lineWidth");
          const key = field.key.name as "indentSize" | "lineWidth";
          if (format[key] !== undefined)
            throw new Error(`duplicate format field '${key}'`);
          if (
            field.value.kind !== "NumberLiteral" ||
            !Number.isInteger(field.value.value) ||
            field.value.value < (key === "indentSize" ? 1 : 40) ||
            field.value.value > (key === "indentSize" ? 8 : 240)
          )
            throw new Error(
              `${key} must be an integer between ${key === "indentSize" ? "1 and 8" : "40 and 240"}`,
            );
          format[key] = field.value.value;
        }
        config.format = format;
      } else if (entry.value.kind === "ArrayExpression") {
        const directories: string[] = [];
        for (const item of entry.value.elements) {
          if (
            !item ||
            item.kind !== "StringLiteral" ||
            item.parts.some((part) => part.kind !== "StringRawPart")
          )
            throw new Error(`${name} must contain literal directory paths`);
          const value = item.parts
            .map((part) => (part.kind === "StringRawPart" ? part.value : ""))
            .join("");
          if (
            !value ||
            path.isAbsolute(value) ||
            value.split(/[\\/]/).includes("..")
          )
            throw new Error(`${name} paths must be within the project root`);
          directories.push(value);
        }
        if (name === "effectOnly") config.effectOnly = directories;
        else
          config[
            name as "noTs" | "noGlobalThis" | "noOptional" | "barePipelines"
          ] = directories;
      } else {
        if (name === "effectOnly" || entry.value.kind !== "BooleanLiteral")
          throw new Error(
            `${name} must be ${name === "effectOnly" ? "an array of paths" : "a boolean or an array of paths"}`,
          );
        config[
          name as
            | "noTs"
            | "noGlobalThis"
            | "noOptional"
            | "barePipelines"
            | "modularEffectImports"
        ] = entry.value.value;
      }
    }
    return config;
  } catch (error: unknown) {
    throw new Error(
      `${file}: invalid FunScript config: ${toErrorMessage(error)}`,
    );
  }
}

/** Find and load the nearest project policy for a source file. */
export function loadProjectConfigForFile(filename: string): {
  root: string;
  config: FunScriptProjectConfig;
} {
  let dir = path.dirname(path.resolve(filename));
  for (;;) {
    if (fs.existsSync(path.join(dir, "funscript.config.fun")))
      return { root: dir, config: loadProjectConfig(dir) };
    const parent = path.dirname(dir);
    if (parent === dir) return { root: process.cwd(), config: {} };
    dir = parent;
  }
}

/** Whether a policy applies globally or to a directory containing the source. */
export function isPathPolicyEnabled(
  value: boolean | readonly string[] | undefined,
  cwd: string,
  filename: string,
): boolean {
  if (typeof value === "boolean") return value;
  const file = path.resolve(cwd, filename);
  return (value ?? []).some((directory) => {
    const relative = path.relative(path.resolve(cwd, directory), file);
    return (
      relative !== "" &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative)
    );
  });
}

export function isEffectOnlyFile(
  config: FunScriptProjectConfig,
  cwd: string,
  filename: string,
): boolean {
  return isPathPolicyEnabled(config.effectOnly, cwd, filename);
}

/** Find the nearest project config for an editor document. */
export function loadFormatConfigForFile(
  filename: string,
): FunScriptProjectConfig["format"] {
  let dir = path.dirname(path.resolve(filename));
  for (;;) {
    if (fs.existsSync(path.join(dir, "funscript.config.fun")))
      return loadProjectConfig(dir).format;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
