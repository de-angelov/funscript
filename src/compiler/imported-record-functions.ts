import * as fs from "node:fs";
import * as path from "node:path";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import type {
  BindingDeclaration,
  FunctionExpression,
  ImportDeclaration,
  ExportFromDeclaration,
  Program,
  RecordTypeNode,
  TypeNode,
} from "../ast/types.js";
import { isRecordContract, recordContractType } from "./record-contracts.js";

/** Resolve only unambiguous FunScript functions; unknown targets remain restricted. */
export function resolveImportedRecordFunctions(
  ast: Program,
  filename: string,
  virtualSources?: ReadonlyMap<string, string>,
  importedContracts?: Map<string, RecordTypeNode>,
  importedIdentitySchemas?: Set<string>,
  importedGenericDataSchemas?: Map<string, number>,
  importedDataSchemas?: Set<string>,
): Map<string, ReadonlySet<number>> {
  const result = new Map<string, ReadonlySet<number>>();
  const programs = new Map<string, Program | undefined>();
  const read = (file: string): string | undefined => {
    const normalized = path.resolve(file);
    if (virtualSources?.has(normalized)) return virtualSources.get(normalized);
    try {
      return fs.readFileSync(normalized, "utf8");
    } catch {
      return undefined;
    }
  };
  const exists = (file: string): boolean =>
    virtualSources?.has(path.resolve(file)) === true || fs.existsSync(file);
  const targetOf = (
    item: ImportDeclaration | ExportFromDeclaration,
    from: string,
  ): string | undefined => {
    if (
      (item.kind === "ImportDeclaration" && item.isSideEffect) ||
      item.source.parts.length !== 1 ||
      item.source.parts[0].kind !== "StringRawPart"
    )
      return undefined;
    const source = item.source.parts[0].value;
    if (!source.startsWith(".")) return undefined;
    const requested = path.resolve(path.dirname(from), source);
    if (/\.funx?$/.test(requested))
      return exists(requested) ? requested : undefined;
    if (!requested.endsWith(".js")) return undefined;
    const base = requested.slice(0, -3);
    if (
      [
        requested,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.jsx`,
        `${base}.d.ts`,
        `${base}.d.mts`,
        `${base}.d.cts`,
      ].some(exists)
    )
      return undefined;
    const candidates = [`${base}.fun`, `${base}.funx`].filter(exists);
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  const programAt = (file: string): Program | undefined => {
    if (programs.has(file)) return programs.get(file);
    const source = read(file);
    let program: Program | undefined;
    if (source !== undefined) {
      try {
        program = new Parser(
          new Lexer(source, file).tokenize(),
          file,
          source,
        ).parse();
      } catch {
        /* Reject invalid dependencies. */
      }
    }
    programs.set(file, program);
    return program;
  };
  const isIdentityRecord = (
    program: Program,
    declaration: import("../ast/types.js").SchemaDeclaration,
  ): boolean => {
    if (
      declaration.body.kind !== "RecordSchema" ||
      declaration.typeParams?.length
    )
      return false;
    const primitiveNames = new Set(["String", "Number", "Boolean"]);
    const shadowed = new Set(
      program.body.flatMap((part) => {
        const item =
          part.kind === "ExportDeclaration" ? part.declaration : part;
        return item.kind === "SchemaDeclaration" &&
          primitiveNames.has(item.id.name)
          ? [item.id.name]
          : [];
      }),
    );
    const identity = (type: TypeNode): boolean => {
      if (type.kind === "LiteralTypeNode") return true;
      if (type.kind === "UnionTypeNode") return type.types.every(identity);
      if (type.kind === "ParenthesizedTypeNode") return identity(type.typeNode);
      return (
        type.kind === "TypeReferenceNode" &&
        !type.typeArgs?.length &&
        primitiveNames.has(type.name.name) &&
        !shadowed.has(type.name.name)
      );
    };
    return declaration.body.fields.every(
      (field) =>
        !field.optional &&
        !field.defaultValue &&
        identity(field.typeAnnotation),
    );
  };
  const resolveIdentityExport = (
    file: string,
    name: string,
    seen: Set<string>,
  ): boolean => {
    const key = `${file}\0${name}`;
    if (seen.has(key)) return false;
    const program = programAt(file);
    if (!program) return false;
    const next = new Set(seen).add(key);
    const candidates: Array<
      | {
          kind: "schema";
          declaration: import("../ast/types.js").SchemaDeclaration;
        }
      | {
          kind: "reexport";
          declaration: ExportFromDeclaration;
          spec: import("../ast/types.js").ImportSpecifier;
        }
      | { kind: "other" }
    > = [];
    for (const item of program.body) {
      if (
        item.kind === "ExportDeclaration" &&
        item.declaration.kind === "SchemaDeclaration" &&
        item.declaration.id.name === name
      ) {
        candidates.push({ kind: "schema", declaration: item.declaration });
      } else if (
        item.kind === "ExportDeclaration" &&
        item.declaration.kind === "BindingDeclaration" &&
        "name" in item.declaration.id &&
        item.declaration.id.name === name
      ) {
        candidates.push({ kind: "other" });
      } else if (item.kind === "ExportFromDeclaration") {
        for (const spec of item.specifiers)
          if (spec.local.name === name)
            candidates.push({ kind: "reexport", declaration: item, spec });
      }
    }
    if (candidates.length !== 1) return false;
    const candidate = candidates[0];
    if (candidate.kind === "schema")
      return isIdentityRecord(program, candidate.declaration);
    if (candidate.kind === "other") return false;
    if (candidate.declaration.isTypeOnly || candidate.spec.isTypeOnly)
      return false;
    const target = targetOf(candidate.declaration, file);
    return (
      target !== undefined &&
      resolveIdentityExport(target, candidate.spec.imported.name, next)
    );
  };

  // Concrete codecs are verified independently of the stricter identity-codec
  // check used for callback adapters: optional fields can transform safely here.
  const dataDeclaration = (
    program: Program,
    file: string,
    decl: import("../ast/types.js").SchemaDeclaration,
    seen: Set<string>,
  ): boolean => {
    if (decl.body.kind !== "RecordSchema" || decl.typeParams?.length)
      return false;
    const declarations = program.body.map((item) =>
      item.kind === "ExportDeclaration" ? item.declaration : item,
    );
    const shadowed = new Set(
      declarations.flatMap((item) =>
        item.kind === "SchemaDeclaration" ||
        item.kind === "ErrorDeclaration" ||
        item.kind === "ServiceDeclaration"
          ? [item.id.name]
          : [],
      ),
    );
    if (
      shadowed.has("Schema") ||
      declarations.some(
        (item) =>
          (item.kind === "BindingDeclaration" &&
            "name" in item.id &&
            item.id.name === "Schema") ||
          (item.kind === "ImportDeclaration" &&
            (item.specifiers.some((spec) => spec.local.name === "Schema") ||
              item.defaultBinding?.name === "Schema" ||
              item.namespaceBinding?.name === "Schema")),
      )
    )
      return false;
    const supports = (type: TypeNode): boolean => {
      if (type.kind === "ParenthesizedTypeNode") return supports(type.typeNode);
      if (type.kind === "LiteralTypeNode") return true;
      if (type.kind === "ArrayTypeNode") return supports(type.elementType);
      if (type.kind === "UnionTypeNode") return type.types.every(supports);
      if (type.kind === "RecordTypeNode")
        return type.fields.every(
          (field) =>
            field.name.name !== "__proto__" &&
            !field.defaultValue &&
            supports(field.typeAnnotation),
        );
      if (type.kind !== "TypeReferenceNode") return false;
      const name = type.name.name;
      if (["String", "Number", "Boolean"].includes(name))
        return !type.typeArgs?.length && !shadowed.has(name);
      if (name === "Array")
        return type.typeArgs?.length === 1 && supports(type.typeArgs[0]);
      return (
        !type.typeArgs?.length &&
        resolveDataLocal(program, file, name, seen, decl)
      );
    };
    return decl.body.fields.every(
      (field) =>
        field.name.name !== "__proto__" &&
        !field.defaultValue &&
        supports(field.typeAnnotation),
    );
  };
  const resolveDataLocal = (
    program: Program,
    file: string,
    name: string,
    seen: Set<string>,
    eagerOwner?: import("../ast/types.js").SchemaDeclaration,
  ): boolean => {
    const declarations = program.body.map((item) =>
      item.kind === "ExportDeclaration" ? item.declaration : item,
    );
    const locals = declarations.filter(
      (item) => item.kind === "SchemaDeclaration" && item.id.name === name,
    );
    const imports = program.body.flatMap((item) =>
      item.kind === "ImportDeclaration" && !item.isTypeOnly
        ? item.specifiers
            .filter((spec) => !spec.isTypeOnly && spec.local.name === name)
            .map((spec) => ({ item, spec }))
        : [],
    );
    if (locals.length + imports.length !== 1) return false;
    if (locals.length) {
      const local = locals[0];
      if (local.kind !== "SchemaDeclaration") return false;
      // Concrete records are initialized eagerly, so forward local references
      // would hit the JavaScript temporal dead zone.
      if (
        eagerOwner &&
        declarations.indexOf(local) >= declarations.indexOf(eagerOwner)
      )
        return false;
      const key = `${file}\0data-local\0${name}`;
      if (seen.has(key)) return false;
      return dataDeclaration(program, file, local, new Set(seen).add(key));
    }
    const target = targetOf(imports[0].item, file);
    return (
      target !== undefined &&
      resolveDataExport(target, imports[0].spec.imported.name, seen)
    );
  };
  const resolveDataExport = (
    file: string,
    name: string,
    seen: Set<string>,
  ): boolean => {
    const key = `${file}\0data-export\0${name}`;
    if (seen.has(key)) return false;
    const program = programAt(file);
    if (!program) return false;
    const candidates: Array<
      | {
          kind: "schema";
          declaration: import("../ast/types.js").SchemaDeclaration;
        }
      | {
          kind: "reexport";
          declaration: ExportFromDeclaration;
          spec: import("../ast/types.js").ImportSpecifier;
        }
      | { kind: "other" }
    > = [];
    for (const item of program.body) {
      if (
        item.kind === "ExportDeclaration" &&
        item.declaration.kind === "SchemaDeclaration" &&
        item.declaration.id.name === name
      )
        candidates.push({ kind: "schema", declaration: item.declaration });
      else if (
        item.kind === "ExportDeclaration" &&
        item.declaration.kind === "BindingDeclaration" &&
        "name" in item.declaration.id &&
        item.declaration.id.name === name
      )
        candidates.push({ kind: "other" });
      else if (item.kind === "ExportFromDeclaration")
        for (const spec of item.specifiers)
          if (spec.local.name === name)
            candidates.push({ kind: "reexport", declaration: item, spec });
    }
    if (candidates.length !== 1) return false;
    const candidate = candidates[0];
    const next = new Set(seen).add(key);
    if (candidate.kind === "schema")
      return dataDeclaration(program, file, candidate.declaration, next);
    if (
      candidate.kind === "other" ||
      candidate.declaration.isTypeOnly ||
      candidate.spec.isTypeOnly
    )
      return false;
    const target = targetOf(candidate.declaration, file);
    return (
      target !== undefined &&
      resolveDataExport(target, candidate.spec.imported.name, next)
    );
  };

  // Follow only verifiable generic factories and reject cycles and ambiguous exports.
  const genericArity = (
    program: Program,
    file: string,
    decl: import("../ast/types.js").SchemaDeclaration,
    seen: Set<string>,
  ): number | undefined => {
    if (decl.body.kind !== "RecordSchema" || !decl.typeParams?.length)
      return undefined;
    const names = new Set(decl.typeParams.map((p) => p.name.name));
    if (
      names.size !== decl.typeParams.length ||
      decl.typeParams.some(
        (p) =>
          p.constraint ||
          [
            "Schema",
            "String",
            "Number",
            "Boolean",
            "Array",
            "Option",
            "Record",
            decl.id.name,
          ].includes(p.name.name),
      )
    )
      return undefined;
    const declarations = program.body.map((item) =>
      item.kind === "ExportDeclaration" ? item.declaration : item,
    );
    if (
      declarations.some(
        (item) =>
          (item.kind === "SchemaDeclaration" && item.id.name === "Schema") ||
          (item.kind === "BindingDeclaration" &&
            "name" in item.id &&
            item.id.name === "Schema") ||
          (item.kind === "ImportDeclaration" &&
            (item.specifiers.some((spec) => spec.local.name === "Schema") ||
              item.defaultBinding?.name === "Schema" ||
              item.namespaceBinding?.name === "Schema")),
      )
    )
      return undefined;
    const shadowed = new Set(
      declarations.flatMap((item) =>
        item.kind === "SchemaDeclaration" ||
        item.kind === "ErrorDeclaration" ||
        item.kind === "ServiceDeclaration"
          ? [item.id.name]
          : [],
      ),
    );
    const factoryArity = (name: string): number | undefined => {
      const locals = declarations.filter(
        (item) => item.kind === "SchemaDeclaration" && item.id.name === name,
      );
      const imports = program.body.flatMap((item) =>
        item.kind === "ImportDeclaration" && !item.isTypeOnly
          ? item.specifiers
              .filter((spec) => !spec.isTypeOnly && spec.local.name === name)
              .map((spec) => ({ item, spec }))
          : [],
      );
      if (locals.length + imports.length !== 1) return undefined;
      if (locals.length) {
        const local = locals[0];
        if (local.kind !== "SchemaDeclaration") return undefined;
        const key = `${file}\0local\0${name}`;
        if (seen.has(key)) return undefined;
        return genericArity(program, file, local, new Set(seen).add(key));
      }
      const target = targetOf(imports[0].item, file);
      return target
        ? resolveGenericExport(target, imports[0].spec.imported.name, seen)
        : undefined;
    };
    const supportsArgument = (type: TypeNode): boolean => {
      if (type.kind === "ParenthesizedTypeNode")
        return supportsArgument(type.typeNode);
      if (type.kind !== "TypeReferenceNode") return false;
      const name = type.name.name;
      if (names.has(name)) return !type.typeArgs?.length;
      if (["String", "Number", "Boolean"].includes(name))
        return !type.typeArgs?.length && !shadowed.has(name);
      if (name === "Array")
        return (
          type.typeArgs?.length === 1 && supportsArgument(type.typeArgs[0])
        );
      if (!type.typeArgs?.length)
        return resolveDataLocal(program, file, name, seen);
      const arity = factoryArity(name);
      return (
        arity !== undefined &&
        type.typeArgs.length === arity &&
        type.typeArgs.every(supportsArgument)
      );
    };
    const supports = (type: TypeNode): boolean => {
      if (type.kind === "ParenthesizedTypeNode") return supports(type.typeNode);
      if (type.kind === "LiteralTypeNode") return true;
      if (type.kind === "ArrayTypeNode") return supports(type.elementType);
      if (type.kind === "UnionTypeNode") return type.types.every(supports);
      if (type.kind === "RecordTypeNode")
        return type.fields.every(
          (field) =>
            field.name.name !== "__proto__" &&
            !field.optional &&
            !field.defaultValue &&
            supports(field.typeAnnotation),
        );
      if (type.kind !== "TypeReferenceNode") return false;
      const name = type.name.name;
      if (names.has(name)) return !type.typeArgs?.length;
      if (["String", "Number", "Boolean"].includes(name))
        return !type.typeArgs?.length && !shadowed.has(name);
      if (name === "Array")
        return type.typeArgs?.length === 1 && supports(type.typeArgs[0]);
      if (!type.typeArgs?.length)
        return resolveDataLocal(program, file, name, seen);
      const arity = factoryArity(name);
      return (
        arity !== undefined &&
        type.typeArgs.length === arity &&
        type.typeArgs.every(supportsArgument)
      );
    };
    return decl.body.fields.every(
      (field) =>
        field.name.name !== "__proto__" &&
        !field.defaultValue &&
        supports(field.typeAnnotation),
    )
      ? decl.typeParams.length
      : undefined;
  };
  const resolveGenericExport = (
    file: string,
    name: string,
    seen: Set<string>,
  ): number | undefined => {
    const key = `${file}\0${name}`;
    if (seen.has(key)) return undefined;
    const program = programAt(file);
    if (!program) return undefined;
    const candidates: Array<
      | {
          kind: "schema";
          declaration: import("../ast/types.js").SchemaDeclaration;
        }
      | {
          kind: "reexport";
          declaration: ExportFromDeclaration;
          spec: import("../ast/types.js").ImportSpecifier;
        }
      | { kind: "other" }
    > = [];
    for (const item of program.body) {
      if (
        item.kind === "ExportDeclaration" &&
        item.declaration.kind === "SchemaDeclaration" &&
        item.declaration.id.name === name
      )
        candidates.push({ kind: "schema", declaration: item.declaration });
      else if (
        item.kind === "ExportDeclaration" &&
        item.declaration.kind === "BindingDeclaration" &&
        "name" in item.declaration.id &&
        item.declaration.id.name === name
      )
        candidates.push({ kind: "other" });
      else if (item.kind === "ExportFromDeclaration")
        for (const spec of item.specifiers)
          if (spec.local.name === name)
            candidates.push({ kind: "reexport", declaration: item, spec });
    }
    if (candidates.length !== 1) return undefined;
    const candidate = candidates[0];
    if (candidate.kind === "schema")
      return genericArity(
        program,
        file,
        candidate.declaration,
        new Set(seen).add(key),
      );
    if (
      candidate.kind === "other" ||
      candidate.declaration.isTypeOnly ||
      candidate.spec.isTypeOnly
    )
      return undefined;
    const target = targetOf(candidate.declaration, file);
    return target
      ? resolveGenericExport(
          target,
          candidate.spec.imported.name,
          new Set(seen).add(key),
        )
      : undefined;
  };

  const hasOptional = (node: TypeNode | undefined): boolean =>
    node?.kind === "RecordTypeNode" &&
    node.fields.some(
      (field) =>
        Boolean(field.optional || field.defaultValue) ||
        hasOptional(field.typeAnnotation),
    );
  const localContract = (
    program: Program,
    file: string,
    name: string,
  ): RecordTypeNode | undefined => {
    for (const item of program.body) {
      const declaration =
        item.kind === "ExportDeclaration" ? item.declaration : item;
      if (
        declaration.kind === "SchemaDeclaration" &&
        declaration.id.name === name &&
        declaration.body.kind === "RecordSchema" &&
        isRecordContract(declaration.body)
      )
        return recordContractType(declaration.body);
    }
    for (const item of program.body) {
      if (item.kind !== "ImportDeclaration") continue;
      const spec = item.specifiers.find((part) => part.local.name === name);
      if (!spec) continue;
      const target = targetOf(item, file);
      const imported = target ? programAt(target) : undefined;
      const entry = imported?.body.find(
        (part) =>
          part.kind === "ExportDeclaration" &&
          part.declaration.kind === "SchemaDeclaration" &&
          part.declaration.id.name === spec.imported.name,
      );
      if (
        entry?.kind === "ExportDeclaration" &&
        entry.declaration.kind === "SchemaDeclaration" &&
        entry.declaration.body.kind === "RecordSchema" &&
        isRecordContract(entry.declaration.body)
      )
        return recordContractType(entry.declaration.body);
    }
    return undefined;
  };
  const positionsOf = (
    fn: FunctionExpression,
    program: Program,
    file: string,
  ): ReadonlySet<number> | undefined => {
    const positions = new Set<number>();
    fn.params.forEach((param, index) => {
      const type = param.typeAnnotation;
      if (
        hasOptional(
          type?.kind === "TypeReferenceNode"
            ? (localContract(program, file, type.name.name) ?? type)
            : type,
        )
      )
        positions.add(index);
    });
    return positions.size ? positions : undefined;
  };

  const resolveLocal = (
    program: Program,
    file: string,
    name: string,
    seen: Set<string>,
  ): ReadonlySet<number> | undefined => {
    const key = `${file}\0local\0${name}`;
    if (seen.has(key)) return undefined;
    const next = new Set(seen).add(key);
    const bindings: BindingDeclaration[] = [];
    for (const item of program.body) {
      const declaration =
        item.kind === "ExportDeclaration" ? item.declaration : item;
      if (
        declaration.kind === "BindingDeclaration" &&
        "name" in declaration.id &&
        declaration.id.name === name
      )
        bindings.push(declaration);
    }
    if (bindings.length > 1) return undefined;
    const binding = bindings[0];
    if (binding) {
      if (binding.isMut || binding.isJs) return undefined;
      if (binding.init.kind === "FunctionExpression")
        return positionsOf(binding.init, program, file);
      return binding.init.kind === "Identifier"
        ? resolveLocal(program, file, binding.init.name, next)
        : undefined;
    }
    for (const item of program.body) {
      if (item.kind !== "ImportDeclaration" || item.isTypeOnly) continue;
      const spec = item.specifiers.find(
        (part) => !part.isTypeOnly && part.local.name === name,
      );
      const importedName =
        spec?.imported.name ??
        (item.defaultBinding?.name === name ? "default" : undefined);
      if (!importedName) continue;
      const target = targetOf(item, file);
      return target ? resolveExport(target, importedName, next) : undefined;
    }
    return undefined;
  };
  const resolveExport = (
    file: string,
    name: string,
    seen: Set<string>,
  ): ReadonlySet<number> | undefined => {
    const key = `${file}\0export\0${name}`;
    if (seen.has(key)) return undefined;
    const program = programAt(file);
    if (!program) return undefined;
    const next = new Set(seen).add(key);
    if (name === "default") {
      const entry = program.body.find(
        (item) => item.kind === "ExportDefaultDeclaration",
      );
      if (entry?.kind !== "ExportDefaultDeclaration") return undefined;
      if (entry.expression.kind === "FunctionExpression")
        return positionsOf(entry.expression, program, file);
      return entry.expression.kind === "Identifier"
        ? resolveLocal(program, file, entry.expression.name, next)
        : undefined;
    }
    const entry = program.body.find(
      (item) =>
        item.kind === "ExportDeclaration" &&
        item.declaration.kind === "BindingDeclaration" &&
        "name" in item.declaration.id &&
        item.declaration.id.name === name,
    );
    return entry ? resolveLocal(program, file, name, next) : undefined;
  };

  for (const item of ast.body) {
    if (item.kind !== "ImportDeclaration") continue;
    const target = targetOf(item, filename);
    if (!target) continue;
    for (const spec of item.specifiers) {
      const imported = programAt(target);
      const entry = imported?.body.find(
        (part) =>
          part.kind === "ExportDeclaration" &&
          part.declaration.kind === "SchemaDeclaration" &&
          part.declaration.id.name === spec.imported.name,
      );
      if (
        entry?.kind === "ExportDeclaration" &&
        entry.declaration.kind === "SchemaDeclaration" &&
        entry.declaration.body.kind === "RecordSchema" &&
        isRecordContract(entry.declaration.body)
      )
        importedContracts?.set(
          spec.local.name,
          recordContractType(entry.declaration.body),
        );
      if (
        !item.isTypeOnly &&
        !spec.isTypeOnly &&
        resolveIdentityExport(target, spec.imported.name, new Set())
      )
        importedIdentitySchemas?.add(spec.local.name);
      if (item.isTypeOnly || spec.isTypeOnly) continue;
      if (resolveDataExport(target, spec.imported.name, new Set()))
        importedDataSchemas?.add(spec.local.name);
      const arity = resolveGenericExport(target, spec.imported.name, new Set());
      if (arity !== undefined)
        importedGenericDataSchemas?.set(spec.local.name, arity);
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
        const name =
          entry.kind === "ExportDeclaration" &&
          entry.declaration.kind === "BindingDeclaration" &&
          "name" in entry.declaration.id
            ? entry.declaration.id.name
            : entry.kind === "ExportDefaultDeclaration"
              ? "default"
              : undefined;
        if (!name) continue;
        const positions = resolveExport(target, name, new Set());
        if (positions)
          result.set(`${item.namespaceBinding.name}.${name}`, positions);
      }
    }
  }
  return result;
}
