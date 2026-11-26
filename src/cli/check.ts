import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { typeCheckFiles, type TypeCheckDiagnostic } from "../compiler/check.js";
import { FunScriptError, toErrorMessage } from "../errors.js";
import {
  loadFormatConfigForFile,
  type FunScriptProjectConfig,
} from "../compiler/project-config.js";
import { format } from "../formatter/index.js";
import { auditIdiomaticFunScript } from "../tooling/idiomatic.js";
import { convertPipelineStyle } from "../tooling/pipeline-style.js";
import { checkNoTsPaths, findFunFiles } from "./io.js";
import { collectCliFiles } from "./typecheck.js";

let projectPolicy: FunScriptProjectConfig = {};
const checkNoTsPathsProxy = (
  targets: string[],
  effectOnly = false,
  ownedOutputs?: ReadonlyMap<string, string>,
  quiet = false,
) => checkNoTsPaths(targets, effectOnly, ownedOutputs, quiet, projectPolicy);

export const checkCommand = (
  args: string[],
  initialProjectPolicy: FunScriptProjectConfig = {},
) =>
  Effect.gen(function* () {
    projectPolicy = initialProjectPolicy;
    const isIdiomatic = args.includes("--idiomatic");
    const jsonOutput = args.includes("--json");
    const sarifOutput = args.includes("--sarif");
    const warningsAsErrors = args.includes("--warnings-as-errors");
    const isFix = args.includes("--fix");
    if (jsonOutput && sarifOutput) {
      process.exitCode = 1;
      return yield* Console.error(
        "Choose one diagnostic format: --json or --sarif.",
      );
    }
    const rawFileArgs = args.filter((arg) => !arg.startsWith("--"));

    let filesToCheck: string[] = [];
    if (rawFileArgs.length === 0) {
      const hasSrc = yield* Effect.tryPromise({
        try: async () => {
          const s = await fs.stat("src");
          return s.isDirectory();
        },
        catch: () => false,
      });
      const searchDir = hasSrc ? "src" : ".";
      if (
        (args.includes("--no-ts") ||
          projectPolicy.noTs === true ||
          projectPolicy.effectOnly?.length ||
          Array.isArray(projectPolicy.noTs)) &&
        !(yield* checkNoTsPathsProxy(
          [searchDir],
          !(args.includes("--no-ts") || projectPolicy.noTs === true),
        ))
      )
        return;
      filesToCheck = yield* Effect.tryPromise({
        try: () => findFunFiles(searchDir),
        catch: (error: unknown) =>
          new Error(
            `Failed to scan files in '${searchDir}': ${toErrorMessage(error)}`,
          ),
      });
      if (filesToCheck.length === 0) {
        return yield* Console.error(
          "Usage: funscript check [file.fun|file.funx...] [--idiomatic] [--no-ts]",
        );
      }
    } else {
      if (
        (args.includes("--no-ts") ||
          projectPolicy.noTs === true ||
          projectPolicy.effectOnly?.length ||
          Array.isArray(projectPolicy.noTs)) &&
        !(yield* checkNoTsPathsProxy(
          rawFileArgs,
          !(args.includes("--no-ts") || projectPolicy.noTs === true),
        ))
      )
        return;
      for (const target of rawFileArgs) {
        const stat = yield* Effect.tryPromise({
          try: () => fs.stat(target),
          catch: (error: unknown) =>
            new Error(
              `File or directory '${target}' not found: ${toErrorMessage(error)}`,
            ),
        });
        if (stat.isDirectory()) {
          const nested = yield* Effect.tryPromise({
            try: () => findFunFiles(target),
            catch: (error: unknown) =>
              new Error(
                `Failed to scan files in '${target}': ${toErrorMessage(error)}`,
              ),
          });
          filesToCheck.push(...nested);
        } else {
          filesToCheck.push(target);
        }
      }
    }

    if (isFix) {
      let fixedCount = 0;
      for (const target of filesToCheck) {
        try {
          const original = yield* Effect.tryPromise({
            try: () => fs.readFile(target, "utf-8"),
            catch: () => "",
          });
          if (!original) continue;

          let updated = original;

          if (
            args.includes("--bare-pipelines") ||
            projectPolicy.barePipelines === true
          ) {
            const pipeRes = convertPipelineStyle(
              updated,
              path.resolve(target),
              "bare",
            );
            if (pipeRes.changed) {
              updated = pipeRes.text;
            }
          }

          const formatConfig = loadFormatConfigForFile(path.resolve(target));
          const formatted = format(updated, {
            ...formatConfig,
            filename: path.resolve(target),
          });
          if (formatted !== original) {
            yield* Effect.tryPromise({
              try: () => fs.writeFile(target, formatted, "utf-8"),
              catch: (err: unknown) =>
                new Error(`Failed writing '${target}': ${toErrorMessage(err)}`),
            });
            fixedCount++;
            if (!jsonOutput && !sarifOutput) {
              yield* Console.log(`✓ Fixed ${target}`);
            }
          }
        } catch (error) {
          /* Skip unfixable files */
          if (!(error instanceof FunScriptError)) throw error;
        }
      }
      if (fixedCount > 0 && !jsonOutput && !sarifOutput) {
        yield* Console.log(
          `✓ Fixed formatting and style in ${fixedCount} file${fixedCount === 1 ? "" : "s"}.`,
        );
      }
    }

    let idiomaticPassed = true;
    const idiomaticDiagnostics: Array<{
      file: string;
      line: number;
      column: number;
      message: string;
    }> = [];
    if (isIdiomatic) {
      for (const target of filesToCheck) {
        const source = yield* Effect.tryPromise({
          try: () => fs.readFile(target, "utf-8"),
          catch: () => "",
        });
        const audit = auditIdiomaticFunScript(source, target);
        if (!audit.success) {
          idiomaticPassed = false;
          for (const d of audit.diagnostics) {
            idiomaticDiagnostics.push({
              file: d.file,
              line: d.line,
              column: d.column,
              message: d.message,
            });
            if (!jsonOutput && !sarifOutput)
              yield* Console.error(
                `${d.file}:${d.line}:${d.column} - error: ${d.message}`,
              );
          }
        }
      }
    }

    const allFiles = yield* collectCliFiles(filesToCheck);
    const result = yield* typeCheckFiles(allFiles, {
      noTs: args.includes("--no-ts"),
      noGlobalThis: args.includes("--no-global-this"),
      barePipelines: args.includes("--bare-pipelines"),
      noDeepDestructure:
        args.includes("--no-deep-destructure") ||
        projectPolicy.noDeepDestructure === true,
      maxDestructureDepth: projectPolicy.maxDestructureDepth,
      effectOnly: projectPolicy.effectOnly,
      noTsPaths: Array.isArray(projectPolicy.noTs)
        ? projectPolicy.noTs
        : undefined,
      noGlobalThisPaths: Array.isArray(projectPolicy.noGlobalThis)
        ? projectPolicy.noGlobalThis
        : undefined,
      barePipelinesPaths: Array.isArray(projectPolicy.barePipelines)
        ? projectPolicy.barePipelines
        : undefined,
      noDeepDestructurePaths: Array.isArray(projectPolicy.noDeepDestructure)
        ? projectPolicy.noDeepDestructure
        : undefined,
      allowHoles: projectPolicy.allowHoles === true,
      allowHolesPaths: Array.isArray(projectPolicy.allowHoles)
        ? projectPolicy.allowHoles
        : undefined,
      allowEarlyReturns: projectPolicy.allowEarlyReturns === true,
      allowEarlyReturnsPaths: Array.isArray(projectPolicy.allowEarlyReturns)
        ? projectPolicy.allowEarlyReturns
        : undefined,
    });
    const success =
      result.success &&
      idiomaticPassed &&
      !(warningsAsErrors && result.warningCount > 0);
    if (warningsAsErrors && result.warningCount > 0) process.exitCode = 1;
    const diagnostics = (
      result.diagnostics as (TypeCheckDiagnostic & { code?: string | number })[]
    )
      .map((diagnostic) => ({
        file: diagnostic.file,
        line: diagnostic.line,
        column: diagnostic.column,
        endLine: diagnostic.endLine,
        endColumn: diagnostic.endColumn,
        severity: diagnostic.category,
        code: diagnostic.diagnosticCode ?? diagnostic.code,
        message: diagnostic.message,
        explanation: diagnostic.explanation,
        help: diagnostic.suggestedAction,
      }))
      .concat(
        idiomaticDiagnostics.map((diagnostic) => ({
          ...diagnostic,
          severity: "error",
          code: "FS_IDIOMATIC",
          explanation: undefined,
          help: undefined,
          endLine: undefined,
          endColumn: undefined,
        })),
      );
    if (jsonOutput) {
      if (!success) process.exitCode = 1;
      yield* Console.log(
        JSON.stringify({
          success,
          errorCount: result.errorCount + idiomaticDiagnostics.length,
          warningCount: result.warningCount,
          diagnostics,
        }),
      );
    } else if (sarifOutput) {
      if (!success) process.exitCode = 1;
      const rules = [
        ...new Map(
          diagnostics.map((diagnostic) => [
            diagnostic.code ?? "FS_DIAGNOSTIC",
            {
              id: diagnostic.code ?? "FS_DIAGNOSTIC",
              shortDescription: { text: diagnostic.message.slice(0, 120) },
              ...(diagnostic.explanation
                ? { fullDescription: { text: diagnostic.explanation } }
                : {}),
              ...(diagnostic.help ? { help: { text: diagnostic.help } } : {}),
            },
          ]),
        ).values(),
      ];
      const results = diagnostics.map((diagnostic) => ({
        ruleId: diagnostic.code ?? "FS_DIAGNOSTIC",
        level:
          diagnostic.severity === "error"
            ? "error"
            : diagnostic.severity === "warning"
              ? "warning"
              : "note",
        message: { text: diagnostic.message },
        locations: [
          {
            physicalLocation: {
              artifactLocation: {
                uri: pathToFileURL(path.resolve(diagnostic.file)).href,
              },
              region: {
                startLine: diagnostic.line,
                startColumn: diagnostic.column,
                ...(diagnostic.endLine ? { endLine: diagnostic.endLine } : {}),
                ...(diagnostic.endColumn
                  ? { endColumn: diagnostic.endColumn }
                  : {}),
              },
            },
          },
        ],
        ...(diagnostic.explanation || diagnostic.help
          ? {
              properties: {
                explanation: diagnostic.explanation,
                help: diagnostic.help,
              },
            }
          : {}),
      }));
      process.stdout.write(
        `${JSON.stringify({ $schema: "https://json.schemastore.org/sarif-2.1.0.json", version: "2.1.0", runs: [{ tool: { driver: { name: "FunScript", rules } }, results }] }, null, 2)}\n`,
      );
    } else if (!success) {
      process.exitCode = 1;
      if (!result.success || (warningsAsErrors && result.warningCount > 0)) {
        yield* Console.error(result.formattedOutput);
      }
    } else {
      if (filesToCheck.length === 1) {
        yield* Console.log(
          `✓ ${filesToCheck[0]} checked successfully (${result.errorCount} errors, ${result.warningCount} warnings)`,
        );
      } else {
        yield* Console.log(
          `✓ Checked ${filesToCheck.length} files successfully (${result.errorCount} errors, ${result.warningCount} warnings)`,
        );
      }
    }
  });
