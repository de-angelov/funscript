import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { transformSync } from "esbuild";
import { createRequire } from "node:module";
import * as path from "node:path";
import repl, { Recoverable, type REPLServer } from "node:repl";
import vm from "node:vm";
import { compileString, type CompileResult } from "../compiler.js";
import { typeCheckSource } from "../compiler/check.js";
import {
  isEffectOnlyFile,
  isPathPolicyEnabled,
  loadProjectConfig,
} from "../compiler/project-config.js";
import { FUNSCRIPT_VERSION } from "../version.js";

const replProjectRoot = process.cwd();
const replProjectConfig = loadProjectConfig(replProjectRoot);
const replFile = path.join(replProjectRoot, "repl.fun");
const replPolicyOptions = {
  noTs: isPathPolicyEnabled(replProjectConfig.noTs, replProjectRoot, replFile),
  noGlobalThis: isPathPolicyEnabled(
    replProjectConfig.noGlobalThis,
    replProjectRoot,
    replFile,
  ),
  noOptional: isPathPolicyEnabled(
    replProjectConfig.noOptional,
    replProjectRoot,
    replFile,
  ),
  barePipelines: isPathPolicyEnabled(
    replProjectConfig.barePipelines,
    replProjectRoot,
    replFile,
  ),
  noDeepDestructure: isPathPolicyEnabled(
    replProjectConfig.noDeepDestructure,
    replProjectRoot,
    replFile,
  ),
  maxDestructureDepth: replProjectConfig.maxDestructureDepth,
  effectOnly: isEffectOnlyFile(replProjectConfig, replProjectRoot, replFile),
  effectOnlyDirectories: replProjectConfig.effectOnly,
  policyRoot: replProjectRoot,
};

const compileReplSource = (source: string) =>
  compileString(source, replFile, { sourcemap: false, ...replPolicyOptions });

export interface ReplOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  prompt?: string;
  terminal?: boolean;
  useColors?: boolean;
  preview?: boolean;
  showBanner?: boolean;
}

/**
 * Extracts a clean error message from an Effect/Compiler failure.
 */
export function extractErrorMessage(err: unknown): string {
  if (!err) return "Unknown error";
  if (typeof err === "object") {
    const causeSymbol = Symbol.for("effect/Runtime/FiberFailure/Cause");
    const cause = (err as Record<symbol | string, unknown>)[causeSymbol] as
      { error?: { message?: string } } | undefined;
    if (cause?.error?.message) {
      return cause.error.message;
    }
    const errObj = err as { error?: { message?: string }; message?: unknown };
    if (errObj.error?.message) {
      return errObj.error.message;
    }
    if (typeof errObj.message === "string") {
      if (errObj.message.startsWith("{") && errObj.message.endsWith("}")) {
        try {
          const parsed = JSON.parse(errObj.message);
          if (parsed.message) return parsed.message;
        } catch {}
      }
      return errObj.message;
    }
  }
  if (typeof err === "string") return err;
  if (
    typeof err === "number" ||
    typeof err === "boolean" ||
    typeof err === "bigint"
  ) {
    return String(err);
  }
  return JSON.stringify(err) ?? "Unknown error";
}

/**
 * Adjusts line and column numbers in error messages when an expression
 * was wrapped inside a multi-line template.
 */
export function adjustErrorLocation(message: string): string {
  return message.replace(/at line (\d+), col (\d+)/g, (_, l, c) => {
    const line = Math.max(1, Number(l) - 1);
    const col = Math.max(1, Number(c) - 2);
    return `at line ${line}, col ${col}`;
  });
}

/**
 * Determines whether an error indicates that more lines of input are expected.
 */
export function isRecoverable(err: unknown): boolean {
  const msg = extractErrorMessage(err);
  return (
    /unexpected end of input/i.test(msg) ||
    /expected '\)'/i.test(msg) ||
    /expected '\]'/i.test(msg) ||
    /expected '\}'/i.test(msg) ||
    /expected '\}' to close effect block/i.test(msg) ||
    /expected indent/i.test(msg) ||
    /expected newline after/i.test(msg) ||
    /unterminated string/i.test(msg) ||
    /unexpected token ''/i.test(msg) ||
    /expected unindent/i.test(msg) ||
    /expected expression/i.test(msg) ||
    /effect block must end with an explicit/i.test(msg) ||
    /non-final bare expression in effect block/i.test(msg)
  );
}

