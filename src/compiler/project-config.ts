import * as fs from "node:fs";
import * as path from "node:path";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";

export interface FunScriptProjectConfig {
  noTs?: boolean | string[];
  noGlobalThis?: boolean | string[];
  noOptional?: boolean | string[];
  barePipelines?: boolean | string[];
  effectOnly?: string[];
}

/** Read a literal FunScript record without compiling or executing project code. */
export function loadProjectConfig(cwd: string): FunScriptProjectConfig {
  const file = path.resolve(cwd, "funscript.config.fun");
  let source: string;
  try { source = fs.readFileSync(file, "utf8"); }
  catch (error: any) { if (error?.code === "ENOENT") return {}; throw error; }
  try {
    const ast = new Parser(new Lexer(source, file).tokenize(), file, source).parse();
    if (ast.body.length !== 1 || ast.body[0].kind !== "ExportDeclaration") throw new Error("expected only 'export config = { ... }'");
    const binding = ast.body[0].declaration;
    if (binding.kind !== "BindingDeclaration" || binding.id.kind !== "Identifier" || binding.id.name !== "config" || binding.init.kind !== "RecordExpression") {
      throw new Error("expected 'export config = { ... }'");
    }
    const config: FunScriptProjectConfig = {};
    const seen = new Set<string>();
    for (const entry of binding.init.entries) {
      if (entry.kind !== "FieldEntry" || !["noTs", "noGlobalThis", "noOptional", "barePipelines", "effectOnly"].includes(entry.key.name)) {
        throw new Error("config accepts only 'noTs', 'noGlobalThis', 'noOptional', 'barePipelines', and 'effectOnly'");
      }
      const name = entry.key.name;
      if (seen.has(name)) throw new Error(`duplicate config field '${name}'`);
      seen.add(name);
      if (entry.value.kind === "ArrayExpression") {
        const directories: string[] = [];
        for (const item of entry.value.elements) {
          if (!item || item.kind !== "StringLiteral" || item.parts.some(part => part.kind !== "StringRawPart")) throw new Error(`${name} must contain literal directory paths`);
          const value = item.parts.map(part => part.kind === "StringRawPart" ? part.value : "").join("");
          if (!value || path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) throw new Error(`${name} paths must be within the project root`);
          directories.push(value);
        }
        if (name === "effectOnly") config.effectOnly = directories;
        else config[name as "noTs" | "noGlobalThis" | "noOptional" | "barePipelines"] = directories;
      } else {
        if (name === "effectOnly" || entry.value.kind !== "BooleanLiteral") throw new Error(`${name} must be ${name === "effectOnly" ? "an array of paths" : "a boolean or an array of paths"}`);
        config[name as "noTs" | "noGlobalThis" | "noOptional" | "barePipelines"] = entry.value.value;
      }
    }
    return config;
  } catch (error: any) {
    throw new Error(`${file}: invalid FunScript config: ${error.message}`);
  }
}

/** Whether a policy applies globally or to a directory containing the source. */
export function isPathPolicyEnabled(value: boolean | readonly string[] | undefined, cwd: string, filename: string): boolean {
  if (typeof value === "boolean") return value;
  const file = path.resolve(cwd, filename);
  return (value ?? []).some(directory => {
    const relative = path.relative(path.resolve(cwd, directory), file);
    return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
  });
}

export function isEffectOnlyFile(config: FunScriptProjectConfig, cwd: string, filename: string): boolean {
  return isPathPolicyEnabled(config.effectOnly, cwd, filename);
}
