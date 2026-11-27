import type {
  ArrayPattern,
  BindingDeclaration,
  BindingTarget,
  ErrorDeclaration,
  Expression,
  Identifier,
  Pattern,
  RecordPattern,
  RecordTypeNode,
  SchemaDeclaration,
  ServiceDeclaration,
  Statement,
  TopLevelDeclaration,
  TypeNode,
  WhenStatement,
} from "../ast/types.js";
import { emitAssemblyScript } from "./assemblyscript.js";
import { renderExportFrom, renderImport } from "./imports.js";
import type { RecordFieldInfo } from "./match.js";

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
  recordField?(expr: Expression): RecordFieldInfo | undefined;
  isPrimitive(expr: Expression): boolean;
  modularEffectImports?: boolean;
  getRecordTypeNode?(name: string): RecordTypeNode | undefined;
  getTypeNodeForExpression?(expr: Expression): TypeNode | undefined;
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

let syntheticDestructureId = 0;

export function extractRecordFields(
  typeNode: RecordTypeNode,
  getRecordType?: (name: string) => RecordTypeNode | undefined,
): Map<string, RecordFieldInfo> {
  const result = new Map<string, RecordFieldInfo>();
  for (const field of typeNode.fields) {
    let childNode: RecordTypeNode | undefined;
    if (field.typeAnnotation?.kind === "RecordTypeNode") {
      childNode = field.typeAnnotation;
    } else if (
      field.typeAnnotation?.kind === "TypeReferenceNode" &&
      getRecordType
    ) {
      childNode = getRecordType(field.typeAnnotation.name.name);
    }
    const children = childNode
      ? extractRecordFields(childNode, getRecordType)
      : undefined;
    result.set(field.name.name, {
      optional: Boolean(field.optional),
      fields: children,
    });
  }
  return result;
}

export function patternHasOptionalField(
  pattern: RecordPattern,
  fieldsInfo?: Map<string, RecordFieldInfo>,
): boolean {
  if (!fieldsInfo) return false;
  for (const f of pattern.fields) {
    if (f.isRest) continue;
    const info = fieldsInfo.get(f.key.name);
    if (info?.optional) return true;
    if (f.pattern?.kind === "RecordPattern" && info?.fields) {
      if (patternHasOptionalField(f.pattern, info.fields)) return true;
    }
  }
  return false;
}

