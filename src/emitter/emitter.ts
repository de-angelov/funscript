import {
  Program,
  TopLevelDeclaration,
  ImportDeclaration,
  ExportDeclaration,
  BindingDeclaration,
  SchemaDeclaration,
  RecordSchema,
  TaggedUnionSchema,
  RefinementSchema,
  TypeSignatureSchema,
  ErrorDeclaration,
  ServiceDeclaration,
  Expression,
  Literal,
  NumberLiteral,
  StringLiteral,
  BooleanLiteral,
  Identifier,
  UpperIdentifier,
  Placeholder,
  TypedHole,
  PipelineExpression,
  BinaryExpression,
  UnaryExpression,
  CallExpression,
  MemberExpression,
  IndexExpression,
  RecordExpression,
  DotPathEntry,
  ArrayExpression,
  FunctionExpression,
  FunctionBody,
  BlockStatement,
  Statement,
  AssignmentStatement,
  ExpressionStatement,
  ReturnStatement,
  WhenStatement,
  MutBlockExpression,
  MatchExpression,
  MatchArm,
  Pattern,
  ConstructorPattern,
  RecordPattern,
  ArrayPattern,
  OrPattern,
  EffectBlockExpression,
  EffectStatement,
  EffectBindStatement,
  EffectDiscardStatement,
  TypeNode,
  TypeReferenceNode,
  FunctionTypeNode,
  EffectTypeNode,
  TsEscapeDeclaration,
  JsExpression,
  TsEscapeExpression,
  TsEscapeTypeNode,
  JSXElement,
  JSXSelfClosingElement,
  JSXOpeningElement,
  JSXClosingElement,
  JSXAttribute,
  JSXExpressionContainer,
  JSXText,
  JSXChild,
  JSXTagName,
} from "../ast/types.js";

const ARRAY_COMPANION_METHODS = new Set([
  "map",
  "filter",
  "reduce",
  "append",
  "prepend",
  "findFirst",
  "findLast",
  "filterMap",
  "take",
  "drop",
  "sortBy",
  "sortWith",
  "join",
  "length",
  "head",
  "tail",
  "reverse",
  "flatMap",
  "flatten",
  "zip",
  "every",
  "some",
  "compact",
  "dedupe",
  "partition",
  "groupBy",
]);

const EFFECT_COMPANION_METHODS = new Set([
  "orDie",
  "retry",
  "timeout",
  "catchTag",
  "catchAll",
  "catchSome",
  "provide",
  "provideService",
  "scoped",
  "forkScoped",
  "forever",
  "repeat",
  "tap",
]);

const OPTION_COMPANION_METHODS = new Set([
  "getOrElse",
  "getOrThrow",
  "isSome",
  "isNone",
  "orElse",
]);

const NUMBER_COMPANION_METHODS = new Set([
  "greaterThan",
  "greaterThanOrEqualTo",
  "lessThan",
  "lessThanOrEqualTo",
  "between",
  "clamp",
  "increment",
  "decrement",
]);

const EFFECT_BUILTIN_MODULES = new Set([
  "Console",
  "Effect",
  "Random",
  "Clock",
  "DateTime",
  "Schedule",
  "Array",
  "Option",
  "Schema",
  "Queue",
  "Ref",
  "Fiber",
  "Context",
  "Layer",
  "Math",
]);

export class Emitter {
  private effectImports = new Set<string>();
  private needsTsPattern = false;
  private needsMutative = false;
  private primitiveIdentifiers = new Set<string>();

  constructor(private program?: Program) {}

  public emit(): string {
    let bodyCode = "";

    if (this.program) {
      for (const decl of this.program.body) {
        bodyCode += this.emitTopLevelDeclaration(decl) + "\n\n";
      }
    }

    // Generate header imports
    let header = "";
    if (this.effectImports.size > 0) {
      const sorted = Array.from(this.effectImports).sort().join(", ");
      header += `import { ${sorted} } from "effect";\n`;
    }
    if (this.needsTsPattern) {
      header += `import { match, P } from "ts-pattern";\n`;
    }
    if (this.needsMutative) {
      header += `import { create } from "mutative";\n`;
    }

    if (header.length > 0) {
      header += "\n";
    }

    return header + bodyCode.trim() + "\n";
  }

