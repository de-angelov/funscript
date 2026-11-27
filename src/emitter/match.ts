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
import {
  emitUnpackedRecordPattern,
  patternHasOptionalField,
} from "./declarations.js";

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
  isTaggedUnionVariant?(type: string, variant: string): boolean;
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

  public emitMatchExpression(
    expr: MatchExpression,
    pipelineScrutineeType?: TypeNode,
  ): string {
    if (expr.isCatch) {
      return this.emitCatchExpression(expr);
    }
    if (!expr.scrutinee && !expr.isPipeline) {
      return this.emitIfElseMatch(expr.arms, (arm) =>
        this.emitPatternAsCondition(arm.pattern),
      );
    }

    const scrutineeId =
      expr.scrutinee?.kind === "Identifier" ? expr.scrutinee.name : undefined;
    const isGuardOnlyNarrowingMatch =
      Boolean(expr.scrutinee) &&
      !expr.isPipeline &&
      expr.arms.some((a) => Boolean(a.guard)) &&
      expr.arms.every(
        (a) =>
          a.pattern.kind === "WildcardPattern" ||
          (scrutineeId !== undefined &&
            a.pattern.kind === "VariablePattern" &&
            a.pattern.name.name === scrutineeId),
      );

    if (isGuardOnlyNarrowingMatch) {
      return this.emitIfElseMatch(expr.arms, (arm) =>
        arm.guard ? this.context.emitExpression(arm.guard) : "true",
      );
    }

    const scrutineeType =
      expr.scrutinee && !expr.isPipeline
        ? this.context.getTypeNodeForExpression?.(expr.scrutinee)
        : pipelineScrutineeType;
    if (
      scrutineeType?.kind === "TypeReferenceNode" &&
      scrutineeType.name.name === "JSNullish"
    ) {
      return this.emitJSNullishMatch(expr.scrutinee, expr.arms);
    }
    const hasNullishFailurePattern = expr.arms.some((arm) => {
      const p = arm.pattern;
      return (
        p.kind === "ConstructorPattern" &&
        p.constructorName.name === "Failure" &&
        p.args.some(
          (arg) =>
            arg.kind === "ConstructorPattern" &&
            (arg.constructorName.name === "Null" ||
              arg.constructorName.name === "Undefined"),
        )
      );
    });
    const isKnownTaggedFailure =
      scrutineeType?.kind === "TypeReferenceNode" &&
      (scrutineeType.name.name === "Result" ||
        (this.context.isTaggedUnionVariant?.(
          scrutineeType.name.name,
          "Failure",
        ) ??
          false));
    if (hasNullishFailurePattern && !isKnownTaggedFailure) {
      throw new FunScriptError(
        "Failure(Null) and Failure(Undefined) require a statically known JSNullish<T> scrutinee; add a JSNullish annotation before matching",
        expr.span,
      );
    }
    if (
      scrutineeType?.kind === "TypeReferenceNode" &&
      scrutineeType.name.name === "JSOptional"
    ) {
      return this.emitJSOptionalMatch(expr.scrutinee!, expr.arms);
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
          (arm.pattern.kind === "WildcardPattern" && !arm.guard) ||
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
              const scrutineeName =
                expr.scrutinee?.kind === "Identifier"
                  ? expr.scrutinee.name
                  : undefined;
              const unpackLines = this.emitRecordPatternUnpack(
                arm.pattern,
                "$matched",
              );
              if (unpackLines.length > 0) {
                const lines = [
                  ...(scrutineeName
                    ? [`const ${scrutineeName} = $matched;`]
                    : []),
                  ...unpackLines,
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
              const unpackLines = this.emitPatternUnpackLines(
                arm.pattern,
                "$matched",
              );
              if (unpackLines.length > 0) {
                const lines = [
                  ...(scrutineeName
                    ? [`const ${scrutineeName} = $matched;`]
                    : []),
                  ...unpackLines,
                  `return ${this.context.emitExpression(arm.guard)};`,
                ];
                guardFn = `($matched) => {\n    ${lines.join("\n    ")}\n  }`;
              } else if (scrutineeName) {
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
                    (arm.pattern.args[0].kind === "ArrayPattern" &&
                      this.isSimpleBindingPattern(arm.pattern.args[0])));
                const someRecord =
                  arm.pattern.kind === "ConstructorPattern" &&
                  arm.pattern.constructorName.name === "Some" &&
                  arm.pattern.args.length === 1 &&
                  arm.pattern.args[0].kind === "RecordPattern" &&
                  (this.isSimpleBindingPattern(arm.pattern.args[0]) ||
                    patternHasOptionalField(
                      arm.pattern.args[0],
                      payloadFields,
                    ));
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
                  unpack = this.emitPatternUnpackLines(
                    arm.pattern,
                    "$matched",
                    {
                      isOptionalScrutinee: directOptional || isOptional,
                      payloadFields,
                    },
                  ).join("\n    ");
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
        ...emitUnpackedRecordPattern({
          pat,
          basePath: "$funscriptSomeInner",
          fieldsMap: payloadFields,
          emitBindingTarget: (target) => this.context.emitBindingTarget(target),
          addEffectImport: (name) => this.context.addEffectImport?.(name),
        }),
      ];
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
      const scrutineeName =
        scrutinee?.kind === "Identifier" ? scrutinee.name : undefined;
      const unpackLines = this.emitRecordPatternUnpack(pat, "$matched");

      if (unpackLines.length > 0) {
        const lines: string[] = [];
        if (scrutineeName) {
          lines.push(`const ${scrutineeName} = $matched;`);
        }
        lines.push(...unpackLines);
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
      const lines: string[] = [];
      if (scrutineeName) {
        lines.push(`const ${scrutineeName} = $matched;`);
      }
      lines.push(...this.emitPatternUnpackLines(pat, "$matched"));
      if (lines.length > 0) {
        if (body.kind === "BlockStatement") {
          return `($matched) => {\n    ${lines.join("\n    ")}\n${this.context.emitFunctionBody(body)}\n  }`;
        }
        return `($matched) => {\n    ${lines.join("\n    ")}\n    return ${this.context.emitExpression(body)};\n  }`;
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
      const unpackLines = this.emitPatternUnpackLines(pat, "$matched");
      if (unpackLines.length > 0) {
        const lines: string[] = [];
        if (scrutineeName) {
          lines.push(`const ${scrutineeName} = $matched;`);
        }
        lines.push(...unpackLines);
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
      const arg = pat.args[0];
      if (
        arg.kind === "RecordPattern" &&
        (this.isSimpleBindingPattern(arg) ||
          patternHasOptionalField(arg, payloadFields))
      ) {
        const unpack = this.emitSomeRecordUnpack(
          arg,
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
      if (arg.kind === "LiteralPattern") {
        if (body.kind === "BlockStatement")
          return `() => {\n${this.context.emitFunctionBody(body)}\n}`;
        return `() => ${this.context.emitArrowExpression(body)}`;
      }
      if (
        arg.kind === "VariablePattern" ||
        (arg.kind === "ArrayPattern" && this.isSimpleBindingPattern(arg))
      ) {
        const bindingTarget = this.context.emitBindingTarget(arg);
        if (bindingTarget && bindingTarget !== "[]" && bindingTarget !== "{}") {
          const unpack = isOptional
            ? `const { value: ${bindingTarget} } = $matched;`
            : `const { value: ${bindingTarget} } = $matched as unknown as { value: typeof $matched extends import("effect").Option.Some<infer V> ? V : any };`;
          if (body.kind === "BlockStatement")
            return `($matched) => {\n    ${unpack}\n${this.context.emitFunctionBody(body)}\n  }`;
          return `($matched) => {\n    ${unpack}\n    return ${this.context.emitExpression(body)};\n  }`;
        }
      } else if (vars.length > 0) {
        const unpack = this.emitPatternUnpackLines(pat, "$matched", {
          isOptionalScrutinee: isOptional,
          payloadFields,
        }).join("\n    ");
        if (body.kind === "BlockStatement")
          return `($matched) => {\n    ${unpack}\n${this.context.emitFunctionBody(body)}\n  }`;
        return `($matched) => {\n    ${unpack}\n    return ${this.context.emitExpression(body)};\n  }`;
      }
      if (body.kind === "BlockStatement")
        return `() => {\n${this.context.emitFunctionBody(body)}\n}`;
      return `() => ${this.context.emitArrowExpression(body)}`;
    }
    if (vars.length > 0 && pat) {
      const unpack =
        pat.kind === "VariablePattern"
          ? `const { ${vars[0]} } = $matched as any;`
          : this.emitPatternUnpackLines(pat, "$matched", {
              isOptionalScrutinee: isOptional,
              payloadFields,
            }).join("\n    ");
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

  /** Returns true when a pattern can be unpacked with plain JS destructuring. */
  private isSimpleBindingPattern(pat: Pattern): boolean {
    if (
      pat.kind === "WildcardPattern" ||
      pat.kind === "LiteralPattern" ||
      pat.kind === "VariablePattern"
    ) {
      return true;
    }
    if (pat.kind === "RestPattern") {
      return this.isSimpleBindingPattern(pat.argument);
    }
    if (pat.kind === "ArrayPattern") {
      return pat.elements.every((el) => this.isSimpleBindingPattern(el));
    }
    if (pat.kind === "RecordPattern") {
      return pat.fields.every(
        (f) => f.isRest || !f.pattern || this.isSimpleBindingPattern(f.pattern),
      );
    }
    return false;
  }

  /** Produces a structural signature of where variables are bound in a pattern. */
  private patternBindingSignature(pat: Pattern): string {
    if (pat.kind === "VariablePattern") return `VAR:${pat.name.name}`;
    if (pat.kind === "WildcardPattern" || pat.kind === "LiteralPattern") {
      return "_";
    }
    if (pat.kind === "RestPattern") {
      return `...${this.patternBindingSignature(pat.argument)}`;
    }
    if (pat.kind === "ArrayPattern") {
      return `[${pat.elements
        .map((el, i) =>
          this.collectPatternVariables(el).length > 0
            ? `${i}:${this.patternBindingSignature(el)}`
            : "_",
        )
        .join(",")}]`;
    }
    if (pat.kind === "RecordPattern") {
      const entries = pat.fields
        .filter(
          (f) =>
            f.isRest ||
            !f.pattern ||
            this.collectPatternVariables(f.pattern).length > 0,
        )
        .map((f) =>
          f.isRest
            ? `...${f.key.name}`
            : `${f.key.name}:${f.pattern ? this.patternBindingSignature(f.pattern) : `VAR:${f.key.name}`}`,
        )
        .sort();
      return `{${entries.join(",")}}`;
    }
    if (pat.kind === "ConstructorPattern") {
      return `${pat.constructorName.name}(${pat.args.map((a) => this.patternBindingSignature(a)).join(",")})`;
    }
    if (pat.kind === "OrPattern") {
      return `OR(${pat.patterns.map((p) => this.patternBindingSignature(p)).join("|")})`;
    }
    return "_";
  }

  /** Emits destructuring and nested unpack lines for a record pattern. */
  private emitRecordPatternUnpack(
    pat: RecordPattern,
    targetExpr: string,
    nextTemp: () => string = (() => {
      let idx = 0;
      return () => `__match${idx++}`;
    })(),
  ): string[] {
    if (this.isSimpleBindingPattern(pat)) {
      const destructParts = this.collectRecordDestructuring(pat);
      return destructParts.length > 0
        ? [`const { ${destructParts.join(", ")} } = ${targetExpr};`]
        : [];
    }

    const parts: string[] = [];
    const nestedLines: string[] = [];
    const hasRest = pat.fields.some((f) => f.isRest);

    for (const f of pat.fields) {
      if (f.isRest) {
        parts.push(`...${f.key.name}`);
      } else if (!f.pattern) {
        parts.push(f.key.name);
      } else if (f.pattern.kind === "VariablePattern") {
        parts.push(`${f.key.name}: ${f.pattern.name.name}`);
      } else if (this.isSimpleBindingPattern(f.pattern)) {
        if (f.pattern.kind === "RecordPattern") {
          const sub = this.collectRecordDestructuring(f.pattern);
          if (sub.length > 0) {
            parts.push(`${f.key.name}: { ${sub.join(", ")} }`);
          } else if (hasRest) {
            parts.push(`${f.key.name}: _${f.key.name}`);
          }
        } else if (f.pattern.kind === "ArrayPattern") {
          const target = this.context.emitBindingTarget(f.pattern);
          if (target && target !== "[]") {
            parts.push(`${f.key.name}: ${target}`);
          } else if (hasRest) {
            parts.push(`${f.key.name}: _${f.key.name}`);
          }
        } else if (hasRest) {
          parts.push(`${f.key.name}: _${f.key.name}`);
        }
      } else if (this.collectPatternVariables(f.pattern).length > 0) {
        const tmp = nextTemp();
        parts.push(`${f.key.name}: ${tmp}`);
        nestedLines.push(
          ...this.emitPatternUnpackLines(f.pattern, tmp, { nextTemp }),
        );
      } else if (hasRest) {
        parts.push(`${f.key.name}: _${f.key.name}`);
      }
    }

    if (parts.length > 0) {
      return [`const { ${parts.join(", ")} } = ${targetExpr};`, ...nestedLines];
    }
    return nestedLines;
  }

  /** Recursively unpacks bindings from any match pattern against `targetExpr`. */
  private emitPatternUnpackLines(
    pat: Pattern,
    targetExpr: string,
    options?: {
      isOptionalScrutinee?: boolean;
      payloadFields?: Map<string, RecordFieldInfo>;
      nextTemp?: () => string;
    },
  ): string[] {
    let tempCounter = 0;
    const nextTemp = options?.nextTemp ?? (() => `__match${tempCounter++}`);
    const vars = this.collectPatternVariables(pat);
    if (vars.length === 0) {
      return [];
    }

    if (pat.kind === "VariablePattern") {
      return [`const ${pat.name.name} = ${targetExpr};`];
    }

    if (pat.kind === "RestPattern") {
      return this.emitPatternUnpackLines(pat.argument, targetExpr, {
        nextTemp,
      });
    }

    if (pat.kind === "RecordPattern") {
      return this.emitRecordPatternUnpack(pat, targetExpr, nextTemp);
    }

    if (pat.kind === "ArrayPattern") {
      const lines: string[] = [];
      for (let i = 0; i < pat.elements.length; i++) {
        const el = pat.elements[i];
        const elemExpr = `${targetExpr}[${i}]`;
        if (el.kind === "RestPattern") {
          if (el.argument.kind === "VariablePattern") {
            lines.push(
              `const ${el.argument.name.name} = ${targetExpr}.slice(${i});`,
            );
          } else if (this.collectPatternVariables(el.argument).length > 0) {
            const tmp = nextTemp();
            lines.push(`const ${tmp} = ${targetExpr}.slice(${i});`);
            lines.push(
              ...this.emitPatternUnpackLines(el.argument, tmp, { nextTemp }),
            );
          }
        } else if (this.collectPatternVariables(el).length > 0) {
          lines.push(
            ...this.emitPatternUnpackLines(el, elemExpr, { nextTemp }),
          );
        }
      }
      return lines;
    }

    if (pat.kind === "OrPattern") {
      const first = pat.patterns[0];
      if (!first) return [];
      const firstSig = this.patternBindingSignature(first);
      const allSameShape = pat.patterns.every(
        (p) => this.patternBindingSignature(p) === firstSig,
      );
      if (allSameShape) {
        return this.emitPatternUnpackLines(first, targetExpr, {
          ...options,
          nextTemp,
        });
      }
      const uniqueVars = Array.from(new Set(vars));
      const branches = pat.patterns
        .map((alt) => {
          const orVar = nextTemp();
          const altLines = this.emitPatternUnpackLines(alt, orVar, {
            nextTemp,
          });
          const bodyLines = [
            ...altLines,
            `return { ${uniqueVars.join(", ")} };`,
          ];
          return `.with(${this.emitPattern(alt)}, (${orVar}) => {\n      ${bodyLines.join("\n      ")}\n    })`;
        })
        .join("\n    ");
      return [
        `const { ${uniqueVars.join(", ")} } = match(${targetExpr} as any)\n    ${branches}\n    .otherwise(() => ({}) as any);`,
      ];
    }

    if (pat.kind === "ConstructorPattern") {
      if (JS_ERROR_NAMES.has(pat.constructorName.name)) {
        return [`const { ${vars.join(", ")} } = ${targetExpr} as any;`];
      }

      if (pat.constructorName.name === "Some" && pat.args.length === 1) {
        const arg = pat.args[0];
        const useTypedSomeCast =
          targetExpr !== "$matched" || !options?.isOptionalScrutinee;
        const cast = useTypedSomeCast
          ? ` as unknown as { value: Extract<typeof ${targetExpr}, { readonly _tag: "Some" }> extends import("effect").Option.Some<infer V> ? V : any }`
          : "";
        if (
          arg.kind === "RecordPattern" &&
          targetExpr === "$matched" &&
          patternHasOptionalField(arg, options?.payloadFields)
        ) {
          return [
            this.emitSomeRecordUnpack(
              arg,
              options?.payloadFields,
              options?.isOptionalScrutinee,
            ),
          ].filter(Boolean);
        }
        if (arg.kind === "VariablePattern") {
          return [`const { value: ${arg.name.name} } = ${targetExpr}${cast};`];
        }
        if (
          (arg.kind === "RecordPattern" || arg.kind === "ArrayPattern") &&
          this.isSimpleBindingPattern(arg)
        ) {
          const bindingTarget = this.context.emitBindingTarget(arg);
          if (
            bindingTarget &&
            bindingTarget !== "[]" &&
            bindingTarget !== "{}" &&
            bindingTarget !== "_"
          ) {
            return [
              `const { value: ${bindingTarget} } = ${targetExpr}${cast};`,
            ];
          }
        }
        const tmp = nextTemp();
        return [
          `const { value: ${tmp} } = ${targetExpr}${cast};`,
          ...this.emitPatternUnpackLines(arg, tmp, { nextTemp }),
        ];
      }

      const fieldNames = this.context.getVariantFields?.(
        pat.constructorName.name,
      );
      if (fieldNames && fieldNames.length === pat.args.length) {
        const parts: string[] = [];
        const nestedLines: string[] = [];
        for (let i = 0; i < fieldNames.length; i++) {
          const arg = pat.args[i];
          if (this.collectPatternVariables(arg).length === 0) continue;
          if (arg.kind === "VariablePattern") {
            parts.push(`${fieldNames[i]}: ${arg.name.name}`);
          } else if (
            arg.kind === "RecordPattern" &&
            this.isSimpleBindingPattern(arg)
          ) {
            const sub = this.collectRecordDestructuring(arg);
            if (sub.length > 0) {
              parts.push(`${fieldNames[i]}: { ${sub.join(", ")} }`);
            }
          } else if (
            arg.kind === "ArrayPattern" &&
            this.isSimpleBindingPattern(arg)
          ) {
            const target = this.context.emitBindingTarget(arg);
            if (target && target !== "[]") {
              parts.push(`${fieldNames[i]}: ${target}`);
            }
          } else {
            const tmp = nextTemp();
            parts.push(`${fieldNames[i]}: ${tmp}`);
            nestedLines.push(
              ...this.emitPatternUnpackLines(arg, tmp, { nextTemp }),
            );
          }
        }
        if (parts.length > 0) {
          return [
            `const { ${parts.join(", ")} } = ${targetExpr} as any;`,
            ...nestedLines,
          ];
        }
        return nestedLines;
      }

      const fieldsVar = nextTemp();
      const argTargets: string[] = [];
      const nestedLines: string[] = [];
      for (const arg of pat.args) {
        if (this.collectPatternVariables(arg).length === 0) {
          argTargets.push("");
        } else if (arg.kind === "VariablePattern") {
          argTargets.push(arg.name.name);
        } else {
          const tmp = nextTemp();
          argTargets.push(tmp);
          nestedLines.push(
            ...this.emitPatternUnpackLines(arg, tmp, { nextTemp }),
          );
        }
      }
      return [
        `const { _tag: _, ...${fieldsVar} } = ${targetExpr} as any;`,
        `const [${argTargets.join(", ")}] = Object.values(${fieldsVar}) as any[];`,
        ...nestedLines,
      ];
    }

    return [];
  }

  private emitIfElseMatch(
    arms: MatchArm[],
    getCondition: (arm: MatchArm) => string,
  ): string {
    const hasBlockArm = arms.some((a) => a.body.kind === "BlockStatement");
    if (!hasBlockArm) {
      let code = "";
      for (let i = 0; i < arms.length; i++) {
        const arm = arms[i];
        const isDefault =
          (arm.pattern.kind === "WildcardPattern" ||
            arm.pattern.kind === "VariablePattern") &&
          !arm.guard;
        const body = this.context.emitExpression(arm.body as Expression);
        if (isDefault) {
          code += body;
          break;
        }
        if (i === arms.length - 1) {
          code += `${getCondition(arm)} ? ${body} : (() => { throw new Error("Non-exhaustive match"); })()`;
          break;
        }
        code += `${getCondition(arm)} ? ${body} : `;
      }
      return `(${code})`;
    }

    const branches: string[] = [];
    let hasDefault = false;
    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i];
      const isDefault =
        (arm.pattern.kind === "WildcardPattern" ||
          arm.pattern.kind === "VariablePattern") &&
        !arm.guard;
      const inner =
        arm.body.kind === "BlockStatement"
          ? this.context.emitFunctionBody(arm.body)
          : `  return ${this.context.emitExpression(arm.body)};`;
      if (i === 0) {
        if (isDefault) {
          hasDefault = true;
          branches.push(inner);
          break;
        }
        branches.push(`if (${getCondition(arm)}) {\n${inner}\n}`);
      } else if (isDefault) {
        hasDefault = true;
        branches.push(`else {\n${inner}\n}`);
        break;
      } else {
        branches.push(`else if (${getCondition(arm)}) {\n${inner}\n}`);
      }
    }
    if (!hasDefault) {
      branches.push(`else {\n  throw new Error("Non-exhaustive match");\n}`);
    }
    return `(() => {\n  ${branches.join(" ")}\n})()`;
  }

  private emitCatchExpression(expr: MatchExpression): string {
    this.context.addEffectImport?.("Effect");
    const collectCases = (pattern: Pattern, body: string): string[] => {
      if (pattern.kind === "OrPattern") {
        return pattern.patterns.flatMap((part) => collectCases(part, body));
      }
      if (pattern.kind !== "ConstructorPattern") {
        throw new Error("Invalid catch arm");
      }
      const arg = pattern.args[0];
      const binding = arg?.kind === "VariablePattern" ? arg.name.name : "";
      return [
        `${JSON.stringify(pattern.constructorName.name)}: (${binding}) => {\n${body}\n}`,
      ];
    };
    const cases = expr.arms.flatMap((arm) =>
      collectCases(arm.pattern, this.context.emitFunctionBody(arm.body)),
    );
    const handlers = `{\n${cases.join(",\n")}\n}`;
    if (expr.isPipeline || !expr.scrutinee) {
      return `(__catchInput) => Effect.catchTags(__catchInput, ${handlers})`;
    }
    return `Effect.catchTags(${this.context.emitExpression(expr.scrutinee)}, ${handlers})`;
  }

  private emitJSNullishMatch(
    scrutinee: Expression | undefined,
    arms: MatchArm[],
  ): string {
    if (!arms.length)
      throw new FunScriptError(
        "JSNullish match requires at least one arm",
        scrutinee?.span ?? {
          start: { line: 1, column: 1, offset: 0 },
          end: { line: 1, column: 1, offset: 0 },
        },
      );
    // Always capture once: a property getter or foreign expression may be effectful.
    const value = "$jsNullish";
    const preamble = scrutinee
      ? `const ${value} = ${this.context.emitExpression(scrutinee)};`
      : "";
    const branches: string[] = [];
    let coversSuccess = false;
    let coversNull = false;
    let coversUndefined = false;
    let coversAll = false;
    let terminated = false;

    for (const arm of arms) {
      const pat = arm.pattern;
      let condition: string;
      let binding: string | undefined;
      let caseKind: "success" | "null" | "undefined" | "failure" | "all";
      if (pat.kind === "WildcardPattern" || pat.kind === "VariablePattern") {
        condition = "true";
        caseKind = "all";
        if (pat.kind === "VariablePattern") binding = pat.name.name;
      } else if (
        pat.kind === "ConstructorPattern" &&
        pat.constructorName.name === "Success"
      ) {
        const arg = pat.args[0];
        if (
          pat.args.length !== 1 ||
          (arg.kind !== "VariablePattern" && arg.kind !== "WildcardPattern")
        ) {
          throw new FunScriptError(
            "JSNullish Success expects one variable or '_' pattern",
            pat.span,
          );
        }
        condition = `(${value} !== null && ${value} !== undefined)`;
        caseKind = "success";
        if (arg.kind === "VariablePattern") binding = arg.name.name;
      } else if (
        pat.kind === "ConstructorPattern" &&
        pat.constructorName.name === "Failure"
      ) {
        const arg = pat.args[0];
        if (pat.args.length !== 1) {
          throw new FunScriptError(
            "JSNullish Failure expects Null, Undefined, a variable, or '_'",
            pat.span,
          );
        }
        if (
          arg.kind === "ConstructorPattern" &&
          arg.args.length === 0 &&
          arg.constructorName.name === "Null"
        ) {
          condition = `(${value} === null)`;
          caseKind = "null";
        } else if (
          arg.kind === "ConstructorPattern" &&
          arg.args.length === 0 &&
          arg.constructorName.name === "Undefined"
        ) {
          condition = `(${value} === undefined)`;
          caseKind = "undefined";
        } else if (
          arg.kind === "VariablePattern" ||
          arg.kind === "WildcardPattern"
        ) {
          condition = `(${value} === null || ${value} === undefined)`;
          caseKind = "failure";
          if (arg.kind === "VariablePattern") binding = arg.name.name;
        } else {
          throw new FunScriptError(
            "JSNullish Failure expects Null, Undefined, a variable, or '_'",
            pat.span,
          );
        }
      } else {
        throw new FunScriptError(
          "Match JSNullish using Success(value), Failure(Null), Failure(Undefined), or '_'",
          pat.span,
        );
      }

      if (arm.guard) {
        const guard = this.context.emitExpression(arm.guard);
        // Bind the narrowed value inside an IIFE so TypeScript preserves its
        // narrowed type without triggering TS7006 on an unannotated arrow param.
        const guardExpr = binding
          ? `(() => {\n  const ${binding} = ${value};\n  return (${guard});\n})()`
          : `(${guard})`;
        condition =
          condition === "true" ? guardExpr : `${condition} && ${guardExpr}`;
      } else {
        coversSuccess ||= caseKind === "success" || caseKind === "all";
        coversNull ||=
          caseKind === "null" || caseKind === "failure" || caseKind === "all";
        coversUndefined ||=
          caseKind === "undefined" ||
          caseKind === "failure" ||
          caseKind === "all";
        coversAll ||= caseKind === "all";
      }
      const body = this.context.emitFunctionBody(arm.body);
      const complete =
        !arm.guard && coversSuccess && coversNull && coversUndefined;
      const bindingValue =
        complete && caseKind === "failure"
          ? `${value} as null | undefined`
          : value;
      const bindingLine = binding
        ? `  const ${binding} = ${bindingValue};\n`
        : "";
      if ((caseKind === "all" || complete) && !arm.guard) {
        branches.push(
          `${branches.length ? "else " : ""}{\n${bindingLine}${body}\n}`,
        );
        terminated = true;
        break;
      }
      branches.push(
        `${branches.length ? "else " : ""}if (${condition}) {\n${bindingLine}${body}\n}`,
      );
    }
    if (terminated || coversAll) {
      // A wildcard arm emitted an unconditional final branch.
    } else if (!(coversSuccess && coversNull && coversUndefined)) {
      branches.push(
        `else {\n  const __nonExhaustive: never = ${value};\n  void __nonExhaustive;\n  throw new Error("Non-exhaustive JSNullish match");\n}`,
      );
    } else {
      // Even with all cases covered, retain a final assertion so TypeScript can
      // infer a non-optional return type for separately tested conditions.
      branches.push(
        `else {\n  const __exhaustive: never = ${value};\n  return __exhaustive;\n}`,
      );
    }
    const bodyLines = preamble
      ? `  ${preamble}\n  ${branches.join(" ")}`
      : `  ${branches.join(" ")}`;
    return scrutinee
      ? `(() => {\n${bodyLines}\n})()`
      : `(${value}) => {\n${bodyLines}\n}`;
  }

  private emitJSOptionalMatch(scrutinee: Expression, arms: MatchArm[]): string {
    const scrutineeId =
      scrutinee.kind === "Identifier" ? scrutinee.name : "$jsOpt";
    const preamble =
      scrutinee.kind === "Identifier"
        ? ""
        : `const $jsOpt = ${this.context.emitExpression(scrutinee)};\n  `;

    const hasWildcard = arms.some(
      (a) =>
        (a.pattern.kind === "WildcardPattern" ||
          a.pattern.kind === "VariablePattern") &&
        !a.guard,
    );
    const hasSome = arms.some(
      (a) =>
        a.pattern.kind === "ConstructorPattern" &&
        a.pattern.constructorName.name === "Some" &&
        !a.guard,
    );
    const hasFullNone = arms.some(
      (a) =>
        a.pattern.kind === "ConstructorPattern" &&
        a.pattern.constructorName.name === "None" &&
        !a.guard &&
        ((a.pattern.args ?? []).length === 0 ||
          a.pattern.args[0]?.kind === "WildcardPattern"),
    );
    const hasNull = arms.some(
      (a) =>
        a.pattern.kind === "ConstructorPattern" &&
        a.pattern.constructorName.name === "None" &&
        !a.guard &&
        ((a.pattern.args?.[0]?.kind === "VariablePattern" &&
          a.pattern.args[0].name.name === "null") ||
          (a.pattern.args?.[0]?.kind === "ConstructorPattern" &&
            a.pattern.args[0].constructorName.name === "Null")),
    );
    const hasUndefined = arms.some(
      (a) =>
        a.pattern.kind === "ConstructorPattern" &&
        a.pattern.constructorName.name === "None" &&
        !a.guard &&
        ((a.pattern.args?.[0]?.kind === "VariablePattern" &&
          a.pattern.args[0].name.name === "undefined") ||
          (a.pattern.args?.[0]?.kind === "ConstructorPattern" &&
            a.pattern.args[0].constructorName.name === "Undefined")),
    );
    const isExhaustive =
      hasWildcard || (hasSome && (hasFullNone || (hasNull && hasUndefined)));

    const branches: string[] = [];
    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i];
      const pat = arm.pattern;
      const isWildcard =
        (pat.kind === "WildcardPattern" || pat.kind === "VariablePattern") &&
        !arm.guard;
      const bindings: string[] = [];
      let cond = "true";

      if (pat.kind === "ConstructorPattern") {
        if (pat.constructorName.name === "Some") {
          cond = `(${scrutineeId} !== null && ${scrutineeId} !== undefined)`;
          if (pat.args.length === 1 && pat.args[0].kind === "VariablePattern") {
            bindings.push(`const ${pat.args[0].name.name} = ${scrutineeId};`);
          }
        } else if (pat.constructorName.name === "None") {
          const arg = pat.args[0];
          if (
            (arg?.kind === "VariablePattern" &&
              arg.name.name === "undefined") ||
            (arg?.kind === "ConstructorPattern" &&
              arg.constructorName.name === "Undefined")
          ) {
            cond = `(${scrutineeId} === undefined)`;
          } else if (
            (arg?.kind === "VariablePattern" && arg.name.name === "null") ||
            (arg?.kind === "ConstructorPattern" &&
              arg.constructorName.name === "Null")
          ) {
            cond = `(${scrutineeId} === null)`;
          } else {
            cond = `(${scrutineeId} === null || ${scrutineeId} === undefined)`;
          }
        }
      } else if (pat.kind === "VariablePattern") {
        bindings.push(`const ${pat.name.name} = ${scrutineeId};`);
      }

      if (arm.guard) {
        const g = this.context.emitExpression(arm.guard);
        cond = cond === "true" ? g : `(${cond} && (${g}))`;
      }

      const bodyCode =
        arm.body.kind === "BlockStatement"
          ? this.context.emitFunctionBody(arm.body)
          : `  return ${this.context.emitExpression(arm.body)};`;
      const inner =
        bindings.length > 0
          ? `  ${bindings.join("\n  ")}\n${bodyCode}`
          : bodyCode;

      const isLast = i === arms.length - 1;
      if (i === 0) {
        if (isWildcard) {
          branches.push(inner);
          break;
        }
        branches.push(`if (${cond}) {\n${inner}\n}`);
      } else if (
        isWildcard ||
        (isLast && !arm.guard && pat.kind !== "ConstructorPattern")
      ) {
        branches.push(`else {\n${inner}\n}`);
        break;
      } else if (
        isExhaustive &&
        isLast &&
        !arm.guard &&
        pat.kind === "ConstructorPattern"
      ) {
        branches.push(`else {\n${inner}\n}`);
        break;
      } else {
        branches.push(`else if (${cond}) {\n${inner}\n}`);
      }
    }

    if (!isExhaustive) {
      branches.push(
        `else {\n  const __nonExhaustive: never = ${scrutineeId};\n  return __nonExhaustive;\n}`,
      );
    }

    return `(() => {\n  ${preamble}${branches.join(" ")}\n})()`;
  }
}
