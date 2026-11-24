import type {
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
  emitSchemaTypeField(typeNode: TypeNode, rawRecordFields?: boolean): string;
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

export function getRecordFieldInfoForBinding(
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
    ctx.variableTypeScopes.at(-1)?.set(idName, decl.typeAnnotation);
    if (isPrimitiveType(decl.typeAnnotation) || ctx.isPrimitive(decl.init)) {
      ctx.primitiveIdentifiers.add(idName);
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

  const exp = isExport ? "export " : "";
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

    const restField = decl.id.fields.find((f) => f.isRest);
    let restDestructure = "";
    const lines: string[] = [];
    if (restField) {
      const restName = restField.key.name;
      const nonRestFields = decl.id.fields.filter((f) => !f.isRest);
      const restTemp = `$funscriptRest${syntheticDestructureId++}`;
      restDestructure = `const { ${nonRestFields.map((f) => `${f.key.name}: _${f.key.name}`).join(", ")}, ...${restTemp} } = ${sourceRef};\n`;
      lines.push(`${exp}${keyword} ${restName} = ${restTemp};`);
    }

    for (const f of decl.id.fields) {
      if (f.isRest) continue;
      const varName = f.pattern ? ctx.emitBindingTarget(f.pattern) : f.key.name;
      const isOpt = fieldsInfo.get(f.key.name)?.optional === true;
      if (isOpt) {
        lines.push(
          `${exp}${keyword} ${varName} = Option.fromNullishOr(${sourceRef}.${f.key.name});`,
        );
      } else {
        lines.push(`${exp}${keyword} ${varName} = ${sourceRef}.${f.key.name};`);
      }
    }

    return `${initStatement}${restDestructure}${lines.join("\n")}`;
  }

  const target = ctx.emitBindingTarget(decl.id);

  if (decl.isJs) {
    ctx.addEffectImport("Effect");
    if (decl.init.kind === "FunctionExpression") {
      const fn = decl.init;
      const validations = fn.params
        .flatMap((p, index) => {
          if (p.optional) return [];
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
              `  ${paramName} = Schema.decodeUnknownSync(${ctx.emitSchemaTypeField(typeAnn, true)})(${paramName});`,
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
              : `  const ${decodedVar} = Schema.decodeUnknownSync(${ctx.emitSchemaTypeField(typeAnn, true)})(${rawParam});`;
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
        if (!p.optional) {
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
              const bindings: string[] = [];
              let syntheticDestructureId = 0;
              const unpackPatternFields = (
                pat: RecordPattern,
                basePath: string,
                fieldsMap?: Map<string, RecordFieldInfo>,
              ) => {
                const restField = pat.fields.find((f) => f.isRest);
                if (restField) {
                  const nonRest = pat.fields.filter((f) => !f.isRest);
                  const restTemp = `$funscriptRest${index}_${syntheticDestructureId++}`;
                  bindings.push(
                    `  const { ${nonRest.map((f) => `${f.key.name}: _${f.key.name}`).join(", ")}, ...${restTemp} } = ${basePath};`,
                  );
                  bindings.push(`  const ${restField.key.name} = ${restTemp};`);
                }
                for (const f of pat.fields) {
                  if (f.isRest) continue;
                  if (f.pattern?.kind === "WildcardPattern") continue;
                  const info = fieldsMap?.get(f.key.name);
                  const isOpt = info?.optional === true;
                  const fieldPath = `${basePath}.${f.key.name}`;
                  if (f.pattern?.kind === "RecordPattern") {
                    if (isOpt) {
                      const varName = ctx.emitBindingTarget(f.pattern);
                      bindings.push(
                        `  const ${varName} = Option.fromNullishOr(${fieldPath});`,
                      );
                    } else {
                      unpackPatternFields(f.pattern, fieldPath, info?.fields);
                    }
                  } else if (f.pattern?.kind === "ArrayPattern") {
                    const varName = ctx.emitBindingTarget(f.pattern);
                    if (isOpt) {
                      bindings.push(
                        `  const ${varName} = Option.fromNullishOr(${fieldPath});`,
                      );
                    } else {
                      bindings.push(`  const ${varName} = ${fieldPath};`);
                    }
                  } else {
                    const varName = f.pattern
                      ? ctx.emitBindingTarget(f.pattern)
                      : f.key.name;
                    if (isOpt) {
                      bindings.push(
                        `  const ${varName} = Option.fromNullishOr(${fieldPath});`,
                      );
                    } else {
                      bindings.push(`  const ${varName} = ${fieldPath};`);
                    }
                  }
                }
              };
              const sourceRef =
                decl.isJs && p.typeAnnotation
                  ? `$funscriptDecoded${index}`
                  : `$funscriptParam${index}`;
              unpackPatternFields(p.name, sourceRef, recFields);
              return bindings;
            }
          }
          return [];
        }
        ctx.addEffectImport("Option");
        const targetName = ctx.emitBindingTarget(p.name);
        const rawName = `$funscriptOptional${index}`;
        if (p.typeAnnotation && p.name.kind === "Identifier") {
          const typeAnn = p.typeAnnotation;
          if (
            typeAnn.kind === "TypeReferenceNode" &&
            ctx.recordContracts.has(typeAnn.name.name)
          ) {
            return [
              `  const ${targetName} = ${rawName} !== undefined ? Option.some(${typeAnn.name.name}DecodeChecked(${rawName})) : Option.none();`,
            ];
          }
          ctx.addEffectImport("Schema");
          return [
            `  const ${targetName} = ${rawName} !== undefined ? Option.some(Schema.decodeUnknownSync(${ctx.emitSchemaTypeField(p.typeAnnotation, true)})(${rawName})) : Option.none();`,
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
          let name = ctx.emitBindingTarget(p.name);
          if (p.optional) {
            name = `$funscriptOptional${index}`;
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
            if (decl.isJs || patternHasOptionalField(p.name, recFields)) {
              name = `$funscriptParam${index}`;
            }
          }
          const t = p.typeAnnotation
            ? `: ${ctx.emitTypeNode(p.typeAnnotation)}`
            : "";
          const def = p.defaultValue
            ? ` = ${ctx.emitExpression(p.defaultValue)}`
            : "";
          return `${rest}${name}${p.optional ? "?" : ""}${t}${def}`;
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
          paramScopeEntries.push([paramName, Boolean(p.optional)]);
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
            ) => {
              for (const f of pat.fields) {
                if (f.isRest) {
                  paramScopeEntries.push([f.key.name, false]);
                  varTypeEntries.push([f.key.name, undefined]);
                  continue;
                }
                const info = fieldsMap?.get(f.key.name);
                const isOpt = info?.optional === true;
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
                  collectParamsFromPattern(f.pattern, info?.fields, subType);
                } else if (f.pattern?.kind === "ArrayPattern") {
                  const elemType =
                    matchingFieldType?.kind === "ArrayTypeNode"
                      ? matchingFieldType.elementType
                      : undefined;
                  for (const el of f.pattern.elements) {
                    for (const n of collectBindingNames(el)) {
                      paramScopeEntries.push([n, false]);
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
                  if (info?.fields) {
                    recordScope.set(varName, info.fields);
                  }
                  if (matchingFieldType) {
                    varTypeEntries.push([varName, matchingFieldType]);
                  }
                }
              }
            };
            collectParamsFromPattern(p.name, recFields, recType);
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
        ctx.recordScopes.pop();
        ctx.parameterScopes.pop();
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
