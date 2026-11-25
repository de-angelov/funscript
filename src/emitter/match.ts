import type {
  BindingTarget,
  BooleanLiteral,
  ConstructorPattern,
  Expression,
  FunctionBody,
  LiteralPattern,
  MatchArm,
  MatchExpression,
  Pattern,
  RecordPattern,
  RecordTypeNode,
  StringLiteral,
  TypeNode,
} from "../ast/types.js";
import { FunScriptError } from "../errors.js";
import { patternHasOptionalField } from "./declarations.js";

const JS_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
]);

export type RecordFieldInfo = {
  optional: boolean;
  defaultBinding?: string;
  fields?: Map<string, RecordFieldInfo>;
};

interface MatchEmitterContext {
  emitExpression(expression: Expression): string;
  emitFunctionBody(body: FunctionBody): string;
  emitArrowExpression(expression: Expression): string;
  emitBindingTarget(target: BindingTarget | Pattern): string;
  emitStringLiteral(literal: StringLiteral): string;
  recordField(expression: Expression): RecordFieldInfo | undefined;
  recordFields?(name: string): Map<string, RecordFieldInfo> | undefined;
  getRecordTypeNode?(name: string): RecordTypeNode | undefined;
  getVariantFields?(name: string): string[] | undefined;
  recordContracts?: Map<string, RecordTypeNode>;
  getTypeNodeForExpression?(expression: Expression): TypeNode | undefined;
  isOptionalParameter(name: string): boolean;
  isOptionalValue(expression: Expression): boolean;
  requireTsPattern(): void;
  addEffectImport?(name: string): void;
  enterOptionalPayload(
    name: string,
    fields: Map<string, RecordFieldInfo>,
    arm: MatchArm,
    payloadType?: TypeNode,
  ): void;
  leaveOptionalPayload(): void;
  enterOptionalRecordPattern?(
    pattern: RecordPattern,
    fields: Map<string, RecordFieldInfo>,
    arm: MatchArm,
    payloadType?: TypeNode,
  ): void;
  leaveOptionalRecordPattern?(): void;
}

/** Renders match expressions and their patterns using the enclosing emitter's scope. */
export class MatchEmitter {
  constructor(private readonly context: MatchEmitterContext) {}

