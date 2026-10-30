import repl, { type REPLServer, Recoverable } from "node:repl";
import vm from "node:vm";
import { createRequire } from "node:module";
import * as path from "node:path";
import { transformSync } from "esbuild";
import { Effect, Console, Option, Either, Duration, pipe } from "effect";
import { compileString } from "../compiler.js";

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
export function extractErrorMessage(err: any): string {
  if (!err) return "Unknown error";
  const causeSymbol = Symbol.for("effect/Runtime/FiberFailure/Cause");
  const cause = err[causeSymbol];
  if (cause?.error?.message) {
    return cause.error.message;
  }
  if (err.error?.message) {
    return err.error.message;
  }
  if (typeof err.message === "string") {
    if (err.message.startsWith("{") && err.message.endsWith("}")) {
      try {
        const parsed = JSON.parse(err.message);
        if (parsed.message) return parsed.message;
      } catch {}
    }
    return err.message;
  }
  return String(err);
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
export function isRecoverable(err: any): boolean {
  const msg = extractErrorMessage(err);
  return (
    /unexpected end of input/i.test(msg) ||
    /expected '\)'/i.test(msg) ||
    /expected '\]'/i.test(msg) ||
    /expected '\}'/i.test(msg) ||
    /expected indent/i.test(msg) ||
    /expected newline after/i.test(msg) ||
    /unterminated string/i.test(msg) ||
    /unexpected token ''/i.test(msg) ||
    /expected unindent/i.test(msg) ||
    /expected expression/i.test(msg) ||
    /effect block must end with a return expression/i.test(msg) ||
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
export async function compileReplCode(input: string): Promise<{ jsCode: string; isExpression: boolean }> {
  const trimmed = input.trim();
  if (!trimmed) {
    return { jsCode: "", isExpression: false };
  }

  const isLikelyDecl =
    /^\s*(export\s+|schema\s+|error\s+|service\s+|import\s+|mut\s+|fn\s+|[a-z_][a-zA-Z0-9_]*\s*(\:[^=]+)?=(?!=))/.test(trimmed) &&
    !/^\s*(match\b|effect\b)/.test(trimmed);

  let tsCode = "";
  let isExpression = false;

  if (isLikelyDecl) {
    try {
      const res = await Effect.runPromise(compileString(trimmed, "repl.fun"));
      tsCode = res.typescript;
      isExpression = false;
    } catch (declErr: any) {
      try {
        const res = await Effect.runPromise(compileString(wrapExpression(trimmed), "repl.fun"));
        tsCode = res.typescript;
        isExpression = true;
      } catch {
        throw declErr;
      }
    }
  } else {
    try {
      const res = await Effect.runPromise(compileString(wrapExpression(trimmed), "repl.fun"));
      tsCode = res.typescript;
      isExpression = true;
    } catch (exprErr: any) {
      try {
        const res = await Effect.runPromise(compileString(trimmed, "repl.fun"));
        tsCode = res.typescript;
        isExpression = false;
      } catch {
        throw exprErr;
      }
    }
  }

  const transformed = transformSync(tsCode, { loader: "ts", format: "cjs" });
  let jsCode = transformed.code.replace(/\b(const|let)\s+([a-zA-Z0-9_$]+)/g, "var $2");
  if (isExpression) {
    jsCode += "\n;__repl_res;";
  }

  return { jsCode, isExpression };
}

/**
 * Evaluates a line or block of FunScript code in a given VM context,
 * auto-awaiting Effect and Promise values.
 */
export async function evaluateReplLine(input: string, context: vm.Context): Promise<any> {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  let compiled: { jsCode: string; isExpression: boolean };
  try {
    compiled = await compileReplCode(trimmed);
  } catch (err: any) {
    const rawMsg = extractErrorMessage(err);
    const msg = adjustErrorLocation(rawMsg);
    const error = new Error(msg);
    (error as any).raw = err;
    throw error;
  }

  if (!compiled.jsCode) {
    return undefined;
  }

  let value = vm.runInContext(compiled.jsCode, context);
  if (Effect.isEffect(value)) {
    value = await Effect.runPromise(value as Effect.Effect<any, any, never>);
  } else if (value != null && typeof (value as any).then === "function") {
    value = await value;
  }

  return compiled.isExpression ? value : undefined;
}

/**
 * Sets up the standard FunScript environment in a VM context.
 */
export function setupReplContext(context: vm.Context): void {
  try {
    context.require = createRequire(path.resolve(process.cwd(), "package.json"));
  } catch {
    context.require = createRequire(import.meta.url);
  }

  context.Effect = Effect;
  context.Console = Console;
  context.Option = Option;
  context.Either = Either;
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
    callback: (err: Error | null, result?: any) => void
  ) {
    const trimmed = cmd.trim();
    if (!trimmed) {
      return callback(null, undefined);
    }

    const evaluation = pendingEvaluations.then(async () => {
      try {
        const result = await evaluateReplLine(cmd, context);
        callback(null, result);
      } catch (err: any) {
        if (isRecoverable(err.raw || err)) {
          return callback(new Recoverable(err));
        }
        callback(err);
      }
    });
    pendingEvaluations = evaluation.then(() => undefined, () => undefined);
    await evaluation;
  };
}

/**
 * Starts a custom FunScript interactive REPL using Node's native node:repl module.
 */
export function startRepl(options: ReplOptions = {}): REPLServer {
  const prompt = options.prompt ?? "funscript> ";
  const isTty = options.terminal ?? (process.stdin.isTTY && process.stdout.isTTY);

  if (options.showBanner ?? isTty) {
    const outputStream = options.output ?? process.stdout;
    outputStream.write("FunScript 0.1.0 Interactive REPL\nType expressions, pipelines, or declarations. Press Ctrl+C or Ctrl+D to exit.\n\n");
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
