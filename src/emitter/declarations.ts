import type {
  BindingDeclaration,
  BindingTarget,
  ErrorDeclaration,
  Expression,
  Identifier,
  Pattern,
  SchemaDeclaration,
  ServiceDeclaration,
  Statement,
  TopLevelDeclaration,
  TypeNode,
  WhenStatement,
} from "../ast/types.js";
import { FunScriptError } from "../errors.js";
import { emitAssemblyScript } from "./assemblyscript.js";
import { renderImport, renderExportFrom } from "./imports.js";
import type { RecordFieldInfo } from "./match.js";
import { renderProviderRuntimeExportType } from "../compiler/provider-runtime-types.js";

export interface DeclarationEmitterContext {
  emitExpression(expr: Expression): string;
  emitStatement(stmt: Statement): string;
  emitTypeNode(typeNode: TypeNode): string;
  emitSchemaTypeField(typeNode: TypeNode): string;
  emitBindingTarget(target: BindingTarget | Pattern): string;
  emitSchemaDeclaration(decl: SchemaDeclaration, isExport: boolean): string;
  emitWhenStatement(stmt: WhenStatement): string;
  addEffectImport(name: string): void;
  recordContracts: Map<string, TypeNode>;
  parameterScopes: Array<Map<string, boolean>>;
  variableTypeScopes: Array<Map<string, TypeNode | undefined>>;
  recordScopes: Array<Map<string, Map<string, RecordFieldInfo> | undefined>>;
  primitiveIdentifiers: Set<string>;
  isOptionalValue(expr: Expression): boolean;
  recordFields(name: string): Map<string, RecordFieldInfo> | undefined;
  isPrimitive(expr: Expression): boolean;
  preparedRuntimeApis?: ReadonlyMap<
    string,
    import("../compiler.js").PreparedRuntimeApi
  >;
  addRuntimeImport(specifier: string, imported: string, local: string): void;
  runtimeLocalName(base: string): string;
}

export function isPrimitiveType(type?: TypeNode): boolean {
  if (!type) return false;
  if (type.kind === "TypeReferenceNode") {
    const name = type.name.name.toLowerCase();
    return (
      name === "number" ||
      name === "string" ||
      name === "boolean" ||
      name === "int" ||
      name === "float"
    );
  }
  return false;
}

export function collectBindingNames(target: BindingTarget | Pattern): string[] {
  if (target.kind === "Identifier" || target.kind === "UpperIdentifier")
    return [target.name];
  if (target.kind === "VariablePattern") return [target.name.name];
  if (target.kind === "RestPattern")
    return collectBindingNames(target.argument);
  if (target.kind === "RecordPattern") {
    return target.fields.flatMap((f) =>
      f.pattern ? collectBindingNames(f.pattern) : [f.key.name],
    );
  }
  if (target.kind === "ArrayPattern") {
    return target.elements.flatMap((el) => collectBindingNames(el));
  }
  return [];
}

export function emitErrorDeclaration(
  ctx: DeclarationEmitterContext,
  decl: ErrorDeclaration,
  isExport: boolean,
): string {
  ctx.addEffectImport("Schema");
  const name = decl.id.name;
  const exp = isExport ? "export " : "";
  const fields = decl.fields
    .map(
      (f) => `  ${f.name.name}: ${ctx.emitSchemaTypeField(f.typeAnnotation)}`,
    )
    .join(",\n");

  const className = `${name}$Class`;
  return `${exp}class ${className} extends Schema.TaggedError<${className}>()("${name}", {\n${fields}\n}) {}\n${exp}type ${name} = InstanceType<typeof ${className}>;\n${exp}const ${name} = (function(args: ConstructorParameters<typeof ${className}>[0]): ${name} { return new ${className}(args); }) as { (args: ConstructorParameters<typeof ${className}>[0]): ${name}; new (args: ConstructorParameters<typeof ${className}>[0]): ${name} };`;
}

