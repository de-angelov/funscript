import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { builtinModules, createRequire } from "node:module";
import * as path from "node:path";
import ts from "typescript";

const fileHashes = new Map<
  string,
  { stamp: string; hash: string; references: string[] }
>();
const builtins = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);

/**
 * Conservative fingerprint of an installed package and its declared runtime
 * dependencies. Unsupported resolution, missing peers, or unreadable files
 * return undefined so the caller recompiles instead of reusing stale output.
 */
export function packageFingerprint(
  specifier: string,
  fromFile: string,
): string | undefined {
  const packageName = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  if (!packageName || builtins.has(specifier) || specifier.startsWith("#"))
    return undefined;
  const visitedPackages = new Set<string>();
  const hash = createHash("sha256");
  const visitPackage = (name: string, from: string): void => {
    const require = createRequire(from);
    const resolved = require.resolve(name);
    if (!path.isAbsolute(resolved)) throw new Error("Non-file package");
    let dir = path.dirname(resolved);
    let root = "";
    for (;;) {
      const manifest = path.join(dir, "package.json");
      if (fs.existsSync(manifest)) {
        const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
        if (parsed.name === name) {
          root = fs.realpathSync(dir);
          break;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error("Package manifest not found");
      dir = parent;
    }
    if (visitedPackages.has(root)) return;
    visitedPackages.add(root);
    hash.update(JSON.stringify([name, root]));
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );
    const declared = new Set(
      Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      }),
    );
    const visitedDirs = new Set<string>();
    const walk = (dirPath: string, relative: string): void => {
      const real = fs.realpathSync(dirPath);
      if (path.relative(root, real).startsWith(`..${path.sep}`))
        throw new Error("Package directory escapes its root");
      if (visitedDirs.has(real)) return;
      visitedDirs.add(real);
      for (const entry of fs
        .readdirSync(dirPath, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          (entry.isDirectory() &&
            ["src", "test", "tests", "__tests__"].includes(entry.name))
        )
          continue;
        if (
          entry.isFile() &&
          !/\.(?:d\.)?(?:ts|mts|cts|tsx)$|\.(?:js|mjs|cjs|jsx|json)$/.test(
            entry.name,
          )
        )
          continue;
        const file = path.join(dirPath, entry.name);
        const rel = path.join(relative, entry.name);
        const stat = fs.statSync(file, { bigint: true });
        if (stat.isDirectory()) {
          walk(file, rel);
          continue;
        }
        if (!stat.isFile()) throw new Error("Unsupported package entry");
        const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        let cached = fileHashes.get(file);
        if (!cached || cached.stamp !== stamp) {
          const references: string[] = [];
          const isScript = /\.(?:js|mjs|cjs|jsx)$/.test(file);
          const content = isScript ? undefined : fs.readFileSync(file);
          if (/\.(?:ts|mts|cts|tsx)$/.test(file) && content) {
            const preprocessed = ts.preProcessFile(
              content.toString("utf8"),
              true,
              true,
            );
            references.push(
              ...preprocessed.importedFiles.map((item) => item.fileName),
            );
            references.push(
              ...preprocessed.referencedFiles.map((item) => item.fileName),
            );
            for (const item of preprocessed.typeReferenceDirectives)
              references.push(`@types/${item.fileName}`);
          }
          cached = {
            stamp,
            hash: content
              ? createHash("sha256").update(content).digest("hex")
              : stamp,
            references,
          };
          if (fileHashes.size >= 20000) fileHashes.clear();
          fileHashes.set(file, cached);
        }
        const realFile = fs.realpathSync(file);
        if (path.relative(root, realFile).startsWith(`..${path.sep}`))
          throw new Error("Package file escapes its root");
        for (const reference of cached.references) {
          if (reference.startsWith(".")) {
            const target = path.resolve(path.dirname(realFile), reference);
            const relativeTarget = path.relative(root, target);
            if (
              relativeTarget === ".." ||
              relativeTarget.startsWith(`..${path.sep}`) ||
              relativeTarget
                .split(path.sep)
                .some((part) =>
                  [
                    "src",
                    "test",
                    "tests",
                    "__tests__",
                    "node_modules",
                  ].includes(part),
                )
            )
              throw new Error("Declaration references untracked files");
          } else {
            const dependency = reference.startsWith("@")
              ? reference.split("/").slice(0, 2).join("/")
              : reference.split("/")[0];
            if (dependency !== name && !declared.has(dependency))
              throw new Error("Undeclared package reference");
          }
        }
        hash.update(JSON.stringify([rel, realFile, cached.hash]));
      }
    };
    walk(root, "");
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    }).sort()) {
      visitPackage(dependency, path.join(root, "package.json"));
    }
  };
  try {
    // Resolve the actual subpath as well: a changed exports map can alter it.
    const resolved = createRequire(fromFile).resolve(specifier);
    if (!path.isAbsolute(resolved)) return undefined;
    const typeFile = ts.resolveModuleName(
      specifier,
      fromFile,
      {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      },
      ts.sys,
    ).resolvedModule?.resolvedFileName;
    if (!typeFile || !/\.d\.(?:ts|mts|cts)$/.test(typeFile)) return undefined;
    hash.update(JSON.stringify([specifier, resolved, typeFile]));
    visitPackage(packageName, fromFile);
    const realType = fs.realpathSync(typeFile);
    if (
      ![...visitedPackages].some((root) => {
        const relative = path.relative(root, realType);
        return (
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative) &&
          !relative
            .split(path.sep)
            .some((part) =>
              ["src", "test", "tests", "__tests__"].includes(part),
            )
        );
      })
    )
      return undefined;
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}