/**
 * Wraps an expression so that the FunScript compiler treats it as a binding expression.
 */
export function wrapExpression(expr: string): string {
  const lines = expr.split("\n").map((line) => "  " + line);
  return `__repl_res =\n` + lines.join("\n");
}

/**
 * Compiles a line or block of FunScript code into executable JavaScript for the REPL context.
 */
const replDeclarations = new WeakMap<vm.Context, Map<string, string>>();

export async function compileReplCode(
  input: string,
  declarations = new Map<string, string>(),
): Promise<{ jsCode: string; isExpression: boolean }> {
  const trimmed = input.trim();
  if (!trimmed) {
    return { jsCode: "", isExpression: false };
  }

  const isLikelyDecl =
    /^\s*(export\s+|schema\s+|error\s+|service\s+|import\s+|mut\s+|[a-z_][a-zA-Z0-9_]*\s*(:[^=]+)?=(?!=))/.test(
      trimmed,
    ) && !/^\s*(match\b|effect\b)/.test(trimmed);

  let compiled: CompileResult;
  let checkedSource = trimmed;
  let tsCode = "";
  let isExpression = false;

  if (isLikelyDecl) {
    try {
      const res = await Effect.runPromise(compileReplSource(trimmed));
      compiled = res;
      tsCode = res.typescript;
      isExpression = false;
    } catch (declErr: unknown) {
      try {
        const res = await Effect.runPromise(
          compileReplSource(wrapExpression(trimmed)),
        );
        compiled = res;
        tsCode = res.typescript;
        isExpression = true;
      } catch {
        throw declErr;
      }
    }
  } else {
    try {
      const res = await Effect.runPromise(
        compileReplSource(wrapExpression(trimmed)),
      );
      compiled = res;
      tsCode = res.typescript;
      isExpression = true;
    } catch (exprErr: unknown) {
      try {
        const res = await Effect.runPromise(compileReplSource(trimmed));
        compiled = res;
        tsCode = res.typescript;
        isExpression = false;
      } catch {
        throw exprErr;
      }
    }
  }

  checkedSource = isExpression ? wrapExpression(trimmed) : trimmed;
  const nextDeclarations = new Map(declarations);
  for (const [index, node] of compiled!.ast.body.entries()) {
    const declaration =
      node.kind === "ExportDeclaration" ? node.declaration : node;
    const snippet = checkedSource.slice(
      node.span.start.offset,
      compiled!.ast.body[index + 1]?.span.start.offset,
    );
    const key =
      "id" in declaration && "name" in declaration.id
        ? declaration.id.name
        : snippet;
    nextDeclarations.set(key, snippet);
  }
  // These modules are provided by setupReplContext. Ambient globals avoid
  // duplicate imports when the emitter also injects an Effect helper.
  const globals = `ts { declare global { ${[
    "Effect",
    "Console",
    "Option",
    "Result",
    "Duration",
    "pipe",
  ]
    .map((name) => `const ${name}: typeof import('effect').${name};`)
    .join(" ")} } export {}; }`;
  const result = await Effect.runPromise(
    typeCheckSource(
      [globals, ...nextDeclarations.values()].join("\n"),
      replFile,
      {
        noGlobalThis: replPolicyOptions.noGlobalThis,
        noOptional: replPolicyOptions.noOptional,
        barePipelines: replPolicyOptions.barePipelines,
        noDeepDestructure: replPolicyOptions.noDeepDestructure,
        maxDestructureDepth: replPolicyOptions.maxDestructureDepth,
        cwd: replProjectRoot,
      },
    ),
  );
  if (!result.success) throw new Error(result.formattedOutput);

  if (!isExpression) {
    declarations.clear();
    for (const [key, source] of nextDeclarations) declarations.set(key, source);
  }

  const transformed = transformSync(tsCode, { loader: "ts", format: "cjs" });
  let jsCode = transformed.code.replace(
    /\b(const|let)\s+([a-zA-Z0-9_$]+)/g,
    "var $2",
  );
  if (isExpression) {
    jsCode += "\n;__repl_res;";
  }

  return { jsCode, isExpression };
}

