import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  extractModuleDoc,
  renderHtmlDoc,
  renderMarkdownDoc,
} from "../src/tooling/doc.js";

const execFileAsync = promisify(execFile);
const binPath = path.resolve(__dirname, "../dist/cli/index.js");

describe("Doc generator tooling", () => {
  const sampleFunScript = `
/// A user profile model.
export schema User = {
  id: String
  name: String
  email: String
}

/// Service managing user entities.
export service UserService
  get: (id: String) => Effect<User>
  save: (user: User) => Effect<Void>

/// Format user display name.
/// \`\`\`funscript
/// formatUser({ id: "1", name: "Ada", email: "ada@lovelace.org" })
/// \`\`\`
export formatUser = (u: User) =>
  => "{u.name} <{u.email}>"

/// Recoverable error when user is absent.
export error UserNotFound(id: String)
`;

  it("extracts schemas, services, functions, and errors from source", () => {
    const mod = extractModuleDoc(sampleFunScript, "/src/users.fun", "/");
    expect(mod.moduleName).toBe("src/users");

    expect(mod.schemas.length).toBe(1);
    expect(mod.schemas[0].name).toBe("User");
    expect(mod.schemas[0].kind).toBe("record");
    expect(mod.schemas[0].docComment).toBe("A user profile model.");
    expect(mod.schemas[0].fields?.length).toBe(3);

    expect(mod.services.length).toBe(1);
    expect(mod.services[0].name).toBe("UserService");
    expect(mod.services[0].docComment).toBe("Service managing user entities.");
    expect(mod.services[0].methods.length).toBe(2);

    expect(mod.functions.length).toBe(1);
    expect(mod.functions[0].name).toBe("formatUser");
    expect(mod.functions[0].docComment).toContain("Format user display name.");
    expect(mod.functions[0].exampleSnippets?.length).toBe(1);

    expect(mod.errors.length).toBe(1);
    expect(mod.errors[0].name).toBe("UserNotFound");
  });

  it("renders markdown documentation", () => {
    const mod = extractModuleDoc(sampleFunScript, "/src/users.fun", "/");
    const markdown = renderMarkdownDoc({
      title: "Test Project",
      modules: [mod],
    });
    expect(markdown).toContain("# Test Project");
    expect(markdown).toContain("## Module: `src/users`");
    expect(markdown).toContain("### Schemas");
    expect(markdown).toContain("#### `User` (record)");
    expect(markdown).toContain("| `id` | `String` | No |");
    expect(markdown).toContain("### Services");
    expect(markdown).toContain("Service: `UserService`");
    expect(markdown).toContain("### Functions");
    expect(markdown).toContain("#### `formatUser`");
  });

  it("renders responsive HTML documentation with search and sidebar", () => {
    const mod = extractModuleDoc(sampleFunScript, "/src/users.fun", "/");
    const html = renderHtmlDoc({
      title: "Test Project",
      version: "1.0.0",
      modules: [mod],
    });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Test Project API Documentation");
    expect(html).toContain('id="search"');
    expect(html).toContain('data-kind="schema"');
    expect(html).toContain('data-kind="service"');
    expect(html).toContain('data-kind="function"');
    expect(html).toContain("badge-schema");
  });

  it("generates documentation via CLI funscript doc", async () => {
    const outDir = path.resolve(__dirname, "../.tmp-doc-test");
    try {
      const { stdout } = await execFileAsync("node", [
        binPath,
        "doc",
        "examples/shapes.fun",
        "examples/todo-service.fun",
        "--outDir",
        outDir,
      ]);
      expect(stdout).toContain("Generated documentation");
      expect(stdout).toContain("(html)");

      const indexHtml = await fs.readFile(
        path.join(outDir, "index.html"),
        "utf8",
      );
      expect(indexHtml).toContain("Shape");
      expect(indexHtml).toContain("TodoRepo");
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it("generates markdown documentation via CLI --format markdown", async () => {
    const outDir = path.resolve(__dirname, "../.tmp-doc-md-test");
    try {
      const { stdout } = await execFileAsync("node", [
        binPath,
        "doc",
        "examples/shapes.fun",
        "--format",
        "markdown",
        "--outDir",
        outDir,
      ]);
      expect(stdout).toContain("(markdown)");

      const apiMd = await fs.readFile(path.join(outDir, "api.md"), "utf8");
      expect(apiMd).toContain("## Module: `examples/shapes`");
      expect(apiMd).toContain("#### `Shape` (tagged-union)");
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it("generates JSON documentation via CLI --json", async () => {
    const outDir = path.resolve(__dirname, "../.tmp-doc-json-test");
    try {
      const { stdout } = await execFileAsync("node", [
        binPath,
        "doc",
        "examples/shapes.fun",
        "--json",
        "--outDir",
        outDir,
      ]);
      expect(stdout).toContain("(json)");

      const jsonStr = await fs.readFile(path.join(outDir, "docs.json"), "utf8");
      const parsed = JSON.parse(jsonStr);
      expect(parsed.modules).toBeInstanceOf(Array);
      expect(parsed.modules[0].schemas[0].name).toBe("Shape");
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });
});