  private emitTopLevelDeclaration(decl: TopLevelDeclaration, isExport = false): string {
    switch (decl.kind) {
      case "ImportDeclaration":
        return this.emitImportDeclaration(decl);
      case "ExportDeclaration":
        return this.emitTopLevelDeclaration(decl.declaration, true);
      case "SchemaDeclaration":
        return this.emitSchemaDeclaration(decl, isExport);
      case "ErrorDeclaration":
        return this.emitErrorDeclaration(decl, isExport);
      case "ServiceDeclaration":
        return this.emitServiceDeclaration(decl, isExport);
      case "BindingDeclaration":
        return this.emitBindingDeclaration(decl, isExport);
      case "WhenStatement":
        return this.emitWhenStatement(decl);
      case "TsEscapeDeclaration":
        return decl.code + "\n";
    }
  }

  private emitImportDeclaration(decl: ImportDeclaration): string {
    const specs = decl.specifiers
      .map((s) => {
        const typePrefix = s.isTypeOnly ? "type " : "";
        if (s.imported.name === s.local.name) {
          return `${typePrefix}${s.imported.name}`;
        }
        return `${typePrefix}${s.imported.name} as ${s.local.name}`;
      })
      .join(", ");
    return `import { ${specs} } from ${decl.source.raw};`;
  }

  private emitSchemaDeclaration(decl: SchemaDeclaration, isExport: boolean): string {
    const name = decl.id.name;
    const exp = isExport ? "export " : "";

    switch (decl.body.kind) {
      case "RecordSchema": {
        this.effectImports.add("Schema");
        const schemaFields = decl.body.fields
          .map((f) => `  ${f.name.name}: ${this.emitSchemaTypeField(f.typeAnnotation)}`)
          .join(",\n");
        return `${exp}const ${name} = Schema.Struct({\n${schemaFields}\n});\n${exp}type ${name} = typeof ${name}.Type;`;
      }
      case "TaggedUnionSchema": {
        this.effectImports.add("Data");
        const typeVariants = decl.body.variants
          .map((v) => {
            if (v.fields.length === 0) {
              return `  ${v.name.name}: {}`;
            }
            const fields = v.fields.map((f) => `readonly ${f.name.name}: ${this.emitTypeNode(f.typeAnnotation)}`).join("; ");
            return `  ${v.name.name}: { ${fields} }`;
          })
          .join(";\n");

        const constructors = decl.body.variants
          .map((v) => {
            if (v.fields.length === 0) {
              return `${exp}const ${v.name.name}: ${name} = $${name}.${v.name.name}();`;
            }
            const params = v.fields.map((f) => `${f.name.name}: ${this.emitTypeNode(f.typeAnnotation)}`).join(", ");
            const args = v.fields.map((f) => f.name.name).join(", ");
            return `${exp}const ${v.name.name} = (${params}): ${name} => $${name}.${v.name.name}({ ${args} });`;
          })
          .join("\n");

        return `${exp}type ${name} = Data.TaggedEnum<{\n${typeVariants}\n}>;\nconst $${name} = Data.taggedEnum<${name}>();\n${constructors}`;
      }
      case "RefinementSchema": {
        this.effectImports.add("pipe");
        return `${exp}const ${name} = pipe(${this.emitTypeNode(decl.body.baseType)}, ${this.emitExpression(decl.body.refinement)});\n${exp}type ${name} = typeof ${name}.Type;`;
      }
      case "TypeSignatureSchema": {
        return `${exp}type ${name} = ${this.emitTypeNode(decl.body.signature)};`;
      }
    }
  }

  private emitSchemaTypeField(typeNode: TypeNode): string {
    this.effectImports.add("Schema");
    if (typeNode.kind === "RecordTypeNode") {
      const inner = typeNode.fields
        .map((f) => `  ${f.name.name}: ${this.emitSchemaTypeField(f.typeAnnotation)}`)
        .join(",\n");
      return `Schema.Struct({\n${inner}\n})`;
    }
    if (typeNode.kind === "TypeReferenceNode") {
      const tName = typeNode.name.name;
      if (tName === "string") return "Schema.String";
      if (tName === "number") return "Schema.Number";
      if (tName === "boolean") return "Schema.Boolean";
      if (tName === "UUID") return "Schema.UUID";
      if (tName === "Option" && typeNode.typeArgs) {
        return `Schema.Option(${this.emitSchemaTypeField(typeNode.typeArgs[0])})`;
      }
      return tName;
    }
    return this.emitTypeNode(typeNode);
  }

  private emitErrorDeclaration(decl: ErrorDeclaration, isExport: boolean): string {
    this.effectImports.add("Schema");
    const name = decl.id.name;
    const exp = isExport ? "export " : "";
    const fields = decl.fields
      .map((f) => `  ${f.name.name}: ${this.emitSchemaTypeField(f.typeAnnotation)}`)
      .join(",\n");

    return `${exp}class ${name} extends Schema.TaggedError<${name}>()("${name}", {\n${fields}\n}) {}`;
  }