/**
 * Evaluates a line or block of FunScript code in a given VM context,
 * auto-awaiting Effect and Promise values.
 */
export async function evaluateReplLine(
  input: string,
  context: vm.Context,
): Promise<unknown> {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  let compiled: { jsCode: string; isExpression: boolean };
  let pendingDeclarations: Map<string, string>;
  try {
    const declarations = new Map(replDeclarations.get(context));
    compiled = await compileReplCode(trimmed, declarations);
    // Keep types only after evaluation succeeds.
    pendingDeclarations = declarations;
  } catch (err: unknown) {
    const rawMsg = extractErrorMessage(err);
    const msg = adjustErrorLocation(rawMsg);
    const error = new Error(msg);
    (error as Error & { raw?: unknown }).raw = err;
    throw error;
  }

  if (!compiled.jsCode) {
    return undefined;
  }

  let value = vm.runInContext(compiled.jsCode, context);
  if (Effect.isEffect(value)) {
    value = await Effect.runPromise(
      value as Effect.Effect<unknown, unknown, never>,
    );
  } else if (value != null && typeof value.then === "function") {
    value = await value;
  }

  replDeclarations.set(context, pendingDeclarations!);
  return compiled.isExpression ? value : undefined;
}

/**
 * Sets up the standard FunScript environment in a VM context.
 */
export function setupReplContext(context: vm.Context): void {
  try {
    context.require = createRequire(
      path.resolve(process.cwd(), "package.json"),
    );
  } catch {
    context.require = createRequire(import.meta.url);
  }

  context.Effect = Effect;
  context.Console = Console;
  context.Option = Option;
  context.Result = Result;
  context.Duration = Duration;
  context.pipe = pipe;
  context.global = context;
  context.globalThis = context;
}

/**
 * Creates the custom evaluator function for node:repl.
 */
export function createReplEvaluator(): repl.REPLEval {
  let pendingEvaluations = Promise.resolve();

  return async function evalFunScript(
    cmd: string,
    context: vm.Context,
    _filename: string,
    callback: (err: Error | null, result?: unknown) => void,
  ) {
    const trimmed = cmd.trim();
    if (!trimmed) {
      return callback(null, undefined);
    }

    const evaluation = pendingEvaluations.then(async () => {
      try {
        const result = await evaluateReplLine(cmd, context);
        callback(null, result);
      } catch (err: unknown) {
        const raw = (err as { raw?: unknown })?.raw;
        if (isRecoverable(raw || err)) {
          return callback(
            new Recoverable(
              err instanceof Error ? err : new Error(String(err)),
            ),
          );
        }
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    });
    pendingEvaluations = evaluation.then(
      () => undefined,
      () => undefined,
    );
    await evaluation;
  };
}

/**
 * Starts a custom FunScript interactive REPL using Node's native node:repl module.
 */
export function startRepl(options: ReplOptions = {}): REPLServer {
  const prompt = options.prompt ?? "funscript> ";
  const isTty =
    options.terminal ?? (process.stdin.isTTY && process.stdout.isTTY);

  if (options.showBanner ?? isTty) {
    const outputStream = options.output ?? process.stdout;
    outputStream.write(
      `FunScript ${FUNSCRIPT_VERSION} Interactive REPL\nType expressions, pipelines, or declarations. Press Ctrl+C or Ctrl+D to exit.\n\n`,
    );
  }

  const server = repl.start({
    prompt,
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    terminal: options.terminal,
    useColors: options.useColors,
    preview: options.preview ?? false,
    eval: createReplEvaluator(),
  });

  setupReplContext(server.context);

  server.on("reset", () => {
    setupReplContext(server.context);
  });

  return server;
}
