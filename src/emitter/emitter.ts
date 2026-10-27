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
} from "../ast/types.js";

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

  constructor(private program: Program) {}

  public emit(): string {
    let bodyCode = "";

    for (const decl of this.program.body) {
      bodyCode += this.emitTopLevelDeclaration(decl) + "\n\n";
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

  private emitBindingDeclaration(decl: BindingDeclaration, isExport = false): string {
    const exp = isExport ? "export " : "";
    const keyword = decl.isMut ? "let" : "const";
    const typeAnn = decl.typeAnnotation ? `: ${this.emitTypeNode(decl.typeAnnotation)}` : "";
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

      // Check if stage has placeholder '_'
      if (s.kind === "CallExpression" && s.args.some((a) => a.kind === "Placeholder")) {
        const placeholderParam = "__p";
        const callArgs = s.args
          .map((a) => (a.kind === "Placeholder" ? placeholderParam : this.emitExpression(a)))
          .join(", ");
        return `(${placeholderParam}) => ${this.emitExpression(s.callee)}(${callArgs})`;
      }

      return this.emitExpression(s);
    });

    return `pipe(\n  ${emittedStages.join(",\n  ")}\n)`;
  }

  private emitBinaryExpression(expr: BinaryExpression): string {
    const left = this.emitExpression(expr.left);
    const right = this.emitExpression(expr.right);
    switch (expr.operator) {
      case "and":
        return `(${left} && ${right})`;
      case "or":
        return `(${left} || ${right})`;
      case "==":
        return `(${left} === ${right})`;
      case "!=":
        return `(${left} !== ${right})`;
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
    const params = expr.params
      .map((p) => {
        const typeAnn = p.typeAnnotation ? `: ${this.emitTypeNode(p.typeAnnotation)}` : "";
        return `${p.name.name}${typeAnn}`;
      })
      .join(", ");

    if (expr.body.kind === "BlockStatement") {
      return `(${params}) => {\n${this.emitFunctionBody(expr.body)}\n}`;
    }
    return `(${params}) => ${this.emitExpression(expr.body)}`;
  }

  private emitFunctionBody(body: FunctionBody): string {
    if (body.kind === "BlockStatement") {
      const stmts = body.statements.map((s) => "  " + this.emitStatement(s)).join("\n");
      const ret = `  return ${this.emitExpression(body.finalExpression)};`;
      return `${stmts}\n${ret}`;
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
    return `${this.emitExpression(stmt.expression)};`;
  }

  private emitMatchExpression(expr: MatchExpression): string {
    if (!expr.scrutinee) {
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

    // Scrutinee match -> ts-pattern
    this.needsTsPattern = true;
    let code = `match(${this.emitExpression(expr.scrutinee)})`;

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
        return "";
      })
      .join("\n");

    const ret = `    return ${this.emitExpression(expr.finalExpression)};`;
    return `Effect.gen(function* () {\n${statements}\n${ret}\n  })`;
  }

  private emitEffectCall(effectExpr: Expression): string {
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
            return `${name}: ${this.emitTypeNode(p.typeAnnotation)}`;
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
    }
  }
}
