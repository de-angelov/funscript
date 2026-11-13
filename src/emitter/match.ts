import type { BindingTarget, BooleanLiteral, Expression, FunctionBody, LiteralPattern, MatchArm, MatchExpression, Pattern, RecordPattern, StringLiteral } from "../ast/types.js";
import { FunScriptError } from "../errors.js";

export type RecordFieldInfo = { optional: boolean; defaultBinding?: string; fields?: Map<string, RecordFieldInfo> };

interface MatchEmitterContext {
  emitExpression(expression: Expression): string;
  emitFunctionBody(body: FunctionBody): string;
  emitArrowExpression(expression: Expression): string;
  emitBindingTarget(target: BindingTarget | Pattern): string;
  emitStringLiteral(literal: StringLiteral): string;
  recordField(expression: Expression): RecordFieldInfo | undefined;
  isOptionalParameter(name: string): boolean;
  isOptionalValue(expression: Expression): boolean;
  requireTsPattern(): void;
  enterOptionalPayload(name: string, fields: Map<string, RecordFieldInfo>, arm: MatchArm): void;
  leaveOptionalPayload(): void;
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
        const body = arm.body.kind === "BlockStatement" ? `(() => {\n${this.context.emitFunctionBody(arm.body)}\n})()` : this.context.emitExpression(arm.body);

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
    let code = isPipe ? `(($v) => match($v)` : `match(${this.context.emitExpression(expr.scrutinee!)})`;
    const optionalRecord = expr.scrutinee ? this.context.recordField(expr.scrutinee) : undefined;
    const payloadFields = optionalRecord?.optional ? optionalRecord.fields : undefined;

    const hasWildcard = expr.arms.some((a) => a.pattern.kind === "WildcardPattern");
    const lastArm = expr.arms[expr.arms.length - 1];
    const isBooleanLiteralPattern = (p: Pattern): p is LiteralPattern & { literal: BooleanLiteral } =>
      p.kind === "LiteralPattern" && p.literal.kind === "BooleanLiteral";
    const lastArmIsUnguardedBool = Boolean(
      lastArm && !lastArm.guard && isBooleanLiteralPattern(lastArm.pattern)
    );
    const oppositeBoolValue = lastArmIsUnguardedBool
      ? !(lastArm.pattern as any).literal.value
      : undefined;
    const hasOppositeUnguarded =
      oppositeBoolValue !== undefined &&
      expr.arms
        .slice(0, -1)
        .some((a) => !a.guard && isBooleanLiteralPattern(a.pattern) && a.pattern.literal.value === oppositeBoolValue);
    const isExhaustiveBooleanMatch = !hasWildcard && lastArmIsUnguardedBool && hasOppositeUnguarded;