  private emitServiceDeclaration(decl: ServiceDeclaration, isExport: boolean): string {
    this.effectImports.add("Context");
    this.effectImports.add("Effect");
    const name = decl.id.name;
    const exp = isExport ? "export " : "";
    const tag = decl.customTag ? decl.customTag.raw : `"app/${name}"`;
    const members = decl.members
      .map((m) => `  readonly ${m.name.name}: ${this.emitTypeNode(m.signature)};`)
      .join("\n");

    return `${exp}class ${name} extends Context.Tag(${tag})<${name}, {\n${members}\n}>() {}`;
  }

  private isPrimitiveType(type?: TypeNode): boolean {
    if (!type) return false;
    if (type.kind === "TypeReferenceNode") {
      const name = type.name.name.toLowerCase();
      return name === "number" || name === "string" || name === "boolean" || name === "int" || name === "float";
    }
    return false;
  }

  private isPrimitive(expr: Expression): boolean {
    if (expr.kind === "NumberLiteral" || expr.kind === "StringLiteral" || expr.kind === "BooleanLiteral") {
      return true;
    }
    if (expr.kind === "UnaryExpression") {
      return true;
    }
    if (expr.kind === "BinaryExpression") {
      return true;
    }
    if (expr.kind === "Identifier" && this.primitiveIdentifiers.has(expr.name)) {
      return true;
    }
    return false;
  }

  private emitBindingDeclaration(decl: BindingDeclaration, isExport = false): string {
    if (this.isPrimitiveType(decl.typeAnnotation) || this.isPrimitive(decl.init)) {
      this.primitiveIdentifiers.add(decl.id.name);
    }
    const exp = isExport ? "export " : "";
    const keyword = decl.isMut ? "let" : "const";
    const typeAnn = decl.typeAnnotation ? `: ${this.emitTypeNode(decl.typeAnnotation)}` : "";

    if (decl.isJs) {
      this.effectImports.add("Effect");
      if (decl.init.kind === "FunctionExpression") {
        const fn = decl.init;
        for (const p of fn.params) {
          if (this.isPrimitiveType(p.typeAnnotation)) {
            this.primitiveIdentifiers.add(p.name.name);
          }
        }
        const params = fn.params
          .map((p) => {
            const t = p.typeAnnotation ? `: ${this.emitTypeNode(p.typeAnnotation)}` : "";
            return `${p.name.name}${t}`;
          })
          .join(", ");
        if (fn.body.kind === "BlockStatement") {
          const retExpr = fn.body.finalExpression ? this.emitExpression(fn.body.finalExpression) : "undefined";
          if (fn.body.statements.length === 0) {
            return `${exp}${keyword} ${decl.id.name} = (${params}) => Effect.runPromise(${retExpr});`;
          }
          const stmts = fn.body.statements.map((s) => "    " + this.emitStatement(s)).join("\n");
          return `${exp}${keyword} ${decl.id.name} = (${params}) => Effect.runPromise(Effect.gen(function* () {\n${stmts}\n    return ${retExpr};\n  }));`;
        }
        return `${exp}${keyword} ${decl.id.name} = (${params}) => Effect.runPromise(${this.emitExpression(fn.body)});`;
      }
      return `${exp}${keyword} ${decl.id.name}${typeAnn} = Effect.runPromise(${this.emitExpression(decl.init)});`;
    }

    return `${exp}${keyword} ${decl.id.name}${typeAnn} = ${this.emitExpression(decl.init)};`;
  }

  // --- Expressions ---

  public emitExpression(expr: Expression): string {
    switch (expr.kind) {
      case "NumberLiteral":
        return expr.raw;
      case "StringLiteral":
        return this.emitStringLiteral(expr);
      case "BooleanLiteral":
        return expr.value ? "true" : "false";
      case "Identifier":
      case "UpperIdentifier":
        return expr.name;
      case "Placeholder":
        return "__placeholder";
      case "TypedHole":
        return `(() => { throw new Error("Typed hole reached: ${expr.label || "???"}"); })()`;
      case "PipelineExpression":
        return this.emitPipelineExpression(expr);
      case "BinaryExpression":
        return this.emitBinaryExpression(expr);
      case "UnaryExpression":
        return this.emitUnaryExpression(expr);
      case "CallExpression":
        return `${this.emitExpression(expr.callee)}(${expr.args.map((a) => this.emitExpression(a)).join(", ")})`;
      case "MemberExpression":
        return `${this.emitExpression(expr.object)}.${expr.property.name}`;
      case "IndexExpression":
        return `${this.emitExpression(expr.object)}[${this.emitExpression(expr.index)}]`;
      case "RecordExpression":
        return this.emitRecordExpression(expr);
      case "ArrayExpression":
        return `[${expr.elements.map((e) => this.emitExpression(e)).join(", ")}]`;
      case "FunctionExpression":
        return this.emitFunctionExpression(expr);
      case "MutBlockExpression":
        this.needsMutative = true;
        return `create((${expr.draftParam.name}) => {\n${this.emitFunctionBody(expr.body)}\n})`;
      case "MatchExpression":
        return this.emitMatchExpression(expr);
      case "EffectBlockExpression":
        return this.emitEffectBlockExpression(expr);
      case "JSXElement":
        return this.emitJsxElement(expr);
      case "JSXSelfClosingElement":
        return this.emitJsxSelfClosingElement(expr);
      case "JsExpression":
        this.effectImports.add("Effect");
        return `Effect.tryPromise(() => ${this.emitExpression(expr.expression)})`;
      case "TsEscapeExpression":
        return expr.code;
    }
  }

