import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isFileNotFoundError } from "./errors.js";

/**
 * The version reported by the CLI, REPL and language server. Read from the
 * package manifest so every entry point agrees with `package.json`.
 *
 * This module lives at `src/version.ts` and `dist/version.js`, so `../package.json`
 * resolves to the repository/package root in both source and build layouts.
 */
const readPackageVersion = (): string => {
  try {
    const manifest = fileURLToPath(new URL("../package.json", import.meta.url));
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch (error) {
    if (!isFileNotFoundError(error) && !(error instanceof SyntaxError)) {
      throw error;
    }
    return "0.0.0";
  }
};

export const FUNSCRIPT_VERSION = readPackageVersion();