  public emitMatchExpression(expr: MatchExpression): string {
    if (!expr.scrutinee && !expr.isPipeline) {
      // Subjectless boolean match => ? : ternary or if / else
      let code = "";
      for (let i = 0; i < expr.arms.length; i++) {
        const arm = expr.arms[i];
        const isDefault = arm.pattern.kind === "WildcardPattern";
        const body =
          arm.body.kind === "BlockStatement"
            ? `(() => {\n${this.context.emitFunctionBody(arm.body)}\n})()`
            : this.context.emitExpression(arm.body);

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

    // Scrutinee match or pipeline match => ts-pattern
    this.context.requireTsPattern();
    const isPipe = Boolean(expr.isPipeline);
    let code = isPipe
      ? `(($v) => match($v)`
      : `match(${this.context.emitExpression(expr.scrutinee!)})`;
    const optionalRecord = expr.scrutinee
      ? this.context.recordField(expr.scrutinee)
      : undefined;
    const payloadFields = optionalRecord?.optional
      ? optionalRecord.fields
      : undefined;
    const isOptional = expr.scrutinee
      ? this.context.isOptionalValue(expr.scrutinee)
      : false;

    const hasWildcard = expr.arms.some(
      (a) => a.pattern.kind === "WildcardPattern",
    );
    const lastArm = expr.arms[expr.arms.length - 1];
    const isBooleanLiteralPattern = (
      p: Pattern,
    ): p is LiteralPattern & { literal: BooleanLiteral } =>
      p.kind === "LiteralPattern" && p.literal.kind === "BooleanLiteral";
    const lastArmIsUnguardedBool = Boolean(
      lastArm && !lastArm.guard && isBooleanLiteralPattern(lastArm.pattern),
    );
    const oppositeBoolValue =
      lastArmIsUnguardedBool &&
      lastArm &&
      isBooleanLiteralPattern(lastArm.pattern)
        ? !lastArm.pattern.literal.value
        : undefined;
    const hasOppositeUnguarded =
      oppositeBoolValue !== undefined &&
      expr.arms
        .slice(0, -1)
        .some(
          (a) =>
            !a.guard &&
            isBooleanLiteralPattern(a.pattern) &&
            a.pattern.literal.value === oppositeBoolValue,
        );
    const isExhaustiveBooleanMatch =
      !hasWildcard && lastArmIsUnguardedBool && hasOppositeUnguarded;

    for (let i = 0; i < expr.arms.length; i++) {
      const arm = expr.arms[i];
      const isLastArm = i === expr.arms.length - 1;
      let payloadName: string | undefined;
      let recordPattern: RecordPattern | undefined;
      if (payloadFields) {
        const pat = arm.pattern;
        if (
          pat.kind === "ConstructorPattern" &&
          pat.constructorName.name === "Some" &&
          pat.args.length === 1 &&
          pat.args[0].kind === "VariablePattern"
        ) {
          payloadName = pat.args[0].name.name;
        } else if (
          pat.kind === "ConstructorPattern" &&
          pat.constructorName.name === "Some" &&
          pat.args.length === 1 &&
          pat.args[0].kind === "RecordPattern"
        ) {
          recordPattern = pat.args[0];
        } else if (
          pat.kind === "ConstructorPattern" &&
          pat.constructorName.name === "Some" &&
          pat.args.length === 1
        ) {
          // Allowed: Some(...) with any pattern
        } else if (!(
          pat.kind === "WildcardPattern" ||
          (pat.kind === "ConstructorPattern" &&
            pat.constructorName.name === "None" &&
            pat.args.length === 0)
        )) {
          throw new FunScriptError(
            "Match an optional record with Some(name), Some({...}), None, or _",
            pat.span,
          );
        }
      }
      let payloadType: TypeNode | undefined;
      if (expr.scrutinee && this.context.getTypeNodeForExpression) {
        const scrutineeType = this.context.getTypeNodeForExpression(
          expr.scrutinee,
        );
        if (
          scrutineeType?.kind === "TypeReferenceNode" &&
          scrutineeType.name.name === "Option" &&
          scrutineeType.typeArgs?.length === 1
        ) {
          payloadType = scrutineeType.typeArgs[0];
        } else {
          payloadType = scrutineeType;
        }
      }
      if (payloadName && payloadFields) {
        this.context.enterOptionalPayload(
          payloadName,
          payloadFields,
          arm,
          payloadType,
        );
      } else if (recordPattern && payloadFields) {
        this.context.enterOptionalRecordPattern?.(
          recordPattern,
          payloadFields,
          arm,
          payloadType,
        );
      }
      try {
        if (
          arm.pattern.kind === "WildcardPattern" ||
          (isExhaustiveBooleanMatch && isLastArm)
        ) {
          const body = this.emitArmHandler(
            arm.body,
            arm.pattern,
            expr.scrutinee,
            payloadFields,
          );
          code += `\n  .otherwise(${body})`;
        } else {
          const pat = this.emitPattern(arm.pattern);
          const body = this.emitArmHandler(
            arm.body,
            arm.pattern,
            expr.scrutinee,
            payloadFields,
          );
          if (arm.guard) {
            let guardFn: string;
            if (arm.pattern.kind === "RecordPattern") {
              const destructParts = this.collectRecordDestructuring(
                arm.pattern,
              );
              const scrutineeName =
                expr.scrutinee?.kind === "Identifier"
                  ? expr.scrutinee.name
                  : undefined;
              if (destructParts.length > 0) {
                const lines = [
                  ...(scrutineeName
                    ? [`const ${scrutineeName} = $matched;`]
                    : []),
                  `const { ${destructParts.join(", ")} } = $matched;`,
                  `return ${this.context.emitExpression(arm.guard)};`,
                ];
                guardFn = `($matched) => {\n    ${lines.join("\n    ")}\n  }`;
              } else if (scrutineeName) {
                guardFn = `(${scrutineeName}) => ${this.context.emitExpression(arm.guard)}`;
              } else {
                guardFn = `($matched) => ${this.context.emitExpression(arm.guard)}`;
              }
            } else if (
              arm.pattern.kind === "OrPattern" &&
              arm.pattern.patterns.every((p) => p.kind === "RecordPattern")
            ) {
              const scrutineeName =
                expr.scrutinee?.kind === "Identifier"
                  ? expr.scrutinee.name
                  : undefined;
              if (scrutineeName) {
                guardFn = `(${scrutineeName}) => ${this.context.emitExpression(arm.guard)}`;
              } else {
                guardFn = `($matched) => ${this.context.emitExpression(arm.guard)}`;
              }
            } else {
              const vars = this.collectPatternVariables(arm.pattern);
              if (vars.length > 0) {
                const some =
                  arm.pattern.kind === "ConstructorPattern" &&
                  arm.pattern.constructorName.name === "Some" &&
                  arm.pattern.args.length === 1 &&
                  (arm.pattern.args[0].kind === "VariablePattern" ||
                    arm.pattern.args[0].kind === "ArrayPattern");
                const someRecord =
                  arm.pattern.kind === "ConstructorPattern" &&
                  arm.pattern.constructorName.name === "Some" &&
                  arm.pattern.args.length === 1 &&
                  arm.pattern.args[0].kind === "RecordPattern";
                const directOptional =
                  expr.scrutinee?.kind === "Identifier" &&
                  this.context.isOptionalParameter(expr.scrutinee.name);
                let unpack: string;
                if (someRecord) {
                  unpack = this.emitSomeRecordUnpack(
                    (arm.pattern as ConstructorPattern)
                      .args[0] as RecordPattern,
                    payloadFields,
                    directOptional || isOptional,
                  );
                } else if (arm.pattern.kind === "VariablePattern") {
                  unpack = `const ${vars[0]} = $matched;`;
                } else if (some) {
                  const target = this.context.emitBindingTarget(
                    (arm.pattern as ConstructorPattern).args[0],
                  );
                  unpack =
                    directOptional || isOptional
                      ? `const { value: ${target} } = $matched;`
                      : `const { value: ${target} } = $matched as unknown as { value: typeof $matched extends import("effect").Option.Some<infer V> ? V : any };`;
                } else if (
                  arm.pattern.kind === "ConstructorPattern" &&
                  JS_ERROR_NAMES.has(arm.pattern.constructorName.name)
                ) {
                  unpack = `const { ${vars.join(", ")} } = $matched as any;`;
                } else {
                  const fieldNames =
                    arm.pattern.kind === "ConstructorPattern" &&
                    arm.pattern.constructorName.name !== "Some"
                      ? this.context.getVariantFields?.(
                          arm.pattern.constructorName.name,
                        )
                      : undefined;
                  if (
                    arm.pattern.kind === "ConstructorPattern" &&
                    fieldNames &&
                    fieldNames.length === arm.pattern.args.length
                  ) {
                    const parts: string[] = [];
                    for (let i = 0; i < fieldNames.length; i++) {
                      const arg = arm.pattern.args[i];
                      if (arg.kind === "VariablePattern") {
                        parts.push(`${fieldNames[i]}: ${arg.name.name}`);
                      }
                    }
                    unpack = `const { ${parts.join(", ")} } = $matched as any;`;
                  } else {
                    unpack = `const { _tag: _, ...__fields } = $matched as any;\n    const [${vars.join(", ")}] = Object.values(__fields) as any[];`;
                  }
                }
                guardFn = `($matched) => {\n    ${unpack}\n    return ${this.context.emitExpression(arm.guard)};\n  }`;
              } else {
                guardFn = `() => ${this.context.emitExpression(arm.guard)}`;
              }
            }
            code += `\n  .with(${pat}, ${guardFn}, ${body})`;
          } else {
            code += `\n  .with(${pat}, ${body})`;
          }
        }
      } finally {
        if (payloadName && payloadFields) {
          this.context.leaveOptionalPayload();
        } else if (recordPattern && payloadFields) {
          this.context.leaveOptionalRecordPattern?.();
        }
      }
    }

    if (!hasWildcard && !isExhaustiveBooleanMatch) {
      code += `\n  .exhaustive()`;
    }

    if (isPipe) {
      code += `)`;
    }

    return code;
  }

  private emitPatternAsCondition(pattern: Pattern): string {
    if (pattern.kind === "LiteralPattern") {
      if (
        pattern.literal.kind === "BooleanLiteral" &&
        pattern.literal.rawExpr
      ) {
        return this.context.emitExpression(pattern.literal.rawExpr);
      }
      if (pattern.literal.kind === "BooleanLiteral") {
        return pattern.literal.value ? "true" : "false";
      }
      if (pattern.literal.kind === "NumberLiteral") {
        return `${pattern.literal.value}`;
      }
      return this.context.emitStringLiteral(pattern.literal);
    }
    return "true";
  }

  private isFilteringPattern(pat: Pattern | undefined): boolean {
    if (!pat) return false;
    if (pat.kind === "VariablePattern" || pat.kind === "WildcardPattern") {
      return false;
    }
    return true;
  }

  private emitPattern(pat: Pattern): string {
    if (pat.kind === "WildcardPattern") return "P._";
    if (pat.kind === "LiteralPattern") {
      if (pat.literal.kind === "BooleanLiteral")
        return pat.literal.value ? "true" : "false";
      if (pat.literal.kind === "NumberLiteral") return `${pat.literal.value}`;
      return this.context.emitStringLiteral(pat.literal);
    }
    if (pat.kind === "VariablePattern") return `P.select("${pat.name.name}")`;
    if (pat.kind === "ConstructorPattern") {
      if (JS_ERROR_NAMES.has(pat.constructorName.name)) {
        if (pat.args.length === 0) {
          return `P.instanceOf(${pat.constructorName.name})`;
        }
        if (pat.args.length === 1) {
          return `P.intersection(P.instanceOf(${pat.constructorName.name}), { message: ${this.emitPattern(pat.args[0])} })`;
        }
      }
      if (pat.args.length === 0) {
        return `{ _tag: "${pat.constructorName.name}" }`;
      }
      if (pat.constructorName.name === "Some" && pat.args.length === 1) {
        const arg = pat.args[0];
        if (
          arg.kind === "ArrayPattern" ||
          arg.kind === "LiteralPattern" ||
          arg.kind === "OrPattern" ||
          arg.kind === "ConstructorPattern"
        ) {
          return `{ _tag: "Some", value: ${this.emitPattern(arg)} }`;
        }
        if (arg.kind === "RecordPattern") {
          const filteringFields = arg.fields.filter(
            (f) => !f.isRest && this.isFilteringPattern(f.pattern),
          );
          if (filteringFields.length > 0) {
            const fieldsStr = filteringFields
              .map((f) => `${f.key.name}: ${this.emitPattern(f.pattern!)}`)
              .join(", ");
            return `{ _tag: "Some", value: { ${fieldsStr} } }`;
          }
        }
      }
      const fieldNames = this.context.getVariantFields?.(
        pat.constructorName.name,
      );
      if (fieldNames && fieldNames.length === pat.args.length) {
        const filteringFields: string[] = [];
        for (let i = 0; i < fieldNames.length; i++) {
          const arg = pat.args[i];
          if (this.isFilteringPattern(arg)) {
            filteringFields.push(`${fieldNames[i]}: ${this.emitPattern(arg)}`);
          }
        }
        if (filteringFields.length > 0) {
          return `{ _tag: "${pat.constructorName.name}", ${filteringFields.join(", ")} }`;
        }
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
        .filter((f) => !f.isRest)
        .map((f) => {
          if (!f.pattern || f.pattern.kind === "VariablePattern") {
            return `${f.key.name}: P._`;
          }
          return `${f.key.name}: ${this.emitPattern(f.pattern)}`;
        })
        .join(", ");
      return `{ ${fields} }`;
    }
    if (pat.kind === "ArrayPattern") {
      const elements: string[] = [];
      for (const el of pat.elements) {
        if (el.kind === "RestPattern") {
          elements.push("...P.array()");
        } else if (
          el.kind === "VariablePattern" ||
          el.kind === "WildcardPattern"
        ) {
          elements.push("P._");
        } else {
          elements.push(this.emitPattern(el));
        }
      }
      return `[${elements.join(", ")}]`;
    }
    return "P._";
  }

  private collectRecordDestructuring(pat: RecordPattern): string[] {
    const parts: string[] = [];
    const hasRest = pat.fields.some((f) => f.isRest);

    for (const f of pat.fields) {
      if (f.isRest) continue;
      if (!f.pattern) {
        parts.push(f.key.name);
      } else if (f.pattern.kind === "VariablePattern") {
        parts.push(`${f.key.name}: ${f.pattern.name.name}`);
      } else if (f.pattern.kind === "RecordPattern") {
        const sub = this.collectRecordDestructuring(f.pattern);
        if (sub.length > 0) {
          parts.push(`${f.key.name}: { ${sub.join(", ")} }`);
        } else if (hasRest) {
          parts.push(`${f.key.name}: _${f.key.name}`);
        }
      } else if (f.pattern.kind === "ArrayPattern") {
        parts.push(
          `${f.key.name}: ${this.context.emitBindingTarget(f.pattern)}`,
        );
      } else if (hasRest) {
        parts.push(`${f.key.name}: _${f.key.name}`);
      }
    }

    if (hasRest) {
      const restField = pat.fields.find((f) => f.isRest)!;
      parts.push(`...${restField.key.name}`);
    }

    return parts;
  }

  private emitSomeRecordUnpack(
    pat: RecordPattern,
    payloadFields?: Map<string, RecordFieldInfo>,
    isOptional?: boolean,
  ): string {
    if (patternHasOptionalField(pat, payloadFields)) {
      this.context.addEffectImport?.("Option");
      const cast = isOptional
        ? ""
        : ` as unknown as { value: typeof $matched extends import("effect").Option.Some<infer V> ? V : any }`;
      const lines: string[] = [
        `const { value: $funscriptSomeInner } = $matched${cast};`,
      ];
      const restField = pat.fields.find((f) => f.isRest);
      if (restField) {
        const nonRest = pat.fields.filter((f) => !f.isRest);
        lines.push(
          `const { ${nonRest.map((f) => `${f.key.name}: _${f.key.name}`).join(", ")}, ...$funscriptRest } = $funscriptSomeInner;`,
        );
        lines.push(`const ${restField.key.name} = $funscriptRest;`);
      }
      for (const f of pat.fields) {
        if (f.isRest) continue;
        if (
          f.pattern?.kind === "WildcardPattern" ||
          f.pattern?.kind === "LiteralPattern"
        )
          continue;
        const varName = f.pattern
          ? this.context.emitBindingTarget(f.pattern)
          : f.key.name;
        const isOpt = payloadFields?.get(f.key.name)?.optional === true;
        if (isOpt) {
          lines.push(
            `const ${varName} = Option.fromNullishOr($funscriptSomeInner.${f.key.name});`,
          );
        } else {
          lines.push(`const ${varName} = $funscriptSomeInner.${f.key.name};`);
        }
      }
      return lines.join("\n    ");
    }
    const destructParts = this.collectRecordDestructuring(pat);
    if (destructParts.length === 0) return "";
    const cast = isOptional
      ? ""
      : ` as unknown as { value: typeof $matched extends import("effect").Option.Some<infer V> ? V : any }`;
    return `const { value: { ${destructParts.join(", ")} } } = $matched${cast};`;
  }

  private emitArmHandler(
    body: FunctionBody,
    pat?: Pattern,
    scrutinee?: Expression,
    payloadFields?: Map<string, RecordFieldInfo>,
  ): string {
    if (pat?.kind === "RecordPattern") {
      const destructParts = this.collectRecordDestructuring(pat);
      const scrutineeName =
        scrutinee?.kind === "Identifier" ? scrutinee.name : undefined;

      if (destructParts.length > 0) {
        const lines: string[] = [];
        if (scrutineeName) {
          lines.push(`const ${scrutineeName} = $matched;`);
        }
        lines.push(`const { ${destructParts.join(", ")} } = $matched;`);
        if (body.kind === "BlockStatement") {
          return `($matched) => {\n    ${lines.join("\n    ")}\n${this.context.emitFunctionBody(body)}\n  }`;
        }
        return `($matched) => {\n    ${lines.join("\n    ")}\n    return ${this.context.emitExpression(body)};\n  }`;
      }

      if (scrutineeName) {
        if (body.kind === "BlockStatement") {
          return `(${scrutineeName}) => {\n${this.context.emitFunctionBody(body)}\n}`;
        }
        return `(${scrutineeName}) => ${this.context.emitArrowExpression(body)}`;
      }

      if (body.kind === "BlockStatement") {
        return `($matched) => {\n${this.context.emitFunctionBody(body)}\n}`;
      }
      return `($matched) => ${this.context.emitArrowExpression(body)}`;
    }

    if (pat?.kind === "ArrayPattern") {
      const scrutineeName =
        scrutinee?.kind === "Identifier" ? scrutinee.name : undefined;
      const bindingStr = this.context.emitBindingTarget(pat);
      const lines: string[] = [];
      if (scrutineeName) {
        lines.push(`const ${scrutineeName} = $matched;`);
      }
      if (pat.elements.length > 0 && bindingStr !== "[]") {
        lines.push(`const ${bindingStr} = $matched;`);
      }
      if (lines.length > 0) {
        if (body.kind === "BlockStatement") {
          return `($matched: any) => {\n    ${lines.join("\n    ")}\n${this.context.emitFunctionBody(body)}\n  }`;
        }
        return `($matched: any) => {\n    ${lines.join("\n    ")}\n    return ${this.context.emitExpression(body)};\n  }`;
      }
      if (body.kind === "BlockStatement") {
        return `() => {\n${this.context.emitFunctionBody(body)}\n}`;
      }
      return `() => ${this.context.emitArrowExpression(body)}`;
    }

    if (
      pat?.kind === "OrPattern" &&
      pat.patterns.every((p) => p.kind === "RecordPattern")
    ) {
      const scrutineeName =
        scrutinee?.kind === "Identifier" ? scrutinee.name : undefined;
      if (scrutineeName) {
        if (body.kind === "BlockStatement") {
          return `(${scrutineeName}) => {\n${this.context.emitFunctionBody(body)}\n}`;
        }
        return `(${scrutineeName}) => ${this.context.emitArrowExpression(body)}`;
      }
      if (body.kind === "BlockStatement") {
        return `($matched) => {\n${this.context.emitFunctionBody(body)}\n}`;
      }
      return `($matched) => ${this.context.emitArrowExpression(body)}`;
    }

    const vars = pat ? this.collectPatternVariables(pat) : [];
    const isOptional = scrutinee
      ? this.context.isOptionalValue(scrutinee)
      : false;
    if (
      pat?.kind === "ConstructorPattern" &&
      JS_ERROR_NAMES.has(pat.constructorName.name)
    ) {
      if (vars.length > 0) {
        const unpack = `const { ${vars.join(", ")} } = $matched as any;`;
        if (body.kind === "BlockStatement") {
          return `($matched) => {\n    ${unpack}\n${this.context.emitFunctionBody(body)}\n  }`;
        }
        return `($matched) => {\n    ${unpack}\n    return ${this.context.emitExpression(body)};\n  }`;
      }
      if (body.kind === "BlockStatement") {
        return `() => {\n${this.context.emitFunctionBody(body)}\n}`;
      }
      return `() => ${this.context.emitArrowExpression(body)}`;
    }
    if (
      pat?.kind === "ConstructorPattern" &&
      pat.constructorName.name === "Some" &&
      pat.args.length === 1
    ) {
      if (pat.args[0].kind === "RecordPattern") {
        const unpack = this.emitSomeRecordUnpack(
          pat.args[0],
          payloadFields,
          isOptional,
        );
        if (unpack) {
          if (body.kind === "BlockStatement")
            return `($matched) => {\n    ${unpack}\n${this.context.emitFunctionBody(body)}\n  }`;
          return `($matched) => {\n    ${unpack}\n    return ${this.context.emitExpression(body)};\n  }`;
        }
        if (body.kind === "BlockStatement")
          return `() => {\n${this.context.emitFunctionBody(body)}\n}`;
        return `() => ${this.context.emitArrowExpression(body)}`;
      }
      if (pat.args[0].kind === "LiteralPattern") {
        if (body.kind === "BlockStatement")
          return `() => {\n${this.context.emitFunctionBody(body)}\n}`;
        return `() => ${this.context.emitArrowExpression(body)}`;
      }
      const bindingTarget = this.context.emitBindingTarget(pat.args[0]);
      if (bindingTarget && bindingTarget !== "[]" && bindingTarget !== "{}") {
        const unpack = isOptional
          ? `const { value: ${bindingTarget} } = $matched;`
          : `const { value: ${bindingTarget} } = $matched as unknown as { value: typeof $matched extends import("effect").Option.Some<infer V> ? V : any };`;
        if (body.kind === "BlockStatement")
          return `($matched) => {\n    ${unpack}\n${this.context.emitFunctionBody(body)}\n  }`;
        return `($matched) => {\n    ${unpack}\n    return ${this.context.emitExpression(body)};\n  }`;
      }
      if (body.kind === "BlockStatement")
        return `() => {\n${this.context.emitFunctionBody(body)}\n}`;
      return `() => ${this.context.emitArrowExpression(body)}`;
    }
    if (vars.length > 0) {
      let unpack: string;
      const fieldNames =
        pat?.kind === "ConstructorPattern" &&
        pat.constructorName.name !== "Some" &&
        !JS_ERROR_NAMES.has(pat.constructorName.name)
          ? this.context.getVariantFields?.(pat.constructorName.name)
          : undefined;

      if (
        pat?.kind === "ConstructorPattern" &&
        fieldNames &&
        fieldNames.length === pat.args.length
      ) {
        const parts: string[] = [];
        for (let i = 0; i < fieldNames.length; i++) {
          const arg = pat.args[i];
          if (arg.kind === "VariablePattern") {
            parts.push(`${fieldNames[i]}: ${arg.name.name}`);
          }
        }
        unpack = `const { ${parts.join(", ")} } = $matched as any;`;
      } else if (pat?.kind === "VariablePattern") {
        unpack = `const { ${vars[0]} } = $matched as any;`;
      } else {
        unpack = `const { _tag: _, ...__fields } = $matched as any;\n    const [${vars.join(", ")}] = Object.values(__fields) as any[];`;
      }
      if (body.kind === "BlockStatement") {
        return `($matched) => {\n    ${unpack}\n${this.context.emitFunctionBody(body)}\n  }`;
      }
      return `($matched) => {\n    ${unpack}\n    return ${this.context.emitExpression(body)};\n  }`;
    }

    if (body.kind === "BlockStatement") {
      return `() => {\n${this.context.emitFunctionBody(body)}\n}`;
    }
    return `() => ${this.context.emitArrowExpression(body)}`;
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
      return pat.patterns.length > 0
        ? this.collectPatternVariables(pat.patterns[0])
        : [];
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
    if (pat.kind === "RestPattern") {
      return this.collectPatternVariables(pat.argument);
    }
    return [];
  }
}
