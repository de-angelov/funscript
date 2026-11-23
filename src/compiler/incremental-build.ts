import * as Effect from "effect/Effect";
import * as path from "node:path";
import { compileString } from "../compiler.js";
import {
  createTypeCheckCache,
  typeCheckVirtualFiles,
  type CheckOptions,
  type TypeCheckResult,
} from "./check.js";
import { isEffectOnlyFile, isPathPolicyEnabled } from "./project-config.js";

export interface IncrementalBuildResult {
  check: TypeCheckResult;
  /** Generated TypeScript keyed by the input filename; empty when checking fails. */
  outputs: Record<string, string>;
  compiled: number;
  reused: number;
}

/**
 * Reusable, in-memory build session. Inputs are a complete snapshot for each
 * build. No files are written; callers choose how to publish the outputs.
 */
export class IncrementalBuildSession {
  private readonly cache = createTypeCheckCache();
  private busy = false;

  constructor(
    private readonly cwd: string = process.cwd(),
    private readonly options: Omit<CheckOptions, "cwd" | "cache"> = {},
  ) {}

  clear(): void {
    if (this.busy)
      throw new Error("Cannot clear an incremental build while it is running");
    this.cache.clear();
  }

  build(
    files: Record<string, string>,
  ): Effect.Effect<IncrementalBuildResult, Error> {
    return Effect.tryPromise({
      try: async () => {
        if (this.busy)
          throw new Error(
            "An incremental build is already running in this session",
          );
        this.busy = true;
        try {
          const cwd = path.resolve(this.cwd);
          const snapshot = { ...files };
          const before = new Map(this.cache.compiledFiles);
          const check = await Effect.runPromise(
            typeCheckVirtualFiles(snapshot, {
              ...this.options,
              cwd,
              cache: this.cache,
            }),
          );
          if (!check.success)
            return { check, outputs: {}, compiled: 0, reused: 0 };
          const virtualSources = new Map(
            Object.entries(snapshot).map(([file, source]) => [
              path.resolve(cwd, file),
              source,
            ]),
          );
          const outputs: Record<string, string> = {};
          let compiled = 0;
          let reused = 0;
          for (const [filename, source] of Object.entries(snapshot)) {
            const absolute = path.resolve(cwd, filename);
            const cached = this.cache.compiledFiles.get(absolute);
            if (cached) {
              outputs[filename] = cached.compiled.typescript;
              if (before.get(absolute) === cached) reused++;
              else compiled++;
            } else {
              const result = await Effect.runPromise(
                compileString(source, filename, {
                  sourcePath: absolute,
                  virtualSources,
                  sourcemap: false,
                  noTs:
                    !!this.options.noTs ||
                    isPathPolicyEnabled(this.options.noTsPaths, cwd, absolute),
                  noGlobalThis:
                    !!this.options.noGlobalThis ||
                    isPathPolicyEnabled(
                      this.options.noGlobalThisPaths,
                      cwd,
                      absolute,
                    ),
                  noOptional:
                    !!this.options.noOptional ||
                    isPathPolicyEnabled(
                      this.options.noOptionalPaths,
                      cwd,
                      absolute,
                    ),
                  barePipelines:
                    !!this.options.barePipelines ||
                    isPathPolicyEnabled(
                      this.options.barePipelinesPaths,
                      cwd,
                      absolute,
                    ),
                  effectOnly: isEffectOnlyFile(
                    { effectOnly: this.options.effectOnly },
                    cwd,
                    absolute,
                  ),
                  effectOnlyDirectories: this.options.effectOnly,
                  policyRoot: cwd,
                }),
              );
              outputs[filename] = result.typescript;
              compiled++;
            }
          }
          return { check, outputs, compiled, reused };
        } finally {
          this.busy = false;
        }
      },
      catch: (error) =>
        error instanceof Error ? error : new Error(String(error)),
    });
  }
}
