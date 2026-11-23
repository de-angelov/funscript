import type {
  BindingDeclaration,
  BindingTarget,
  BlockStatement,
  EffectBlockExpression,
  Expression,
  FunctionBody,
  Identifier,
  IndexExpression,
  JsExpression,
  MemberExpression,
  MutBlockExpression,
  ParBlockExpression,
  Pattern,
  Statement,
  WhenStatement,
} from "../ast/types.js";
import { EFFECT_BUILTIN_MODULES } from "./types.js";

export interface StatementEmitterContext {
  emitExpression(expr: Expression): string;
  emitFunctionBody(body: FunctionBody): string;
  emitBindingDeclaration(decl: BindingDeclaration): string;
  emitBindingTarget(target: BindingTarget | Pattern): string;
  collectBindingNames(target: BindingTarget | Pattern): string[];
  emitJsExpression(expr: JsExpression): string;
  emitMemberProperty(expr: MemberExpression): string;
  activeDraftParams: Set<string>;
  effectModuleBindings: Set<string>;
  isUserBinding(name: string): boolean;
  addEffectImport(name: string): void;
}

export function emitArrowExpression(
  ctx: StatementEmitterContext,
  expr: Expression,
): string {
  const emitted = ctx.emitExpression(expr);
  return expr.kind === "RecordExpression" ? `(${emitted})` : emitted;
}

export function emitIndexTarget(
  ctx: StatementEmitterContext,
  expr: IndexExpression,
): string {
  return `${ctx.emitExpression(expr.object)}[${ctx.emitExpression(expr.index)}]`;
}

export function emitStatement(
  ctx: StatementEmitterContext,
  stmt: Statement,
): string {
  if (stmt.kind === "BindingDeclaration") {
    return ctx.emitBindingDeclaration(stmt);
  }
  if (stmt.kind === "AssignmentStatement") {
    const target =
      stmt.target.kind === "Identifier"
        ? stmt.target.name
        : stmt.target.kind === "IndexExpression"
          ? emitIndexTarget(ctx, stmt.target)
          : stmt.target.path.map((p) => p.name).join(".");
    return `${target} = ${ctx.emitExpression(stmt.value)};`;
  }
  if (stmt.kind === "ReturnStatement") {
    if (
      (stmt.argument.kind === "Identifier" ||
        stmt.argument.kind === "UpperIdentifier") &&
      stmt.argument.name === "Unit"
    ) {
      return "return;";
    }
    const arg = ctx.emitExpression(stmt.argument);
    if (arg.startsWith("(") && arg.endsWith(")")) {
      return `return ${arg};`;
    }
    return `return (${arg});`;
  }
  if (stmt.kind === "WhenStatement") {
    return emitWhenStatement(ctx, stmt);
  }
  return `${ctx.emitExpression(stmt.expression)};`;
}

export function emitWhenStatement(
  ctx: StatementEmitterContext,
  stmt: WhenStatement,
  insideEffect = false,
): string {
  const cond = ctx.emitExpression(stmt.condition);
  if (stmt.isEarlyReturn) {
    const consequence = stmt.consequent as Expression;
    if (
      insideEffect &&
      consequence.kind === "CallExpression" &&
      consequence.callee.kind === "MemberExpression" &&
      consequence.callee.object.kind === "UpperIdentifier" &&
      consequence.callee.object.name === "Effect" &&
      consequence.callee.property.name === "fail"
    ) {
      return `if (${cond}) return yield* ${emitEffectCall(ctx, consequence)};`;
    }
    return `if (${cond}) return ${ctx.emitExpression(consequence)};`;
  }
  const body = stmt.consequent as BlockStatement;
  const stmts = body.statements
    .map((s) => "  " + emitStatement(ctx, s))
    .join("\n");
  const ret =
    body.finalExpression &&
    (body.finalExpression.kind !== "Identifier" ||
      body.finalExpression.name !== "_error")
      ? `  ${ctx.emitExpression(body.finalExpression)};`
      : "";
  const allStmts = [stmts, ret].filter(Boolean).join("\n");
  return `if (${cond}) {\n${allStmts}\n}`;
}

export function emitEffectCall(
  ctx: StatementEmitterContext,
  effectExpr: Expression,
): string {
  if (effectExpr.kind === "JsExpression") {
    return ctx.emitJsExpression(effectExpr);
  }
  if (effectExpr.kind === "ParBlockExpression") {
    return emitParBlockExpression(ctx, effectExpr);
  }
  if (effectExpr.kind === "EffectBlockExpression") {
    return emitEffectBlockExpression(ctx, effectExpr);
  }
  // Check if this is a direct service call: Service.method(args)
  if (
    effectExpr.kind === "CallExpression" &&
    effectExpr.callee.kind === "MemberExpression"
  ) {
    const obj = effectExpr.callee.object;
    if (obj.kind === "UpperIdentifier") {
      if (
        EFFECT_BUILTIN_MODULES.has(obj.name) ||
        ctx.effectModuleBindings.has(obj.name) ||
        obj.name === "Promise"
      ) {
        if (
          EFFECT_BUILTIN_MODULES.has(obj.name) &&
          !ctx.isUserBinding(obj.name)
        ) {
          ctx.addEffectImport(obj.name);
        }
        return `${obj.name}.${ctx.emitMemberProperty(effectExpr.callee)}(${effectExpr.args.map((a) => ctx.emitExpression(a)).join(", ")})`;
      }
      // Direct Service Call: Service.method(...) => (yield* Service).method(...)
      return `(yield* ${obj.name}).${effectExpr.callee.property.name}(${effectExpr.args.map((a) => ctx.emitExpression(a)).join(", ")})`;
    }
  }
  return ctx.emitExpression(effectExpr);
}