  private emitStringLiteral(lit: StringLiteral): string {
    if (lit.parts.length === 1 && lit.parts[0].kind === "StringRawPart") {
      return JSON.stringify(lit.parts[0].value);
    }
    const template = lit.parts
      .map((p) => {
        if (p.kind === "StringRawPart") return p.value.replace(/`/g, "\\`").replace(/\${/g, "\\${");
        return `\${${this.emitExpression(p.expression)}}`;
      })
      .join("");
    return `\`${template}\``;
  }

  private emitPipelineExpression(expr: PipelineExpression): string {
    this.effectImports.add("pipe");

    // Flatten left-nested pipelines: a |> b |> c
    const stages: Expression[] = [];
    let curr: Expression = expr;

    while (curr.kind === "PipelineExpression") {
      stages.unshift(curr.right);
      curr = curr.left;
    }
    stages.unshift(curr);

    const emittedStages = stages.map((s, idx) => {
      if (idx === 0) return this.emitExpression(s);

      // Auto-namespace resolution for pipeline stage callee
      const resolvedStage = this.resolvePipelineStage(s);

      // Check if stage has placeholder '_'
      if (resolvedStage.kind === "CallExpression" && resolvedStage.args.some((a) => a.kind === "Placeholder")) {
        const placeholderParam = "__p";
        const callArgs = resolvedStage.args
          .map((a) => (a.kind === "Placeholder" ? placeholderParam : this.emitExpression(a)))
          .join(", ");
        return `(${placeholderParam}) => ${this.emitExpression(resolvedStage.callee)}(${callArgs})`;
      }

      return this.emitExpression(resolvedStage);
    });

    return `pipe(\n  ${emittedStages.join(",\n  ")}\n)`;
  }

  private resolvePipelineStage(stage: Expression): Expression {
    // 0. 'js' pipeline stage: eff |> js -> pipe(eff, Effect.runPromise)
    if (stage.kind === "Identifier" && stage.name === "js") {
      this.effectImports.add("Effect");
      return {
        kind: "MemberExpression",
        object: { kind: "UpperIdentifier", name: "Effect", span: stage.span },
        property: { kind: "Identifier", name: "runPromise", span: stage.span },
        span: stage.span,
      };
    }

    // 1. Bare CallExpression: reduce(acc, f), map(f), lessThanOrEqualTo(0), orDie()
    if (stage.kind === "CallExpression" && stage.callee.kind === "Identifier") {
      const name = stage.callee.name;
      const companion = this.getCompanionModule(name);
      if (companion) {
        this.effectImports.add(companion);
        return {
          ...stage,
          callee: {
            kind: "MemberExpression",
            object: { kind: "UpperIdentifier", name: companion, span: stage.callee.span },
            property: stage.callee,
            span: stage.callee.span,
          },
        };
      }
    }

    // 1b. CallExpression with MemberExpression companion call: Array.map(f), Option.getOrElse(f), etc.
    if (stage.kind === "CallExpression" && stage.callee.kind === "MemberExpression") {
      const obj = stage.callee.object;
      const prop = stage.callee.property;
      if (obj.kind === "UpperIdentifier") {
        const companion = this.getCompanionModule(prop.name);
        if (companion === obj.name) {
          this.effectImports.add(companion);
        }
      }
    }

    // 2. Bare Identifier in pipeline: orDie, length, etc.
    if (stage.kind === "Identifier") {
      const name = stage.name;
      const companion = this.getCompanionModule(name);
      if (companion) {
        this.effectImports.add(companion);
        return {
          kind: "MemberExpression",
          object: { kind: "UpperIdentifier", name: companion, span: stage.span },
          property: stage,
          span: stage.span,
        };
      }
    }

    return stage;
  }

  private getCompanionModule(name: string): "Array" | "Effect" | "Option" | "Number" | undefined {
    if (ARRAY_COMPANION_METHODS.has(name)) return "Array";
    if (EFFECT_COMPANION_METHODS.has(name)) return "Effect";
    if (OPTION_COMPANION_METHODS.has(name)) return "Option";
    if (NUMBER_COMPANION_METHODS.has(name)) return "Number";
    return undefined;
  }

  private emitBinaryExpression(expr: BinaryExpression): string {
    const left = this.emitExpression(expr.left);
    const right = this.emitExpression(expr.right);
    switch (expr.operator) {
      case "and":
        return `(${left} && ${right})`;
      case "or":
        return `(${left} || ${right})`;
      case "===":
      case "!==":
        if (this.isPrimitive(expr.left) || this.isPrimitive(expr.right)) {
          throw new Error(
            `Reference identity operator '${expr.operator}' cannot be used with primitive types; use '==' or '!=' for structural/value equality`
          );
        }
        return `(${left} ${expr.operator} ${right})`;
      case "==":
        if (this.isPrimitive(expr.left) || this.isPrimitive(expr.right)) {
          return `(${left} === ${right})`;
        }
        this.effectImports.add("Equal");
        return `Equal.equals(${left}, ${right})`;
      case "!=":
        if (this.isPrimitive(expr.left) || this.isPrimitive(expr.right)) {
          return `(${left} !== ${right})`;
        }
        this.effectImports.add("Equal");
        return `(!Equal.equals(${left}, ${right}))`;
      default:
        return `(${left} ${expr.operator} ${right})`;
    }
  }

  private emitUnaryExpression(expr: UnaryExpression): string {
    const arg = this.emitExpression(expr.argument);
    if (expr.operator === "not") return `(!${arg})`;
    return `(-${arg})`;
  }

  private emitRecordExpression(expr: RecordExpression): string {
    const hasDotPaths = expr.entries.some((e) => e.kind === "DotPathEntry");
    if (hasDotPaths) {
      // Lower to Mutative create
      this.needsMutative = true;
      const baseSpread = expr.entries.find((e) => e.kind === "SpreadEntry") as any;
      const base = baseSpread ? this.emitExpression(baseSpread.argument) : "{}";
      const mutations = expr.entries
        .filter((e) => e.kind !== "SpreadEntry")
        .map((e) => {
          if (e.kind === "DotPathEntry") {
            return `  draft.${e.path.map((p) => p.name).join(".")} = ${this.emitExpression(e.value)};`;
          }
          if (e.kind === "FieldEntry") {
            return `  draft.${e.key.name} = ${this.emitExpression(e.value)};`;
          }
          return `  draft.${e.key.name} = ${e.key.name};`;
        })
        .join("\n");
      return `create(${base}, (draft) => {\n${mutations}\n})`;
    }

    const entries = expr.entries
      .map((e) => {
        if (e.kind === "SpreadEntry") return `...${this.emitExpression(e.argument)}`;
        if (e.kind === "FieldEntry") return `${e.key.name}: ${this.emitExpression(e.value)}`;
        if (e.kind === "ShorthandEntry") return e.key.name;
        return "";
      })
      .join(", ");
    return `{ ${entries} }`;
  }

  private emitFunctionExpression(expr: FunctionExpression): string {
    for (const p of expr.params) {
      if (this.isPrimitiveType(p.typeAnnotation)) {
        this.primitiveIdentifiers.add(p.name.name);
      }
    }
    const params = expr.params
      .map((p) => {
        const typeAnn = p.typeAnnotation ? `: ${this.emitTypeNode(p.typeAnnotation)}` : "";
        return `${p.name.name}${typeAnn}`;
      })
      .join(", ");
    const retType = expr.returnType ? `: ${this.emitTypeNode(expr.returnType)}` : "";

    if (expr.body.kind === "BlockStatement") {
      return `(${params})${retType} => {\n${this.emitFunctionBody(expr.body)}\n}`;
    }
    return `(${params})${retType} => ${this.emitExpression(expr.body)}`;
  }

  private emitFunctionBody(body: FunctionBody): string {
    if (body.kind === "BlockStatement") {
      const stmts = body.statements.map((s) => "  " + this.emitStatement(s)).join("\n");
      const ret = body.finalExpression ? `  return ${this.emitExpression(body.finalExpression)};` : "";
      if (stmts && ret) return `${stmts}\n${ret}`;
      if (stmts) return stmts;
      if (ret) return ret;
      return "";
    }
    return `  return ${this.emitExpression(body)};`;
  }

  private emitStatement(stmt: Statement): string {
    if (stmt.kind === "BindingDeclaration") {
      return this.emitBindingDeclaration(stmt);
    }
    if (stmt.kind === "AssignmentStatement") {
      const target = stmt.target.kind === "Identifier" ? stmt.target.name : stmt.target.path.map((p) => p.name).join(".");
      return `${target} = ${this.emitExpression(stmt.value)};`;
    }
    if (stmt.kind === "ReturnStatement") {
      const arg = this.emitExpression(stmt.argument);
      if (arg.startsWith("(") && arg.endsWith(")")) {
        return `return ${arg};`;
      }
      return `return (${arg});`;
    }
    if (stmt.kind === "WhenStatement") {
      return this.emitWhenStatement(stmt);
    }
    return `${this.emitExpression(stmt.expression)};`;
  }

  private emitWhenStatement(stmt: WhenStatement): string {
    const cond = this.emitExpression(stmt.condition);
    if (stmt.isEarlyReturn) {
      return `if (${cond}) return ${this.emitExpression(stmt.consequent as Expression)};`;
    }
    const body = stmt.consequent as BlockStatement;
    const stmts = body.statements.map((s) => "  " + this.emitStatement(s)).join("\n");
    const ret = body.finalExpression && (body.finalExpression.kind !== "Identifier" || (body.finalExpression as Identifier).name !== "_error")
      ? `  ${this.emitExpression(body.finalExpression)};`
      : "";
    const allStmts = [stmts, ret].filter(Boolean).join("\n");
    return `if (${cond}) {\n${allStmts}\n}`;
  }

  private emitMatchExpression(expr: MatchExpression): string {
    if (!expr.scrutinee && !expr.isPipeline) {
      // Subjectless boolean match -> ? : ternary or if / else
      let code = "";
      for (let i = 0; i < expr.arms.length; i++) {
        const arm = expr.arms[i];
        const isDefault = arm.pattern.kind === "WildcardPattern";
        const body = arm.body.kind === "BlockStatement" ? `(() => {\n${this.emitFunctionBody(arm.body)}\n})()` : this.emitExpression(arm.body);

        if (isDefault || i === expr.arms.length - 1) {
          code += body;
          break;
        } else {
          const cond = this.emitPatternAsCondition(arm.pattern);
          code += `${cond} ? ${body} : `;
        }
      }
      return `(${code})`;
    }

    // Scrutinee match or pipeline match -> ts-pattern
    this.needsTsPattern = true;
    const isPipe = Boolean(expr.isPipeline);
    let code = isPipe ? `(($v) => match($v)` : `match(${this.emitExpression(expr.scrutinee!)})`;

    for (const arm of expr.arms) {
      if (arm.pattern.kind === "WildcardPattern") {
        const body = this.emitArmHandler(arm.body, arm.pattern);
        code += `\n  .otherwise(${body})`;
      } else {
        const pat = this.emitPattern(arm.pattern);
        const body = this.emitArmHandler(arm.body, arm.pattern);
        if (arm.guard) {
          const vars = this.collectPatternVariables(arm.pattern);
          let guardFn: string;
          if (vars.length > 0) {
            guardFn = `($matched) => {\n    const { _tag: _, ...__fields } = $matched as any;\n    const [${vars.join(", ")}] = Object.values(__fields) as any[];\n    return ${this.emitExpression(arm.guard)};\n  }`;
          } else {
            guardFn = `() => ${this.emitExpression(arm.guard)}`;
          }
          code += `\n  .with(${pat}, ${guardFn}, ${body})`;
        } else {
          code += `\n  .with(${pat}, ${body})`;
        }
      }
    }

    if (!expr.arms.some((a) => a.pattern.kind === "WildcardPattern")) {
      code += `\n  .exhaustive()`;
    }

    if (isPipe) {
      code += `)`;
    }

    return code;
  }

  private emitPatternAsCondition(pattern: Pattern): string {
    if (pattern.kind === "LiteralPattern") {
      if ((pattern.literal as any).rawExpr) {
        return this.emitExpression((pattern.literal as any).rawExpr);
      }
      if (pattern.literal.kind === "BooleanLiteral") {
        return pattern.literal.value ? "true" : "false";
      }
      if (pattern.literal.kind === "NumberLiteral") {
        return `${pattern.literal.value}`;
      }
      return this.emitStringLiteral(pattern.literal);
    }
    return "true";
  }

  private emitPattern(pat: Pattern): string {
    if (pat.kind === "WildcardPattern") return "P._";
    if (pat.kind === "LiteralPattern") {
      if (pat.literal.kind === "BooleanLiteral") return pat.literal.value ? "true" : "false";
      if (pat.literal.kind === "NumberLiteral") return `${pat.literal.value}`;
      return this.emitStringLiteral(pat.literal);
    }
    if (pat.kind === "VariablePattern") return `P.select("${pat.name.name}")`;
    if (pat.kind === "ConstructorPattern") {
      if (pat.args.length === 0) {
        return `{ _tag: "${pat.constructorName.name}" }`;
      }
      // Tagged union positional pattern matches fields
      return `{ _tag: "${pat.constructorName.name}" }`;
    }
    if (pat.kind === "OrPattern") {
      const sub = pat.patterns.map((p) => this.emitPattern(p)).join(", ");
      return `P.union(${sub})`;
    }
    if (pat.kind === "RecordPattern") {
      const fields = pat.fields
        .map((f) => (f.pattern ? `${f.key.name}: ${this.emitPattern(f.pattern)}` : `${f.key.name}: P._`))
        .join(", ");
      return `{ ${fields} }`;
    }
    if (pat.kind === "ArrayPattern") {
      const elements = pat.elements.map((e) => this.emitPattern(e)).join(", ");
      return `[${elements}]`;
    }
    return "P._";
  }

  private emitArmHandler(body: FunctionBody, pat?: Pattern): string {
    const vars = pat ? this.collectPatternVariables(pat) : [];
    if (vars.length > 0) {
      const unpack = `const { _tag: _, ...__fields } = $matched as any;\n    const [${vars.join(", ")}] = Object.values(__fields) as any[];`;
      if (body.kind === "BlockStatement") {
        return `($matched) => {\n    ${unpack}\n${this.emitFunctionBody(body)}\n  }`;
      }
      return `($matched) => {\n    ${unpack}\n    return ${this.emitExpression(body)};\n  }`;
    }

    if (body.kind === "BlockStatement") {
      return `() => {\n${this.emitFunctionBody(body)}\n}`;
    }
    return `() => ${this.emitExpression(body)}`;
  }

  private collectPatternVariables(pat: Pattern): string[] {
    if (pat.kind === "VariablePattern") return [pat.name.name];
    if (pat.kind === "ConstructorPattern") {
      const vars: string[] = [];
      for (const a of pat.args) {
        vars.push(...this.collectPatternVariables(a));
      }
      return vars;
    }
    if (pat.kind === "OrPattern") {
      return pat.patterns.length > 0 ? this.collectPatternVariables(pat.patterns[0]) : [];
    }
    if (pat.kind === "RecordPattern") {
      const vars: string[] = [];
      for (const f of pat.fields) {
        if (!f.pattern) {
          vars.push(f.key.name);
        } else {
          vars.push(...this.collectPatternVariables(f.pattern));
        }
      }
      return vars;
    }
    if (pat.kind === "ArrayPattern") {
      const vars: string[] = [];
      for (const el of pat.elements) {
        vars.push(...this.collectPatternVariables(el));
      }
      return vars;
    }
    return [];
  }

  private emitEffectBlockExpression(expr: EffectBlockExpression): string {
    this.effectImports.add("Effect");
    const statements = expr.body
      .map((s) => {
        if (s.kind === "EffectBindStatement") {
          return `    const ${s.id.name} = yield* ${this.emitEffectCall(s.effect)};`;
        }
        if (s.kind === "EffectDiscardStatement") {
          return `    yield* ${this.emitEffectCall(s.effect)};`;
        }
        if (s.kind === "BindingDeclaration") {
          return `    ${this.emitBindingDeclaration(s)}`;
        }
        if (s.kind === "WhenStatement") {
          return `    ${this.emitWhenStatement(s)}`;
        }
        return "";
      })
      .join("\n");

    const ret = `    return ${this.emitExpression(expr.finalExpression)};`;
    return `Effect.gen(function* () {\n${statements}\n${ret}\n  })`;
  }

  private emitEffectCall(effectExpr: Expression): string {
    if (effectExpr.kind === "JsExpression") {
      this.effectImports.add("Effect");
      return `Effect.tryPromise(() => ${this.emitExpression(effectExpr.expression)})`;
    }
    // Check if this is a direct service call: Service.method(args)
    if (effectExpr.kind === "CallExpression" && effectExpr.callee.kind === "MemberExpression") {
      const obj = effectExpr.callee.object;
      if (obj.kind === "UpperIdentifier") {
        if (EFFECT_BUILTIN_MODULES.has(obj.name)) {
          return `${obj.name}.${effectExpr.callee.property.name}(${effectExpr.args.map((a) => this.emitExpression(a)).join(", ")})`;
        }
        // Direct Service Call: Service.method(...) -> (yield* Service).method(...)
        return `(yield* ${obj.name}).${effectExpr.callee.property.name}(${effectExpr.args.map((a) => this.emitExpression(a)).join(", ")})`;
      }
    }
    return this.emitExpression(effectExpr);
  }

  // --- Types ---

  private emitTypeNode(node: TypeNode): string {
    switch (node.kind) {
      case "TypeReferenceNode": {
        const name = node.name.name;
        if (node.typeArgs && node.typeArgs.length > 0) {
          return `${name}<${node.typeArgs.map((t) => this.emitTypeNode(t)).join(", ")}>`;
        }
        return name;
      }
      case "FunctionTypeNode": {
        const params = node.params
          .map((p) => {
            const name = p.name ? p.name.name : "_";
            return p.typeAnnotation ? `${name}: ${this.emitTypeNode(p.typeAnnotation)}` : name;
          })
          .join(", ");
        return `(${params}) => ${this.emitTypeNode(node.returnType)}`;
      }
      case "EffectTypeNode": {
        this.effectImports.add("Effect");
        const succ = this.emitTypeNode(node.success);
        const err = node.error ? this.emitTypeNode(node.error) : "never";
        const req = node.requirements ? this.emitTypeNode(node.requirements) : "never";
        return `Effect.Effect<${succ}, ${err}, ${req}>`;
      }
      case "RecordTypeNode": {
        const fields = node.fields.map((f) => `readonly ${f.name.name}: ${this.emitTypeNode(f.typeAnnotation)}`).join("; ");
        return `{ ${fields} }`;
      }
      case "ArrayTypeNode":
        return `ReadonlyArray<${this.emitTypeNode(node.elementType)}>`;
      case "UnionTypeNode":
        return node.types.map((t) => this.emitTypeNode(t)).join(" | ");
      case "TsEscapeTypeNode":
        return node.code;
    }
  }

  // --- JSX ---

  public emitJsxElement(el: JSXElement): string {
    const tagName = this.emitJsxTagName(el.openingElement.name);
    const attrs = el.openingElement.attributes.map((a) => this.emitJsxAttribute(a)).join(" ");
    const attrsStr = attrs.length > 0 ? ` ${attrs}` : "";
    const openTag = tagName === "" ? "<>" : `<${tagName}${attrsStr}>`;
    const closeTag = tagName === "" ? "</>" : `</${tagName}>`;
    const childrenStr = el.children.map((c) => this.emitJsxChild(c)).join("");
    return `${openTag}${childrenStr}${closeTag}`;
  }

  public emitJsxSelfClosingElement(el: JSXSelfClosingElement): string {
    const tagName = this.emitJsxTagName(el.name);
    const attrs = el.attributes.map((a) => this.emitJsxAttribute(a)).join(" ");
    const attrsStr = attrs.length > 0 ? ` ${attrs}` : "";
    if (tagName === "") {
      return `<${attrsStr} />`;
    }
    return `<${tagName}${attrsStr} />`;
  }

  public emitJsxTagName(name: JSXTagName): string {
    switch (name.kind) {
      case "Identifier":
      case "UpperIdentifier":
        return name.name;
      case "MemberExpression":
        return `${this.emitJsxTagName(name.object as JSXTagName)}.${name.property.name}`;
      default:
        return "";
    }
  }

  public emitJsxAttribute(attr: JSXAttribute): string {
    const name = attr.name.name;
    if (attr.value === undefined) {
      return name;
    }
    if (attr.value.kind === "StringLiteral") {
      const isSimple = attr.value.parts.every((p) => p.kind === "StringRawPart");
      if (isSimple) {
        const rawVal = attr.value.parts.map((p) => (p as any).value).join("");
        return `${name}=${JSON.stringify(rawVal)}`;
      }
      return `${name}={${this.emitStringLiteral(attr.value)}}`;
    }
    if (attr.value.kind === "JSXExpressionContainer") {
      return `${name}={${this.emitExpression(attr.value.expression)}}`;
    }
    return `${name}={${this.emitExpression(attr.value)}}`;
  }

  public emitJsxExpressionContainer(container: JSXExpressionContainer): string {
    return `{${this.emitExpression(container.expression)}}`;
  }

  public emitJsxText(text: JSXText): string {
    return text.value;
  }

  public emitJsxChild(child: JSXChild): string {
    switch (child.kind) {
      case "JSXText":
        return this.emitJsxText(child);
      case "JSXExpressionContainer":
        return this.emitJsxExpressionContainer(child);
      case "JSXElement":
        return this.emitJsxElement(child);
      case "JSXSelfClosingElement":
        return this.emitJsxSelfClosingElement(child);
    }
  }
}