export function emitUnpackedRecordPattern(options: {
  pat: RecordPattern;
  basePath: string;
  fieldsMap?: Map<string, RecordFieldInfo>;
  emitBindingTarget: (target: BindingTarget | Pattern) => string;
  addEffectImport: (name: string) => void;
  exp?: string;
  keyword?: string;
  indent?: string;
  onRecordBinding?: (
    varName: string,
    fields: Map<string, RecordFieldInfo>,
  ) => void;
}): string[] {
  const {
    pat,
    basePath,
    fieldsMap,
    emitBindingTarget,
    addEffectImport,
    exp = "",
    keyword = "const",
    indent = "",
    onRecordBinding,
  } = options;
  const lines: string[] = [];

  const unpackOptionalArray = (arrPat: ArrayPattern, optRef: string) => {
    addEffectImport("Option");
    for (let i = 0; i < arrPat.elements.length; i++) {
      const el = arrPat.elements[i];
      if (el.kind === "WildcardPattern" || el.kind === "LiteralPattern") {
        continue;
      }
      if (el.kind === "RestPattern") {
        const arg = emitBindingTarget(el.argument);
        if (arg) {
          lines.push(
            `${indent}${exp}${keyword} ${arg} = Option.map(${optRef}, ($v) => $v.slice(${i}));`,
          );
        }
        continue;
      }
      const elemOpt = `Option.flatMap(${optRef}, ($v) => Option.fromNullishOr($v[${i}]))`;
      if (el.kind === "RecordPattern") {
        const subOpt = `$funscriptOpt${syntheticDestructureId++}`;
        lines.push(`${indent}const ${subOpt} = ${elemOpt};`);
        unpackOptionalRecord(el, subOpt, undefined);
      } else if (el.kind === "ArrayPattern") {
        const subOpt = `$funscriptOpt${syntheticDestructureId++}`;
        lines.push(`${indent}const ${subOpt} = ${elemOpt};`);
        unpackOptionalArray(el, subOpt);
      } else {
        const varName = emitBindingTarget(el);
        if (varName) {
          lines.push(`${indent}${exp}${keyword} ${varName} = ${elemOpt};`);
        }
      }
    }
  };

  const unpackOptionalRecord = (
    recPat: RecordPattern,
    optRef: string,
    subFieldsMap?: Map<string, RecordFieldInfo>,
  ) => {
    addEffectImport("Option");
    const restField = recPat.fields.find((f) => f.isRest);
    if (restField) {
      const nonRest = recPat.fields.filter((f) => !f.isRest);
      lines.push(
        `${indent}${exp}${keyword} ${restField.key.name} = Option.map(${optRef}, ({ ${nonRest.map((f) => `${f.key.name}: _${f.key.name}`).join(", ")}, ...$funscriptRest }) => $funscriptRest);`,
      );
    }
    for (const f of recPat.fields) {
      if (f.isRest) continue;
      if (
        f.pattern?.kind === "WildcardPattern" ||
        f.pattern?.kind === "LiteralPattern"
      ) {
        continue;
      }
      const info = subFieldsMap?.get(f.key.name);
      const isOpt = info?.optional === true;
      const mappedOpt = isOpt
        ? `Option.flatMap(${optRef}, ($v) => Option.fromNullishOr($v.${f.key.name}))`
        : `Option.map(${optRef}, ($v) => $v.${f.key.name})`;
      if (f.pattern?.kind === "RecordPattern") {
        const subOpt = `$funscriptOpt${syntheticDestructureId++}`;
        lines.push(`${indent}const ${subOpt} = ${mappedOpt};`);
        unpackOptionalRecord(f.pattern, subOpt, info?.fields);
      } else if (f.pattern?.kind === "ArrayPattern") {
        const subOpt = `$funscriptOpt${syntheticDestructureId++}`;
        lines.push(`${indent}const ${subOpt} = ${mappedOpt};`);
        unpackOptionalArray(f.pattern, subOpt);
      } else {
        const varName = f.pattern ? emitBindingTarget(f.pattern) : f.key.name;
        if (varName) {
          lines.push(`${indent}${exp}${keyword} ${varName} = ${mappedOpt};`);
        }
      }
    }
  };

  const unpackRecord = (
    recPat: RecordPattern,
    currentPath: string,
    subFieldsMap?: Map<string, RecordFieldInfo>,
  ) => {
    const restField = recPat.fields.find((f) => f.isRest);
    if (restField) {
      const nonRest = recPat.fields.filter((f) => !f.isRest);
      const restTemp = `$funscriptRest${syntheticDestructureId++}`;
      lines.push(
        `${indent}const { ${nonRest.map((f) => `${f.key.name}: _${f.key.name}`).join(", ")}, ...${restTemp} } = ${currentPath};`,
      );
      lines.push(
        `${indent}${exp}${keyword} ${restField.key.name} = ${restTemp};`,
      );
    }
    for (const f of recPat.fields) {
      if (f.isRest) continue;
      if (
        f.pattern?.kind === "WildcardPattern" ||
        f.pattern?.kind === "LiteralPattern"
      ) {
        continue;
      }
      const info = subFieldsMap?.get(f.key.name);
      const isOpt = info?.optional === true;
      const fieldPath = `${currentPath}.${f.key.name}`;
      if (f.pattern?.kind === "RecordPattern") {
        if (isOpt) {
          const optTemp = `$funscriptOpt${syntheticDestructureId++}`;
          addEffectImport("Option");
          lines.push(
            `${indent}const ${optTemp} = Option.fromNullishOr(${fieldPath});`,
          );
          unpackOptionalRecord(f.pattern, optTemp, info?.fields);
        } else {
          unpackRecord(f.pattern, fieldPath, info?.fields);
        }
      } else if (f.pattern?.kind === "ArrayPattern") {
        if (isOpt) {
          const optTemp = `$funscriptOpt${syntheticDestructureId++}`;
          addEffectImport("Option");
          lines.push(
            `${indent}const ${optTemp} = Option.fromNullishOr(${fieldPath});`,
          );
          unpackOptionalArray(f.pattern, optTemp);
        } else {
          const varName = emitBindingTarget(f.pattern);
          if (varName) {
            lines.push(`${indent}${exp}${keyword} ${varName} = ${fieldPath};`);
          }
        }
      } else {
        const varName = f.pattern ? emitBindingTarget(f.pattern) : f.key.name;
        if (!varName) continue;
        if (isOpt) {
          addEffectImport("Option");
          lines.push(
            `${indent}${exp}${keyword} ${varName} = Option.fromNullishOr(${fieldPath});`,
          );
        } else {
          lines.push(`${indent}${exp}${keyword} ${varName} = ${fieldPath};`);
          if (info?.fields) {
            onRecordBinding?.(varName, info.fields);
          }
        }
      }
    }
  };

  unpackRecord(pat, basePath, fieldsMap);
  return lines;
}