export function emitEffectBlockExpression(
  ctx: StatementEmitterContext,
  expr: EffectBlockExpression,
): string {
  ctx.addEffectImport("Effect");
  const statements = expr.body
    .map((s) => {
      if (s.kind === "EffectBindStatement") {
        return `    const ${ctx.emitBindingTarget(s.id)} = yield* ${emitEffectCall(ctx, s.effect)};`;
      }
      if (s.kind === "EffectDiscardStatement") {
        return `    yield* ${emitEffectCall(ctx, s.effect)};`;
      }
      if (s.kind === "BindingDeclaration") {
        return `    ${ctx.emitBindingDeclaration(s)}`;
      }
      if (s.kind === "AssignmentStatement") {
        const target =
          s.target.kind === "Identifier"
            ? s.target.name
            : s.target.kind === "IndexExpression"
              ? emitIndexTarget(ctx, s.target)
              : s.target.path.map((p) => p.name).join(".");
        return `    ${target} = ${ctx.emitExpression(s.value)};`;
      }
      if (s.kind === "WhenStatement") {
        return `    ${emitWhenStatement(ctx, s, true)}`;
      }
      return "";
    })
    .join("\n");

  const isUnit =
    (expr.finalExpression.kind === "Identifier" ||
      expr.finalExpression.kind === "UpperIdentifier") &&
    expr.finalExpression.name === "Unit";
  const ret = isUnit
    ? `    return;`
    : `    return ${ctx.emitExpression(expr.finalExpression)};`;
  const gen = `Effect.gen(function* () {\n${statements}\n${ret}\n  })`;
  if (expr.unscoped) {
    return gen;
  }
  return `Effect.scoped(${gen})`;
}

export function emitParBlockExpression(
  ctx: StatementEmitterContext,
  expr: ParBlockExpression,
): string {
  ctx.addEffectImport("Effect");
  const entries: string[] = [];
  const boundNames: string[] = [];
  const bindings: Array<{
    resultKey: string;
    target: BindingTarget | Pattern;
  }> = [];
  const usedNames = expr.body.flatMap((statement) =>
    statement.kind === "EffectBindStatement"
      ? ctx.collectBindingNames(statement.id)
      : [],
  );
  let syntheticIndex = 0;
  let hasDestructuring = false;

  for (const s of expr.body) {
    if (s.kind === "EffectBindStatement") {
      const isIdentifier = s.id.kind === "Identifier";
      hasDestructuring ||= !isIdentifier;
      let key = isIdentifier
        ? (s.id as Identifier).name
        : `__funscriptPar${syntheticIndex++}`;
      while (!isIdentifier && usedNames.includes(key)) {
        key = `__funscriptPar${syntheticIndex++}`;
      }
      const effectVal = emitEffectCall(ctx, s.effect);
      entries.push(
        `      ${isIdentifier ? key : JSON.stringify(key)}: ${effectVal}`,
      );
      bindings.push({ resultKey: key, target: s.id });
      if (isIdentifier) boundNames.push(key);
    } else if (s.kind === "EffectDiscardStatement") {
      const effectVal = emitEffectCall(ctx, s.effect);
      entries.push(`      _: ${effectVal}`);
    }
  }

  const concurrencyArg = expr.concurrency
    ? ctx.emitExpression(expr.concurrency)
    : `"inherit"`;
  const dict = `{\n${entries.join(",\n")}\n    }`;
  const allCall = `Effect.all(${dict}, { concurrency: ${concurrencyArg} })`;

  const isExactShorthand =
    !hasDestructuring &&
    (!expr.hasExplicitReturn ||
      (expr.finalExpression.kind === "RecordExpression" &&
        expr.finalExpression.entries.length === boundNames.length &&
        expr.finalExpression.entries.every((e, i) => {
          if (e.kind === "ShorthandEntry") {
            return e.key.name === boundNames[i];
          }
          if (e.kind === "FieldEntry") {
            return (
              e.key.name === boundNames[i] &&
              e.value.kind === "Identifier" &&
              e.value.name === boundNames[i]
            );
          }
          return false;
        })));

  if (isExactShorthand) {
    return allCall;
  }

  const emittedReturn = ctx.emitExpression(expr.finalExpression);
  const retExpr =
    expr.finalExpression.kind === "RecordExpression"
      ? `(${emittedReturn})`
      : emittedReturn;
  if (hasDestructuring) {
    let resultName = "__funscriptParResult";
    while (usedNames.includes(resultName)) resultName += "_";
    const declarations = bindings
      .map(
        ({ resultKey, target }) =>
          `  const ${ctx.emitBindingTarget(target)} = ${resultName}[${JSON.stringify(resultKey)}];`,
      )
      .join("\n");
    return `Effect.map(${allCall}, (${resultName}) => {\n${declarations}\n  return ${retExpr};\n})`;
  }
  return `Effect.map(${allCall}, ({ ${boundNames.join(", ")} }) => ${retExpr})`;
}

export function emitMutativeRecipe(
  ctx: StatementEmitterContext,
  expr: MutBlockExpression,
): string {
  ctx.activeDraftParams.add(expr.draftParam.name);
  try {
    const recipeBody =
      expr.body.kind === "BlockStatement" &&
      expr.body.finalExpression?.kind === "Identifier" &&
      expr.body.finalExpression.name === expr.draftParam.name
        ? ctx.emitFunctionBody({ ...expr.body, finalExpression: undefined })
        : ctx.emitFunctionBody(expr.body);
    return `(${expr.draftParam.name}) => {\n${recipeBody}\n}`;
  } finally {
    ctx.activeDraftParams.delete(expr.draftParam.name);
  }
}