export function emitServiceDeclaration(
  ctx: DeclarationEmitterContext,
  decl: ServiceDeclaration,
  isExport: boolean,
): string {
  ctx.addEffectImport("Context");
  ctx.addEffectImport("Effect");
  const name = decl.id.name;
  const exp = isExport ? "export " : "";
  const tag = decl.customTag ? decl.customTag.raw : `"app/${name}"`;
  const members = decl.members
    .map((m) => `  readonly ${m.name.name}: ${ctx.emitTypeNode(m.signature)};`)
    .join("\n");

  return `${exp}class ${name} extends Context.Service<${name}, {\n${members}\n}>()(${tag}) {}`;
}

export function emitBindingDeclaration(
  ctx: DeclarationEmitterContext,
  decl: BindingDeclaration,
  isExport = false,
): string {
  const scope = ctx.parameterScopes.at(-1);
  const idName =
    decl.id.kind === "Identifier" || decl.id.kind === "UpperIdentifier"
      ? decl.id.name
      : undefined;
  if (idName) {
    if (scope) scope.set(idName, ctx.isOptionalValue(decl.init));
    const aliasedFields =
      !decl.isMut && decl.init.kind === "Identifier"
        ? ctx.recordFields(decl.init.name)
        : undefined;
    ctx.recordScopes.at(-1)?.set(idName, aliasedFields);
    ctx.variableTypeScopes.at(-1)?.set(idName, decl.typeAnnotation);
    if (isPrimitiveType(decl.typeAnnotation) || ctx.isPrimitive(decl.init)) {
      ctx.primitiveIdentifiers.add(idName);
    }
  }
  const target = ctx.emitBindingTarget(decl.id);
  const exp = isExport ? "export " : "";
  const keyword = decl.isMut ? "let" : "const";
  const typeAnn = decl.typeAnnotation
    ? `: ${ctx.emitTypeNode(decl.typeAnnotation)}`
    : "";

  if (decl.isJs) {
    if (
      decl.init.kind === "FunctionExpression" &&
      decl.init.params.some(
        (p) =>
          p.typeAnnotation?.kind === "TypeReferenceNode" &&
          ctx.recordContracts.has(p.typeAnnotation.name.name),
      )
    ) {
      throw new FunScriptError(
        "Compile-time record contracts are not supported on js entry bindings",
        decl.span,
      );
    }
    ctx.addEffectImport("Effect");
    if (decl.init.kind === "FunctionExpression") {
      const fn = decl.init;
      const validations = fn.params
        .filter(
          (p) =>
            !p.optional && p.typeAnnotation && p.name.kind === "Identifier",
        )
        .map(
          (p) =>
            `  ${(p.name as Identifier).name} = Schema.decodeUnknownSync(${ctx.emitSchemaTypeField(p.typeAnnotation!)})(${(p.name as Identifier).name});`,
        )
        .join("\n");
      const optionalBindings = fn.params.flatMap((p, index) => {
        if (!p.optional) return [];
        ctx.addEffectImport("Option");
        const targetName = ctx.emitBindingTarget(p.name);
        const rawName = `$funscriptOptional${index}`;
        if (p.typeAnnotation && p.name.kind === "Identifier") {
          ctx.addEffectImport("Schema");
          return [
            `  const ${targetName} = ${rawName} !== undefined ? Option.some(Schema.decodeUnknownSync(${ctx.emitSchemaTypeField(p.typeAnnotation)})(${rawName})) : Option.none();`,
          ];
        }
        return [`  const ${targetName} = Option.fromUndefinedOr(${rawName});`];
      });
      if (validations || optionalBindings.length > 0)
        ctx.addEffectImport("Schema");
      for (const p of fn.params) {
        if (isPrimitiveType(p.typeAnnotation)) {
          for (const n of collectBindingNames(p.name)) {
            ctx.primitiveIdentifiers.add(n);
          }
        }
      }
      const params = fn.params
        .map((p, index) => {
          const rest = p.isRest ? "..." : "";
          const name = p.optional
            ? `$funscriptOptional${index}`
            : ctx.emitBindingTarget(p.name);
          const t = p.typeAnnotation
            ? `: ${ctx.emitTypeNode(p.typeAnnotation)}`
            : "";
          const def = p.defaultValue
            ? ` = ${ctx.emitExpression(p.defaultValue)}`
            : "";
          return `${rest}${name}${p.optional ? "?" : ""}${t}${def}`;
        })
        .join(", ");
      const headerStatements = [validations, ...optionalBindings]
        .filter(Boolean)
        .join("\n");
      const prefix = headerStatements ? `${headerStatements}\n` : "";
      const varTypeEntries: [string, TypeNode | undefined][] = [];
      for (const p of fn.params) {
        for (const n of collectBindingNames(p.name)) {
          varTypeEntries.push([n, p.typeAnnotation]);
        }
      }
      ctx.variableTypeScopes.push(new Map(varTypeEntries));
      try {
        if (fn.body.kind === "BlockStatement") {
          const retExpr = fn.body.finalExpression
            ? ctx.emitExpression(fn.body.finalExpression)
            : "undefined";
          if (fn.body.statements.length === 0) {
            return `${exp}${keyword} ${target} = (${params}) => {\n${prefix}  return Effect.runPromise(${retExpr});\n};`;
          }
          const stmts = fn.body.statements
            .map((s) => "    " + ctx.emitStatement(s))
            .join("\n");
          return `${exp}${keyword} ${target} = (${params}) => {\n${prefix}  return Effect.runPromise(Effect.gen(function* () {\n${stmts}\n    return ${retExpr};\n  }));\n};`;
        }
        return `${exp}${keyword} ${target} = (${params}) => {\n${prefix}  return Effect.runPromise(${ctx.emitExpression(fn.body)});\n};`;
      } finally {
        ctx.variableTypeScopes.pop();
      }
    }
    return `${exp}${keyword} ${target}${typeAnn} = Effect.runPromise(${ctx.emitExpression(decl.init)});`;
  }

  return `${exp}${keyword} ${target}${typeAnn} = ${ctx.emitExpression(decl.init)};`;
}