    for (let i = 0; i < expr.arms.length; i++) {
      const arm = expr.arms[i];
      const isLastArm = i === expr.arms.length - 1;
      let payloadName: string | undefined;
      if (payloadFields) {
        const pat = arm.pattern;
        if (pat.kind === "ConstructorPattern" && pat.constructorName.name === "Some" && pat.args.length === 1 && pat.args[0].kind === "VariablePattern") {
          payloadName = pat.args[0].name.name;
        } else if (!(pat.kind === "WildcardPattern" || (pat.kind === "ConstructorPattern" && pat.constructorName.name === "None" && pat.args.length === 0))) {
          throw new FunScriptError("Match an optional record with Some(name), None, or _", pat.span);
        }
      }
      if (payloadName && payloadFields) {
        this.context.enterOptionalPayload(payloadName, payloadFields, arm);
      }
      try {
      if (arm.pattern.kind === "WildcardPattern" || (isExhaustiveBooleanMatch && isLastArm)) {
        const body = this.emitArmHandler(arm.body, arm.pattern, expr.scrutinee);
        code += `\n  .otherwise(${body})`;
      } else {
        const pat = this.emitPattern(arm.pattern);
        const body = this.emitArmHandler(arm.body, arm.pattern, expr.scrutinee);
        if (arm.guard) {
          let guardFn: string;
          if (arm.pattern.kind === "RecordPattern") {
            const destructParts = this.collectRecordDestructuring(arm.pattern);
            const scrutineeName = expr.scrutinee?.kind === "Identifier" ? expr.scrutinee.name : undefined;
            if (destructParts.length > 0) {
              const lines = [
                ...(scrutineeName ? [`const ${scrutineeName} = $matched;`] : []),
                `const { ${destructParts.join(", ")} } = $matched;`,
                `return ${this.context.emitExpression(arm.guard)};`,
              ];
              guardFn = `($matched) => {\n    ${lines.join("\n    ")}\n  }`;
            } else if (scrutineeName) {
              guardFn = `(${scrutineeName}) => ${this.context.emitExpression(arm.guard)}`;
            } else {
              guardFn = `($matched) => ${this.context.emitExpression(arm.guard)}`;
            }
          } else if (arm.pattern.kind === "OrPattern" && arm.pattern.patterns.every((p) => p.kind === "RecordPattern")) {
            const scrutineeName = expr.scrutinee?.kind === "Identifier" ? expr.scrutinee.name : undefined;
            if (scrutineeName) {
              guardFn = `(${scrutineeName}) => ${this.context.emitExpression(arm.guard)}`;
            } else {
              guardFn = `($matched) => ${this.context.emitExpression(arm.guard)}`;
            }
          } else {
            const vars = this.collectPatternVariables(arm.pattern);
            if (vars.length > 0) {
              const some = arm.pattern.kind === "ConstructorPattern" && arm.pattern.constructorName.name === "Some" && arm.pattern.args.length === 1 && arm.pattern.args[0].kind === "VariablePattern" && vars.length === 1;
              const directOptional = expr.scrutinee?.kind === "Identifier" && this.context.isOptionalParameter(expr.scrutinee.name);
              const unpack = some && directOptional ? `const { value: ${vars[0]} } = $matched;` : some ? `const { _tag: _, ...__fields } = $matched;\n    const [${vars[0]}] = Object.values(__fields) as [typeof $matched extends import("effect").Option.Some<infer V> ? V : any];` : `const { _tag: _, ...__fields } = $matched as any;\n    const [${vars.join(", ")}] = Object.values(__fields) as any[];`;
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
      if ((pattern.literal as any).rawExpr) {
        return this.context.emitExpression((pattern.literal as any).rawExpr);
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

  private emitPattern(pat: Pattern): string {
    if (pat.kind === "WildcardPattern") return "P._";
    if (pat.kind === "LiteralPattern") {
      if (pat.literal.kind === "BooleanLiteral") return pat.literal.value ? "true" : "false";
      if (pat.literal.kind === "NumberLiteral") return `${pat.literal.value}`;
      return this.context.emitStringLiteral(pat.literal);
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
        } else if (el.kind === "VariablePattern" || el.kind === "WildcardPattern") {
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
    for (const f of pat.fields) {
      if (!f.pattern) {
        parts.push(f.key.name);
      } else if (f.pattern.kind === "VariablePattern") {
        parts.push(`${f.key.name}: ${f.pattern.name.name}`);
      } else if (f.pattern.kind === "RecordPattern") {
        const sub = this.collectRecordDestructuring(f.pattern);
        if (sub.length > 0) {
          parts.push(`${f.key.name}: { ${sub.join(", ")} }`);
        }
      } else if (f.pattern.kind === "ArrayPattern") {
        parts.push(`${f.key.name}: ${this.context.emitBindingTarget(f.pattern)}`);
      }
    }
    return parts;
  }

  private emitArmHandler(body: FunctionBody, pat?: Pattern, scrutinee?: Expression): string {
    if (pat?.kind === "RecordPattern") {
      const destructParts = this.collectRecordDestructuring(pat);
      const scrutineeName = scrutinee?.kind === "Identifier" ? scrutinee.name : undefined;

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
      const scrutineeName = scrutinee?.kind === "Identifier" ? scrutinee.name : undefined;
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

    if (pat?.kind === "OrPattern" && pat.patterns.every((p) => p.kind === "RecordPattern")) {
      const scrutineeName = scrutinee?.kind === "Identifier" ? scrutinee.name : undefined;
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
    const isOptional = scrutinee ? this.context.isOptionalValue(scrutinee) : false;
    if (pat?.kind === "ConstructorPattern" && pat.constructorName.name === "Some" && pat.args.length === 1) {
      const bindingTarget = this.context.emitBindingTarget(pat.args[0]);
      if (bindingTarget && bindingTarget !== "[]" && bindingTarget !== "{}") {
        const unpack = isOptional
          ? `const { value: ${bindingTarget} } = $matched;`
          : `const { value: ${bindingTarget} } = $matched as unknown as { value: typeof $matched extends import("effect").Option.Some<infer V> ? V : any };`;
        if (body.kind === "BlockStatement") return `($matched) => {\n    ${unpack}\n${this.context.emitFunctionBody(body)}\n  }`;
        return `($matched) => {\n    ${unpack}\n    return ${this.context.emitExpression(body)};\n  }`;
      }
      if (body.kind === "BlockStatement") return `() => {\n${this.context.emitFunctionBody(body)}\n}`;
      return `() => ${this.context.emitArrowExpression(body)}`;
    }
    if (vars.length > 0) {
      const unpack = `const { _tag: _, ...__fields } = $matched as any;\n    const [${vars.join(", ")}] = Object.values(__fields) as any[];`;
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
    if (pat.kind === "RestPattern") {
      return this.collectPatternVariables(pat.argument);
    }
    return [];
  }

}
