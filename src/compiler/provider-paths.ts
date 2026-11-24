import fs from "node:fs";
import path from "node:path";
import type {
  ProviderManifestV1,
  ProviderRequestV1,
} from "../providers/contract.js";

/** Resolve path arguments against host policy before calling provider code.
 * This authorizes inputs for a trusted provider; it does not sandbox that code.
 */
export function authorizeProviderPaths(
  manifest: ProviderManifestV1,
  declarationFile: string,
  args: ReadonlyArray<unknown>,
  authorizedRoots: ReadonlyArray<string>,
): ProviderRequestV1["paths"] {
  const fail = (): never => {
    throw new Error("Provider path validation failed");
  };
  try {
    if (
      !manifest ||
      !Array.isArray(manifest.parameters) ||
      !Array.isArray(args) ||
      !Array.isArray(authorizedRoots) ||
      typeof declarationFile !== "string"
    )
      return fail();

    const source = fs.realpathSync(declarationFile);
    const roots = authorizedRoots.map((root) => {
      if (typeof root !== "string") return fail();
      const real = fs.realpathSync(root);
      if (!fs.statSync(real).isDirectory()) return fail();
      return real;
    });
    const paths: { argumentIndex: number; canonicalPath: string }[] = [];
    for (let index = 0; index < manifest.parameters.length; index++) {
      const parameter = manifest.parameters[index];
      const value = args[index];
      if (
        !parameter ||
        !["string", "number", "boolean"].includes(parameter.kind)
      )
        return fail();
      if (value === undefined) {
        if (parameter.required) return fail();
        continue;
      }
      if (typeof value !== parameter.kind) return fail();
      if (!parameter.path) continue;
      if (parameter.kind !== "string" || typeof value !== "string" || !value)
        return fail();
      const candidate = fs.realpathSync(
        path.resolve(path.dirname(source), value),
      );
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) return fail();
      fs.accessSync(candidate, fs.constants.R_OK);
      if (
        !roots.some(
          (root) => candidate === root || candidate.startsWith(root + path.sep),
        )
      )
        return fail();
      paths.push({ argumentIndex: index, canonicalPath: candidate });
    }
    if (args.length > manifest.parameters.length) return fail();
    return paths;
  } catch {
    return fail();
  }
}