export function emitTopLevelDeclaration(
  ctx: DeclarationEmitterContext,
  decl: TopLevelDeclaration,
  isExport = false,
): string {
  switch (decl.kind) {
    case "ImportDeclaration":
      return renderImport(decl);
    case "ExportFromDeclaration":
      return renderExportFrom(decl);
    case "ExportDeclaration":
      return emitTopLevelDeclaration(ctx, decl.declaration, true);
    case "ExportDefaultDeclaration":
      return `export default ${ctx.emitExpression(decl.expression)};`;
    case "SchemaDeclaration":
      return ctx.emitSchemaDeclaration(decl, isExport);
    case "ErrorDeclaration":
      return emitErrorDeclaration(ctx, decl, isExport);
    case "ServiceDeclaration":
      return emitServiceDeclaration(ctx, decl, isExport);
    case "DatabaseDeclaration":
      return emitDatabaseDeclaration(ctx, decl, isExport);
    case "BindingDeclaration":
      return emitBindingDeclaration(ctx, decl, isExport);
    case "WhenStatement":
      return ctx.emitWhenStatement(decl);
    case "TsEscapeDeclaration":
      return decl.code + "\n";
    case "AsDeclaration":
      ctx.addEffectImport("Effect");
      ctx.addEffectImport("Scope");
      return emitAssemblyScript(decl);
  }
}

function emitDatabaseDeclaration(
  ctx: DeclarationEmitterContext,
  decl: import("../ast/types.js").DatabaseDeclaration,
  isExport: boolean,
): string {
  const api = ctx.preparedRuntimeApis?.get(decl.id.name);
  if (!api)
    throw new FunScriptError(
      "Missing prepared provider runtime result",
      decl.span,
    );
  const exp = isExport ? "export " : "";
  const used = new Set<string>();
  const lines = api.exports.map((item, index) => {
    if (typeof item.name !== "string" || used.has(item.name))
      throw new FunScriptError(
        `Invalid or colliding provider runtime export '${item.name}'`,
        decl.span,
      );
    used.add(item.name);
    const local = ctx.runtimeLocalName(
      `$funscriptRuntime_${decl.id.name}_${index}`,
    );
    ctx.addRuntimeImport(api.moduleSpecifier, item.name, local);
    return `  ${JSON.stringify(item.name)}: ${local}`;
  });
  const type = `{ ${api.exports.map((item) => `${JSON.stringify(item.name)}: ${renderProviderRuntimeExportType(item)}`).join("; ")} }`;
  return `${exp}const ${decl.id.name}: ${type} = {\n${lines.join(",\n")}\n};`;
}
