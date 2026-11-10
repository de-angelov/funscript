import { execFileSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generateReferenceDocs } from "../scripts/generate-reference-docs.mjs";
import { KEYWORDS } from "../src/lexer/tokens.js";
import { PIPELINE_COMPANION_CATALOG } from "../src/emitter/pipeline-catalog.js";
import { Lexer } from "../src/lexer/lexer.js";
import { Parser } from "../src/parser/parser.js";
import { CLI_COMMANDS } from "../src/cli/commands.js";
import { DOC_CATALOG, PARSED_DOC_EXAMPLES } from "../src/lsp/docs.js";

const root = resolve(import.meta.dirname, "..");

describe("generated reference documentation", () => {
  it("matches the compiled CLI catalogue and package exports in this checkout", () => {
    expect(() =>
      execFileSync(process.execPath, ["scripts/generate-reference-docs.mjs", "--check"], {
        cwd: root,
        encoding: "utf8",
      })
    ).not.toThrow();
  });

  it("detects stale generated output and reports actionable remediation advice", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "funscript-docs-drift-"));
    try {
      await mkdir(join(tempDir, "docs", "reference"), { recursive: true });
      await copyFile(resolve(root, "package.json"), join(tempDir, "package.json"));
      await copyFile(resolve(root, "README.md"), join(tempDir, "README.md"));
      await copyFile(resolve(root, "docs/syntax.md"), join(tempDir, "docs/syntax.md"));
      await writeFile(join(tempDir, "docs", "reference", "cli.md"), "# Outdated CLI docs\n");

      let loggedError = "";
      const result = await generateReferenceDocs({
        root: tempDir,
        check: true,
        log: () => {},
        errorLog: (msg: string) => {
          loggedError = msg;
        },
      });

      expect(result.stale, "Drift check must report stale when output does not match").toBe(true);
      expect(result.outdatedFiles).toContain(join(tempDir, "docs", "reference", "cli.md"));
      expect(loggedError).toContain("Generated references are stale. Run: npm run docs:generate");

      // Verify that running the script via CLI exits with code 1 when drift is detected
      expect(() => {
        execFileSync(process.execPath, [resolve(root, "scripts/generate-reference-docs.mjs"), "--check", "--root", tempDir], {
          encoding: "utf8",
          stdio: "pipe",
        });
      }).toThrowError();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("links every generated example to an existing file", async () => {
    const reference = await readFile(resolve(root, "docs/reference/examples.md"), "utf8");
    const links = [...reference.matchAll(/\]\(([^)]+)\)/g)];
    expect(links.length).toBeGreaterThan(0);
    for (const [, target] of links) {
      await expect(access(resolve(root, "docs/reference", target))).resolves.toBeUndefined();
    }
  });

  it("rejects missing generated section markers", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "funscript-docs-markers-"));
    try {
      await mkdir(join(tempDir, "docs"), { recursive: true });
      await copyFile(resolve(root, "package.json"), join(tempDir, "package.json"));
      await copyFile(resolve(root, "docs/syntax.md"), join(tempDir, "docs/syntax.md"));
      const readme = await readFile(resolve(root, "README.md"), "utf8");
      await writeFile(join(tempDir, "README.md"), readme.replace("<!-- GENERATED: example-inventory -->", ""));
      await expect(generateReferenceDocs({ root: tempDir, check: true })).rejects.toThrow("example-inventory");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each(PARSED_DOC_EXAMPLES)("parses the documented %s example with the current language", (name) => {
    const source = DOC_CATALOG[name].snippet;
    const filename = `documentation-${name}.fun`;
    expect(() => new Parser(new Lexer(source, filename).tokenize(), filename, source).parse()).not.toThrow();
  });

  describe("code-owned documentation fact assertions", () => {
    it("documents every lexer keyword and exact keyword count in syntax.md", async () => {
      const syntaxContent = await readFile(resolve(root, "docs/syntax.md"), "utf8");
      const lexerKeywords = Object.keys(KEYWORDS).sort();

      // Heading must specify exact keyword count
      expect(
        syntaxContent,
        `docs/syntax.md must state total keyword count matching lexer tokens (${lexerKeywords.length} total)`
      ).toContain(`### 1.5 Keywords (${lexerKeywords.length} total)`);

      // Extract keywords table block from Section 1.5
      const keywordBlockMatch = syntaxContent.match(/### 1\.5 Keywords \(\d+ total\)[\s\S]*?```text([\s\S]*?)```/);
      expect(keywordBlockMatch, "docs/syntax.md must contain the keywords text block").toBeTruthy();

      const documentedKeywords = keywordBlockMatch![1]
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .sort();

      expect(
        documentedKeywords,
        "docs/syntax.md Section 1.5 keywords must exactly match src/lexer/tokens.ts KEYWORDS"
      ).toEqual(lexerKeywords);

      // Every lexer keyword must have rich documentation in the hover catalog
      for (const kw of lexerKeywords) {
        expect(
          DOC_CATALOG[kw],
          `LSP DOC_CATALOG in src/lsp/docs.ts must provide hover documentation for keyword '${kw}'`
        ).toBeDefined();
      }
    });

    it("documents all pipeline companion modules in syntax.md and compatibility.md", async () => {
      const syntaxContent = await readFile(resolve(root, "docs/syntax.md"), "utf8");
      const compatContent = await readFile(resolve(root, "docs/compatibility.md"), "utf8");
      const companionModules = Object.keys(PIPELINE_COMPANION_CATALOG).sort();

      for (const mod of companionModules) {
        expect(
          syntaxContent,
          `docs/syntax.md Section 5.1 must reference companion module 'effect/${mod}'`
        ).toContain(`\`effect/${mod}\``);
        expect(
          compatContent,
          `docs/compatibility.md Section 4 must reference companion module '${mod}'`
        ).toContain(mod);
      }
    });

    it("documents all repository package.json scripts in docs/tooling.md", async () => {
      const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
      const toolingContent = await readFile(resolve(root, "docs/tooling.md"), "utf8");
      const packageScripts = Object.keys(pkg.scripts || {}).sort();

      for (const script of packageScripts) {
        expect(
          toolingContent,
          `docs/tooling.md must document package.json script '${script}'`
        ).toContain(`\`${script}\``);
      }
    });

    it("documents all package exports in docs/reference/api.md", async () => {
      const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
      const apiContent = await readFile(resolve(root, "docs/reference/api.md"), "utf8");

      for (const entrypoint of Object.keys(pkg.exports || {})) {
        const importPath = `${pkg.name}${entrypoint === "." ? "" : entrypoint.slice(1)}`;
        expect(
          apiContent,
          `docs/reference/api.md must list import path '${importPath}'`
        ).toContain(`\`${importPath}\``);
      }
    });

    it("documents all CLI commands in docs/reference/cli.md", async () => {
      const cliContent = await readFile(resolve(root, "docs/reference/cli.md"), "utf8");

      for (const cmd of CLI_COMMANDS) {
        expect(
          cliContent,
          `docs/reference/cli.md must document command 'funscript ${cmd.name}'`
        ).toContain(`### \`funscript ${cmd.name}\``);
      }
    });
  });
});
