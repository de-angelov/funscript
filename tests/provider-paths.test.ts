import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderManifestV1 } from "../src/providers/contract.js";
import { authorizeProviderPaths } from "../src/compiler/provider-paths.js";

const dirs: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-paths-"));
  dirs.push(root);
  const sourceDir = path.join(root, "src");
  const allowed = path.join(root, "allowed");
  const denied = path.join(root, "denied");
  fs.mkdirSync(sourceDir);
  fs.mkdirSync(allowed);
  fs.mkdirSync(denied);
  const declaration = path.join(sourceDir, "main.fun");
  const input = path.join(allowed, "data.json");
  fs.writeFileSync(declaration, "");
  fs.writeFileSync(input, "{}");
  const manifest: ProviderManifestV1 = {
    id: "example.test/provider",
    version: "1.0.0",
    contract: { major: 1, minMinor: 0, maxMinor: 0 },
    parameters: [{ name: "input", kind: "string", required: true, path: true }],
    inputRoots: [denied],
    requestedCapabilities: [],
  };
  return { root, sourceDir, allowed, denied, declaration, input, manifest };
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("authorizeProviderPaths", () => {
  it("resolves relative inputs from the real declaration and returns canonical paths", () => {
    const f = fixture();
    expect(
      authorizeProviderPaths(
        f.manifest,
        f.declaration,
        ["../allowed/data.json"],
        [f.allowed],
      ),
    ).toEqual([{ argumentIndex: 0, canonicalPath: fs.realpathSync(f.input) }]);
  });

  it("uses only host-authorized roots, regardless of provider-declared roots", () => {
    const f = fixture();
    expect(() =>
      authorizeProviderPaths(
        f.manifest,
        f.declaration,
        ["../denied/data.json"],
        [f.allowed],
      ),
    ).toThrow("Provider path validation failed");
    expect(() =>
      authorizeProviderPaths(
        f.manifest,
        f.declaration,
        ["../allowed/data.json"],
        [f.denied],
      ),
    ).toThrow("Provider path validation failed");
  });

  it("rejects symlink escapes, missing inputs, and type mismatches", () => {
    const f = fixture();
    const link = path.join(f.allowed, "escape.json");
    fs.symlinkSync(path.join(f.denied, "secret.json"), link);
    fs.writeFileSync(path.join(f.denied, "secret.json"), "secret");
    expect(() =>
      authorizeProviderPaths(
        f.manifest,
        f.declaration,
        ["../allowed/escape.json"],
        [f.allowed],
      ),
    ).toThrow("Provider path validation failed");
    expect(() =>
      authorizeProviderPaths(
        f.manifest,
        f.declaration,
        ["../allowed/missing.json"],
        [f.allowed],
      ),
    ).toThrow("Provider path validation failed");
    expect(() =>
      authorizeProviderPaths(f.manifest, f.declaration, [42], [f.allowed]),
    ).toThrow("Provider path validation failed");
  });

  it("does not invoke provider code and does not disclose path details", () => {
    const f = fixture();
    const provide = vi.fn();
    expect(() =>
      authorizeProviderPaths(
        f.manifest,
        f.declaration,
        ["/secret/private"],
        [f.allowed],
      ),
    ).toThrow("Provider path validation failed");
    expect(provide).not.toHaveBeenCalled();
  });
});
