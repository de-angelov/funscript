#!/usr/bin/env node

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import {
  loadProjectConfig,
  type FunScriptProjectConfig,
} from "../compiler/project-config.js";
import { startLspServer } from "../lsp/index.js";
import { FUNSCRIPT_VERSION } from "../version.js";
import { buildCommand } from "./build.js";
import { checkCommand } from "./check.js";
import { renderCliHelp, validateCliArgs } from "./commands.js";
import { docCommand } from "./doc.js";
import { doctorCommand } from "./doctor.js";
import { emitCommand } from "./emit.js";
import { explainCommand } from "./explain.js";
import { fmtCommand } from "./fmt.js";
import { initProject } from "./init.js";
import { toErrorMessage } from "../errors.js";
import { findFunFiles } from "./io.js";
import { pipelineStyleCommand } from "./pipeline-style.js";
import { startRepl } from "./repl.js";
import { runCommand } from "./run.js";
import { testCommand } from "./test.js";
import { runTsc } from "./tsc.js";
import { checkCliFiles } from "./typecheck.js";

let projectPolicy: FunScriptProjectConfig = {};

const lspCommand = (_args: string[]) =>
  Effect.callback<void, Error>(() => {
    const server = startLspServer({
      reader: process.stdin,
      writer: process.stdout,
    });
    server.onExit((code) => setImmediate(() => process.exit(code)));
  });

const replCommand = (_args: string[]) =>
  Effect.callback<void, Error>((resume) => {
    const server = startRepl();
    server.on("exit", () => {
      resume(Effect.void);
    });
  });

const initCommand = (args: string[]) =>
  Effect.gen(function* () {
    const templateIndex = args.indexOf("--template");
    const template = templateIndex !== -1 ? args[templateIndex + 1] : undefined;
    const isForce = args.includes("--force");
    const targetDir =
      args.find(
        (arg, i) =>
          !arg.startsWith("-") &&
          (templateIndex === -1 ||
            (i !== templateIndex && i !== templateIndex + 1)),
      ) ?? ".";

    yield* initProject(targetDir, { template, force: isForce });
  });

const helpCommand = Console.log(renderCliHelp(FUNSCRIPT_VERSION));

const program = Effect.gen(function* () {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const commandArgs = argv.slice(1);
  if (command === "help") {
    const helpTarget = commandArgs.find((arg) => !arg.startsWith("-"));
    return yield* Console.log(renderCliHelp(FUNSCRIPT_VERSION, helpTarget));
  }
  if (command && commandArgs.some((arg) => arg === "--help" || arg === "-h")) {
    return yield* Console.log(renderCliHelp(FUNSCRIPT_VERSION, command));
  }
  if (
    command &&
    !["help", "-h", "--help", "--version", "-v"].includes(command)
  ) {
    const validationError = validateCliArgs(command, commandArgs);
    if (validationError) {
      process.exitCode = 1;
      return yield* Console.error(validationError);
    }
  }
  if (command && ["check", "build", "emit", "run", "tsc"].includes(command)) {
    projectPolicy = yield* Effect.try({
      try: () => loadProjectConfig(process.cwd()),
      catch: (error) =>
        error instanceof Error ? error : new Error(String(error)),
    });
    if (
      command !== "tsc" &&
      !(command === "build" && commandArgs.includes("--watch"))
    ) {
      if (projectPolicy.noTs === true && !commandArgs.includes("--no-ts"))
        commandArgs.push("--no-ts");
      if (
        projectPolicy.noGlobalThis === true &&
        !commandArgs.includes("--no-global-this")
      )
        commandArgs.push("--no-global-this");
      if (
        projectPolicy.noOptional === true &&
        !commandArgs.includes("--no-optional")
      )
        commandArgs.push("--no-optional");
      if (
        projectPolicy.barePipelines === true &&
        !commandArgs.includes("--bare-pipelines")
      )
        commandArgs.push("--bare-pipelines");
    }
  }

  switch (command) {
    case "build":
      return yield* buildCommand(commandArgs, projectPolicy);
    case "run":
      return yield* runCommand(commandArgs, projectPolicy);
    case "test":
      return yield* testCommand(commandArgs);
    case "init":
    case "new":
      return yield* initCommand(commandArgs);
    case "repl":
      return yield* replCommand(commandArgs);
    case "emit":
      return yield* emitCommand(commandArgs, projectPolicy);
    case "check":
      return yield* checkCommand(commandArgs, projectPolicy);
    case "tsc": {
      const hasSourcePolicy =
        projectPolicy.noTs === true ||
        (Array.isArray(projectPolicy.noTs) && projectPolicy.noTs.length > 0) ||
        projectPolicy.noGlobalThis === true ||
        (Array.isArray(projectPolicy.noGlobalThis) &&
          projectPolicy.noGlobalThis.length > 0) ||
        projectPolicy.noOptional === true ||
        (Array.isArray(projectPolicy.noOptional) &&
          projectPolicy.noOptional.length > 0) ||
        projectPolicy.barePipelines === true ||
        (Array.isArray(projectPolicy.barePipelines) &&
          projectPolicy.barePipelines.length > 0) ||
        !!projectPolicy.effectOnly?.length;
      if (hasSourcePolicy) {
        const hasSrc = yield* Effect.tryPromise({
          try: async () => (await fs.stat("src")).isDirectory(),
          catch: () => false,
        });
        const sourceRoot = hasSrc ? "src" : ".";
        const files = yield* Effect.tryPromise({
          try: () => findFunFiles(sourceRoot),
          catch: (error: unknown) =>
            new Error(
              `Failed to scan files in '${sourceRoot}': ${toErrorMessage(error)}`,
            ),
        });
        if (
          files.length &&
          !(yield* checkCliFiles(files, {
            noTs: projectPolicy.noTs === true,
            noGlobalThis: projectPolicy.noGlobalThis === true,
            noOptional: projectPolicy.noOptional === true,
            barePipelines: projectPolicy.barePipelines === true,
            effectOnly: projectPolicy.effectOnly,
            noTsPaths: Array.isArray(projectPolicy.noTs)
              ? projectPolicy.noTs
              : undefined,
            noGlobalThisPaths: Array.isArray(projectPolicy.noGlobalThis)
              ? projectPolicy.noGlobalThis
              : undefined,
            noOptionalPaths: Array.isArray(projectPolicy.noOptional)
              ? projectPolicy.noOptional
              : undefined,
            barePipelinesPaths: Array.isArray(projectPolicy.barePipelines)
              ? projectPolicy.barePipelines
              : undefined,
          }))
        )
          return;
      }
      const code = yield* Effect.tryPromise({
        try: () => runTsc(commandArgs),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      });
      process.exitCode = code;
      return;
    }
    case "lsp":
      return yield* lspCommand(commandArgs);
    case "pipeline-style":
      return yield* pipelineStyleCommand(commandArgs);
    case "fmt":
      return yield* fmtCommand(commandArgs);
    case "doctor":
      return yield* doctorCommand(commandArgs);
    case "explain":
      return yield* explainCommand(commandArgs);
    case "doc":
      return yield* docCommand(commandArgs);
    case "version":
    case "-v":
    case "--version":
      return yield* Console.log(`funscript ${FUNSCRIPT_VERSION}`);
    case "help":
    case "-h":
    case "--help":
    default:
      return yield* helpCommand;
  }
}).pipe(
  Effect.catch((err: unknown) => {
    process.exitCode = 1;
    return Console.error(`\x1b[31merror\x1b[0m: ${toErrorMessage(err)}`);
  }),
);

// Execute Effect program
void Effect.runPromise(program);