function getRecordFieldInfoForBinding(
  ctx: DeclarationEmitterContext,
  decl: BindingDeclaration,
): Map<string, RecordFieldInfo> | undefined {
  const lookup = (name: string): RecordTypeNode | undefined => {
    const res = ctx.getRecordTypeNode?.(name) ?? ctx.recordContracts.get(name);
    return res?.kind === "RecordTypeNode" ? res : undefined;
  };

  if (decl.typeAnnotation) {
    if (decl.typeAnnotation.kind === "RecordTypeNode") {
      return extractRecordFields(decl.typeAnnotation, lookup);
    }
    if (decl.typeAnnotation.kind === "TypeReferenceNode") {
      const contract = lookup(decl.typeAnnotation.name.name);
      if (contract) {
        return extractRecordFields(contract, lookup);
      }
    }
  }
  if (decl.init.kind === "Identifier") {
    const fields = ctx.recordFields(decl.init.name);
    if (fields) return fields;
    const typeNode = ctx.getTypeNodeForExpression?.(decl.init);
    if (typeNode?.kind === "RecordTypeNode") {
      return extractRecordFields(typeNode, lookup);
    }
    if (typeNode?.kind === "TypeReferenceNode") {
      const contract = lookup(typeNode.name.name);
      if (contract) {
        return extractRecordFields(contract, lookup);
      }
    }
  }
  if (decl.init.kind === "MemberExpression") {
    const field = ctx.recordField?.(decl.init);
    if (field?.fields) return field.fields;
    const typeNode = ctx.getTypeNodeForExpression?.(decl.init);
    if (typeNode?.kind === "RecordTypeNode") {
      return extractRecordFields(typeNode, lookup);
    }
    if (typeNode?.kind === "TypeReferenceNode") {
      const contract = lookup(typeNode.name.name);
      if (contract) {
        return extractRecordFields(contract, lookup);
      }
    }
  }
  if (decl.init.kind === "RecordExpression") {
    return extractRecordFieldsForBinding(ctx, decl);
  }
  return undefined;
}

