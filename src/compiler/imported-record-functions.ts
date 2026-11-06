import * as fs from "node:fs";
import * as path from "node:path";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import type { BindingDeclaration, FunctionExpression, ImportDeclaration, Program, RecordTypeNode, TypeNode } from "../ast/types.js";
import { isRecordContract, recordContractType } from "./record-contracts.js";

/** Resolve only unambiguous FunScript functions; unknown targets remain restricted. */
export function resolveImportedRecordFunctions(ast: Program, filename: string, virtualSources?: ReadonlyMap<string, string>, importedContracts?: Map<string, RecordTypeNode>): Map<string, ReadonlySet<number>> {
  const result = new Map<string, ReadonlySet<number>>();
  const programs = new Map<string, Program | undefined>();
  const read = (file: string): string | undefined => {
    const normalized = path.resolve(file);
    if (virtualSources?.has(normalized)) return virtualSources.get(normalized);
    try { return fs.readFileSync(normalized, "utf8"); } catch { return undefined; }
  };
  const exists = (file: string): boolean => virtualSources?.has(path.resolve(file)) === true || fs.existsSync(file);
  const targetOf = (item: ImportDeclaration, from: string): string | undefined => {
    if (item.isSideEffect || item.source.parts.length !== 1 || item.source.parts[0].kind !== "StringRawPart") return undefined;
    const source = item.source.parts[0].value;
    if (!source.startsWith(".")) return undefined;
    const requested = path.resolve(path.dirname(from), source);
    if (/\.funx?$/.test(requested)) return exists(requested) ? requested : undefined;
    if (!requested.endsWith(".js")) return undefined;
    const base = requested.slice(0, -3);
    if ([requested, `${base}.ts`, `${base}.tsx`, `${base}.jsx`, `${base}.d.ts`, `${base}.d.mts`, `${base}.d.cts`].some(exists)) return undefined;
    const candidates = [`${base}.fun`, `${base}.funx`].filter(exists);
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  const programAt = (file: string): Program | undefined => {
    if (programs.has(file)) return programs.get(file);
    const source = read(file);
    let program: Program | undefined;
    if (source !== undefined) {
      try { program = new Parser(new Lexer(source, file).tokenize(), file, source).parse(); } catch { /* Reject invalid dependencies. */ }
    }
    programs.set(file, program);
    return program;
  };
  const hasOptional = (node: TypeNode | undefined): boolean => node?.kind === "RecordTypeNode" &&
    node.fields.some((field) => Boolean(field.optional || field.defaultValue) || hasOptional(field.typeAnnotation));
  const localContract = (program: Program, file: string, name: string): RecordTypeNode | undefined => {
    for (const item of program.body) {
      const declaration = item.kind === "ExportDeclaration" ? item.declaration : item;
      if (declaration.kind === "SchemaDeclaration" && declaration.id.name === name && declaration.body.kind === "RecordSchema" && isRecordContract(declaration.body)) return recordContractType(declaration.body);
    }
    for (const item of program.body) {
      if (item.kind !== "ImportDeclaration") continue;
      const spec = item.specifiers.find((part) => part.local.name === name);
      if (!spec) continue;
      const target = targetOf(item, file);
      const imported = target ? programAt(target) : undefined;
      const entry = imported?.body.find((part) => part.kind === "ExportDeclaration" && part.declaration.kind === "SchemaDeclaration" && part.declaration.id.name === spec.imported.name);
      if (entry?.kind === "ExportDeclaration" && entry.declaration.kind === "SchemaDeclaration" && entry.declaration.body.kind === "RecordSchema" && isRecordContract(entry.declaration.body)) return recordContractType(entry.declaration.body);
    }
    return undefined;
  };
  const positionsOf = (fn: FunctionExpression, program: Program, file: string): ReadonlySet<number> | undefined => {
    const positions = new Set<number>();
    fn.params.forEach((param, index) => {
      const type = param.typeAnnotation;
      if (hasOptional(type?.kind === "TypeReferenceNode" ? localContract(program, file, type.name.name) ?? type : type)) positions.add(index);
    });
    return positions.size ? positions : undefined;
  };

  const resolveLocal = (program: Program, file: string, name: string, seen: Set<string>): ReadonlySet<number> | undefined => {
    const key = `${file}\0local\0${name}`;
    if (seen.has(key)) return undefined;
    const next = new Set(seen).add(key);
    const bindings: BindingDeclaration[] = [];
    for (const item of program.body) {
      const declaration = item.kind === "ExportDeclaration" ? item.declaration : item;
      if (declaration.kind === "BindingDeclaration" && declaration.id.name === name) bindings.push(declaration);
    }
    if (bindings.length > 1) return undefined;
    const binding = bindings[0];
    if (binding) {
      if (binding.isMut || binding.isJs) return undefined;
      if (binding.init.kind === "FunctionExpression") return positionsOf(binding.init, program, file);
      return binding.init.kind === "Identifier" ? resolveLocal(program, file, binding.init.name, next) : undefined;
    }
    for (const item of program.body) {
      if (item.kind !== "ImportDeclaration" || item.isTypeOnly) continue;
      const spec = item.specifiers.find((part) => !part.isTypeOnly && part.local.name === name);
      const importedName = spec?.imported.name ?? (item.defaultBinding?.name === name ? "default" : undefined);
      if (!importedName) continue;
      const target = targetOf(item, file);
      return target ? resolveExport(target, importedName, next) : undefined;
    }
    return undefined;
  };
  const resolveExport = (file: string, name: string, seen: Set<string>): ReadonlySet<number> | undefined => {
    const key = `${file}\0export\0${name}`;
    if (seen.has(key)) return undefined;
    const program = programAt(file);
    if (!program) return undefined;
    const next = new Set(seen).add(key);
    if (name === "default") {
      const entry = program.body.find((item) => item.kind === "ExportDefaultDeclaration");
      if (entry?.kind !== "ExportDefaultDeclaration") return undefined;
      if (entry.expression.kind === "FunctionExpression") return positionsOf(entry.expression, program, file);
      return entry.expression.kind === "Identifier" ? resolveLocal(program, file, entry.expression.name, next) : undefined;
    }
    const entry = program.body.find((item) => item.kind === "ExportDeclaration" && item.declaration.kind === "BindingDeclaration" && item.declaration.id.name === name);
    return entry ? resolveLocal(program, file, name, next) : undefined;
  };

  for (const item of ast.body) {
    if (item.kind !== "ImportDeclaration") continue;
    const target = targetOf(item, filename);
    if (!target) continue;
    for (const spec of item.specifiers) {
      const imported = programAt(target);
      const entry = imported?.body.find((part) => part.kind === "ExportDeclaration" && part.declaration.kind === "SchemaDeclaration" && part.declaration.id.name === spec.imported.name);
      if (entry?.kind === "ExportDeclaration" && entry.declaration.kind === "SchemaDeclaration" && entry.declaration.body.kind === "RecordSchema" && isRecordContract(entry.declaration.body)) importedContracts?.set(spec.local.name, recordContractType(entry.declaration.body));
      if (item.isTypeOnly || spec.isTypeOnly) continue;
      const positions = resolveExport(target, spec.imported.name, new Set());
      if (positions) result.set(spec.local.name, positions);
    }
    if (!item.isTypeOnly && item.defaultBinding) {
      const positions = resolveExport(target, "default", new Set());
      if (positions) result.set(item.defaultBinding.name, positions);
    }
    if (!item.isTypeOnly && item.namespaceBinding) {
      const program = programAt(target);
      if (!program) continue;
      for (const entry of program.body) {
        const name = entry.kind === "ExportDeclaration" && entry.declaration.kind === "BindingDeclaration" ? entry.declaration.id.name : entry.kind === "ExportDefaultDeclaration" ? "default" : undefined;
        if (!name) continue;
        const positions = resolveExport(target, name, new Set());
        if (positions) result.set(`${item.namespaceBinding.name}.${name}`, positions);
      }
    }
  }
  return result;
}