function extractRecordFieldsForBinding(
  ctx: DeclarationEmitterContext,
  decl: BindingDeclaration,
): Map<string, RecordFieldInfo> | undefined {
  if (decl.isMut) return undefined;
  const lookup = (name: string): RecordTypeNode | undefined => {
    const res = ctx.getRecordTypeNode?.(name) ?? ctx.recordContracts.get(name);
    return res?.kind === "RecordTypeNode" ? res : undefined;
  };
  if (decl.typeAnnotation?.kind === "RecordTypeNode") {
    return extractRecordFields(decl.typeAnnotation, lookup);
  }
  if (decl.typeAnnotation?.kind === "TypeReferenceNode") {
    const contract = lookup(decl.typeAnnotation.name.name);
    if (contract) {
      return extractRecordFields(contract, lookup);
    }
  }
  if (decl.init.kind === "Identifier") {
    return ctx.recordFields(decl.init.name);
  }
  if (decl.init.kind === "RecordExpression") {
    const fields = new Map<string, RecordFieldInfo>();
    let hasTracked = false;
    for (const prop of decl.init.entries) {
      if (prop.kind === "SpreadEntry") {
        if (prop.argument.kind === "Identifier") {
          const spreadFields = ctx.recordFields(prop.argument.name);
          if (spreadFields) {
            for (const [key, info] of spreadFields) {
              if (info.optional) hasTracked = true;
              fields.set(key, {
                optional: info.optional,
                defaultBinding: undefined,
                fields: info.fields,
              });
            }
          }
        }
      } else if (prop.kind === "FieldEntry" || prop.kind === "ShorthandEntry") {
        const keyName = prop.key.name;
        if (keyName) {
          const isOpt =
            prop.kind === "FieldEntry"
              ? ctx.isOptionalValue(prop.value)
              : ctx.isOptionalValue(prop.key);
          if (isOpt) hasTracked = true;
          fields.set(keyName, {
            optional: isOpt,
            defaultBinding: undefined,
            fields: undefined,
          });
        }
      }
    }
    if (hasTracked) return fields;
  }
  return undefined;
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
    const aliasedFields = extractRecordFieldsForBinding(ctx, decl);
    ctx.recordScopes.at(-1)?.set(idName, aliasedFields);
    const inferred = !decl.typeAnnotation
      ? ctx.getTypeNodeForExpression?.(decl.init)
      : undefined;
    const inferredNullish =
      inferred?.kind === "TypeReferenceNode" &&
      inferred.name.name === "JSNullish";
    const inferredNullishFunction =
      inferred?.kind === "FunctionTypeNode" &&
      inferred.returnType.kind === "TypeReferenceNode" &&
      inferred.returnType.name.name === "JSNullish";
    ctx.variableTypeScopes
      .at(-1)
      ?.set(
        idName,
        decl.typeAnnotation ??
          (inferredNullish || inferredNullishFunction ? inferred : undefined),
      );
    if (isPrimitiveType(decl.typeAnnotation) || ctx.isPrimitive(decl.init)) {
      ctx.primitiveIdentifiers.add(idName);
    } else {
      ctx.primitiveIdentifiers.delete(idName);
    }
  }

  const fieldsInfo =
    decl.id.kind === "RecordPattern"
      ? getRecordFieldInfoForBinding(ctx, decl)
      : undefined;

  if (decl.id.kind === "RecordPattern" && fieldsInfo) {
    for (const f of decl.id.fields) {
      if (f.isRest) continue;
      const varName =
        f.pattern?.kind === "VariablePattern"
          ? f.pattern.name.name
          : f.key.name;
      const info = fieldsInfo.get(f.key.name);
      const isOpt = Boolean(info?.optional);
      if (scope) scope.set(varName, isOpt);
      if (info?.fields) {
        ctx.recordScopes.at(-1)?.set(varName, info.fields);
      }
    }
  }

  const bindingNames = collectBindingNames(decl.id);
  const exp = isExport && bindingNames.length > 0 ? "export " : "";
  const keyword = decl.isMut ? "let" : "const";
  const typeAnn = decl.typeAnnotation
    ? `: ${ctx.emitTypeNode(decl.typeAnnotation)}`
    : "";

  if (
    decl.id.kind === "RecordPattern" &&
    fieldsInfo &&
    patternHasOptionalField(decl.id, fieldsInfo)
  ) {
    ctx.addEffectImport("Option");
    const boundNames = collectBindingNames(decl.id);
    const canUseDirectInit =
      decl.init.kind === "Identifier" &&
      !boundNames.includes(decl.init.name) &&
      !decl.typeAnnotation &&
      !decl.isJs;
    let sourceRef = "";
    let initStatement = "";
    const initExpr = decl.isJs
      ? `Effect.runPromise(${ctx.emitExpression(decl.init)})`
      : ctx.emitExpression(decl.init);

    if (canUseDirectInit) {
      sourceRef = (decl.init as Identifier).name;
    } else {
      sourceRef = `$funscriptDestructure${syntheticDestructureId++}`;
      initStatement = `const ${sourceRef}${typeAnn} = ${initExpr};\n`;
    }

    const lines = emitUnpackedRecordPattern({
      pat: decl.id,
      basePath: sourceRef,
      fieldsMap: fieldsInfo,
      emitBindingTarget: (target) => ctx.emitBindingTarget(target),
      addEffectImport: (name) => ctx.addEffectImport(name),
      exp,
      keyword,
    });

    return `${initStatement}${lines.join("\n")}`;
  }

  const target = ctx.emitBindingTarget(decl.id);

  if (decl.isJs) {
    ctx.addEffectImport("Effect");
    if (decl.init.kind === "FunctionExpression") {
      const fn = decl.init;
      const validations = fn.params
        .flatMap((p, index) => {
          if (p.name.kind === "Identifier") {
            if (!p.typeAnnotation) return [];
            const paramName = p.name.name;
            const typeAnn = p.typeAnnotation;
            if (
              typeAnn.kind === "TypeReferenceNode" &&
              ctx.recordContracts.has(typeAnn.name.name)
            ) {
              return [
                `  ${paramName} = ${typeAnn.name.name}DecodeChecked(${paramName});`,
              ];
            }
            return [
              `  ${paramName} = Schema.decodeUnknownSync(${ctx.emitSchemaTypeField(typeAnn)})(${paramName});`,
            ];
          }
          if (p.name.kind === "RecordPattern") {
            const rawParam = `$funscriptParam${index}`;
            if (!p.typeAnnotation) {
              return [
                `  const ${ctx.emitBindingTarget(p.name)} = ${rawParam};`,
              ];
            }
            const typeAnn = p.typeAnnotation;
            const decodedVar = `$funscriptDecoded${index}`;
            const lookup = (name: string): RecordTypeNode | undefined => {
              const res =
                ctx.getRecordTypeNode?.(name) ?? ctx.recordContracts.get(name);
              return res?.kind === "RecordTypeNode" ? res : undefined;
            };
            let recType: TypeNode | undefined = typeAnn;
            if (recType?.kind === "TypeReferenceNode") {
              recType = lookup(recType.name.name);
            }
            const isContract =
              typeAnn.kind === "TypeReferenceNode" &&
              ctx.recordContracts.has(typeAnn.name.name);
            const decodeStmt = isContract
              ? `  const ${decodedVar} = ${typeAnn.name.name}DecodeChecked(${rawParam});`
              : `  const ${decodedVar} = Schema.decodeUnknownSync(${ctx.emitSchemaTypeField(typeAnn)})(${rawParam});`;
            const recFields =
              recType?.kind === "RecordTypeNode"
                ? extractRecordFields(recType, lookup)
                : undefined;
            if (patternHasOptionalField(p.name, recFields)) {
              return [decodeStmt];
            }
            return [
              decodeStmt,
              `  const ${ctx.emitBindingTarget(p.name)} = ${decodedVar};`,
            ];
          }
          return [];
        })
        .join("\n");
      const optionalBindings = fn.params.flatMap((p, index) => {
        if (p.name.kind === "RecordPattern") {
          const lookup = (name: string): RecordTypeNode | undefined => {
            const res =
              ctx.getRecordTypeNode?.(name) ?? ctx.recordContracts.get(name);
            return res?.kind === "RecordTypeNode" ? res : undefined;
          };
          let recType: TypeNode | undefined = p.typeAnnotation;
          if (recType?.kind === "TypeReferenceNode") {
            recType = lookup(recType.name.name);
          }
          const recFields =
            recType?.kind === "RecordTypeNode"
              ? extractRecordFields(recType, lookup)
              : undefined;
          if (patternHasOptionalField(p.name, recFields)) {
            ctx.addEffectImport("Option");
            const sourceRef = p.typeAnnotation
              ? `$funscriptDecoded${index}`
              : `$funscriptParam${index}`;
            return emitUnpackedRecordPattern({
              pat: p.name,
              basePath: sourceRef,
              fieldsMap: recFields,
              emitBindingTarget: (target) => ctx.emitBindingTarget(target),
              addEffectImport: (name) => ctx.addEffectImport(name),
              indent: "  ",
            });
          }
        }
        return [];
      });
      if (validations || optionalBindings.length > 0)
        ctx.addEffectImport("Schema");
      const prevPrimitiveIdentifiers = new Set(ctx.primitiveIdentifiers);
      for (const p of fn.params) {
        const isPrim = isPrimitiveType(p.typeAnnotation);
        for (const n of collectBindingNames(p.name)) {
          if (isPrim) {
            ctx.primitiveIdentifiers.add(n);
          } else {
            ctx.primitiveIdentifiers.delete(n);
          }
        }
      }
      const params = fn.params
        .map((p, index) => {
          const rest = p.isRest ? "..." : "";
          let name = ctx.emitBindingTarget(p.name);
          if (p.name.kind === "RecordPattern") {
            name = `$funscriptParam${index}`;
          }
          const t = p.typeAnnotation
            ? `: ${ctx.emitTypeNode(p.typeAnnotation)}`
            : "";
          const def = p.defaultValue
            ? ` = ${ctx.emitExpression(p.defaultValue)}`
            : "";
          return `${rest}${name}${t}${def}`;
        })
        .join(", ");
      const paramScopeEntries: [string, boolean][] = [];
      const varTypeEntries: [string, TypeNode | undefined][] = [];
      const recordDefaults: string[] = [];
      const recordScope = new Map<
        string,
        Map<string, RecordFieldInfo> | undefined
      >();
      for (let paramIndex = 0; paramIndex < fn.params.length; paramIndex++) {
        const p = fn.params[paramIndex];
        if (p.name.kind === "Identifier") {
          const paramName = p.name.name;
          paramScopeEntries.push([paramName, false]);
          if (p.typeAnnotation?.kind === "RecordTypeNode") {
            const mapped = new Map<string, RecordFieldInfo>();
            p.typeAnnotation.fields.forEach((field, fieldIndex) => {
              const binding = field.defaultValue
                ? `$funscriptField${paramIndex}_${fieldIndex}`
                : undefined;
              if (field.defaultValue) {
                const raw = `$funscriptFieldRaw${paramIndex}_${fieldIndex}`;
                recordDefaults.push(
                  `  const ${raw} = ${paramName}.${field.name.name};`,
                );
                recordDefaults.push(
                  `  const ${binding} = ${raw} === undefined ? ${ctx.emitExpression(field.defaultValue)} : ${raw};`,
                );
              }
              const children =
                field.typeAnnotation?.kind === "RecordTypeNode"
                  ? extractRecordFields(field.typeAnnotation)
                  : undefined;
              mapped.set(field.name.name, {
                optional: Boolean(field.optional),
                defaultBinding: binding,
                fields: children,
              });
            });
            recordScope.set(p.name.name, mapped);
          } else if (
            p.typeAnnotation?.kind === "TypeReferenceNode" &&
            ctx.recordContracts.has(p.typeAnnotation.name.name)
          ) {
            const contract = ctx.recordContracts.get(
              p.typeAnnotation.name.name,
            )!;
            if (contract?.kind === "RecordTypeNode") {
              recordScope.set(p.name.name, extractRecordFields(contract));
            }
          }
        } else if (p.name.kind === "RecordPattern") {
          const lookup = (name: string): RecordTypeNode | undefined => {
            const res =
              ctx.getRecordTypeNode?.(name) ?? ctx.recordContracts.get(name);
            return res?.kind === "RecordTypeNode" ? res : undefined;
          };
          let recType: TypeNode | undefined = p.typeAnnotation;
          if (recType?.kind === "TypeReferenceNode") {
            recType = lookup(recType.name.name);
          }
          const recFields =
            recType?.kind === "RecordTypeNode"
              ? extractRecordFields(recType, lookup)
              : undefined;
          if (patternHasOptionalField(p.name, recFields)) {
            const collectParamsFromPattern = (
              pat: RecordPattern,
              fieldsMap?: Map<string, RecordFieldInfo>,
              typeNode?: TypeNode,
              parentIsOpt = false,
            ) => {
              for (const f of pat.fields) {
                if (f.isRest) {
                  paramScopeEntries.push([f.key.name, parentIsOpt]);
                  varTypeEntries.push([f.key.name, undefined]);
                  continue;
                }
                const info = fieldsMap?.get(f.key.name);
                const isOpt = parentIsOpt || info?.optional === true;
                const matchingFieldType =
                  typeNode?.kind === "RecordTypeNode"
                    ? typeNode.fields.find((tf) => tf.name.name === f.key.name)
                        ?.typeAnnotation
                    : undefined;
                if (f.pattern?.kind === "RecordPattern") {
                  let subType: TypeNode | undefined = matchingFieldType;
                  if (subType?.kind === "TypeReferenceNode") {
                    subType = lookup(subType.name.name);
                  }
                  collectParamsFromPattern(
                    f.pattern,
                    info?.fields,
                    subType,
                    isOpt,
                  );
                } else if (f.pattern?.kind === "ArrayPattern") {
                  const elemType =
                    matchingFieldType?.kind === "ArrayTypeNode"
                      ? matchingFieldType.elementType
                      : undefined;
                  for (const el of f.pattern.elements) {
                    for (const n of collectBindingNames(el)) {
                      paramScopeEntries.push([n, isOpt]);
                      varTypeEntries.push([n, elemType]);
                    }
                  }
                } else {
                  const varName = f.pattern
                    ? f.pattern.kind === "VariablePattern"
                      ? f.pattern.name.name
                      : ctx.emitBindingTarget(f.pattern)
                    : f.key.name;
                  paramScopeEntries.push([varName, isOpt]);
                  if (!isOpt && info?.fields) {
                    recordScope.set(varName, info.fields);
                  }
                  if (matchingFieldType) {
                    varTypeEntries.push([varName, matchingFieldType]);
                  }
                }
              }
            };
            collectParamsFromPattern(p.name, recFields, recType);
            continue;
          }
        }
        for (const n of collectBindingNames(p.name)) {
          varTypeEntries.push([n, p.typeAnnotation]);
        }
      }
      ctx.parameterScopes.push(new Map(paramScopeEntries));
      ctx.variableTypeScopes.push(new Map(varTypeEntries));
      ctx.recordScopes.push(recordScope);
      const headerStatements = [
        validations,
        ...recordDefaults,
        ...optionalBindings,
      ]
        .filter(Boolean)
        .join("\n");
      const prefix = headerStatements ? `${headerStatements}\n` : "";
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
        ctx.primitiveIdentifiers = prevPrimitiveIdentifiers;
        ctx.recordScopes.pop();
        ctx.parameterScopes.pop();
        ctx.variableTypeScopes.pop();
      }
    }
    return `${exp}${keyword} ${target}${typeAnn} = Effect.runPromise(${ctx.emitExpression(decl.init)});`;
  }

  let initExpr = ctx.emitExpression(decl.init);
  const bindingName =
    decl.id.kind === "Identifier" || decl.id.kind === "UpperIdentifier"
      ? decl.id.name
      : undefined;
  const fnBody =
    decl.init.kind === "FunctionExpression" ? decl.init.body : undefined;
  const finalExpr =
    fnBody?.kind === "BlockStatement" ? fnBody.finalExpression : fnBody;
  const returnsEffectCall =
    finalExpr?.kind === "CallExpression" &&
    finalExpr.callee.kind === "MemberExpression" &&
    finalExpr.callee.object.kind === "UpperIdentifier" &&
    finalExpr.callee.object.name === "Effect";
  const isEffectFunction =
    bindingName !== undefined &&
    decl.init.kind === "FunctionExpression" &&
    (decl.init.returnType?.kind === "EffectTypeNode" ||
      decl.init.body.kind === "EffectBlockExpression" ||
      (decl.init.body.kind === "BlockStatement" &&
        decl.init.body.finalExpression?.kind === "EffectBlockExpression") ||
      returnsEffectCall);
  if (isEffectFunction) {
    ctx.addEffectImport("Effect");
    initExpr = `Effect.fn(${JSON.stringify(bindingName)})(${initExpr})`;
  }
  return `${exp}${keyword} ${target}${typeAnn} = ${initExpr};`;
}

export function emitTopLevelDeclaration(
  ctx: DeclarationEmitterContext,
  decl: TopLevelDeclaration,
  isExport = false,
): string {
  switch (decl.kind) {
    case "ImportDeclaration":
      return renderImport(decl, undefined, ctx.modularEffectImports);
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
