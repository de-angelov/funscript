import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { StreamMessageReader, StreamMessageWriter } from "../src/lsp/index.js";

// Mock 'vscode' and 'vscode-languageclient/node' for extension entry point tests
vi.mock("vscode", () => {
  return {
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: vi.fn((key: string, defaultValue?: any) => defaultValue ?? "funscript"),
      })),
      createFileSystemWatcher: vi.fn((pattern: string) => ({
        pattern,
        dispose: vi.fn(),
      })),
    },
  };
});

vi.mock("vscode-languageclient/node", () => {
  class MockLanguageClient {
    id: string;
    name: string;
    serverOptions: any;
    clientOptions: any;
    started = false;
    stopped = false;

    constructor(id: string, name: string, serverOptions: any, clientOptions: any) {
      this.id = id;
      this.name = name;
      this.serverOptions = serverOptions;
      this.clientOptions = clientOptions;
    }

    start() {
      this.started = true;
      return Promise.resolve();
    }

    stop() {
      this.stopped = true;
      return Promise.resolve();
    }
  }

  return {
    LanguageClient: MockLanguageClient,
  };
});

describe("VS Code Extension Package (TASK-018)", () => {
  const extensionDir = path.resolve(__dirname, "../editors/vscode");
  const packageJsonPath = path.join(extensionDir, "package.json");
  const langConfigPath = path.join(extensionDir, "language-configuration.json");
  const grammarPath = path.join(extensionDir, "syntaxes/funscript.tmLanguage.json");

  describe("Extension Manifest & Language Contributions", () => {
    it("has a valid package.json with standard VS Code metadata", async () => {
      const content = await fs.readFile(packageJsonPath, "utf-8");
      const pkg = JSON.parse(content);

      expect(pkg.name).toBe("funscript-vscode");
      expect(pkg.displayName).toBe("FunScript");
      expect(pkg.publisher).toBe("funscript");
      expect(pkg.main).toBe("./dist/extension.js");
      expect(pkg.engines?.vscode).toBeDefined();
    });

    it("registers language contributions for .fun and .funx", async () => {
      const content = await fs.readFile(packageJsonPath, "utf-8");
      const pkg = JSON.parse(content);

      const languages: any[] = pkg.contributes?.languages;
      expect(Array.isArray(languages)).toBe(true);

      const funLang = languages.find((l) => l.id === "funscript");
      expect(funLang).toBeDefined();
      expect(funLang.extensions).toContain(".fun");
      expect(funLang.configuration).toBe("./language-configuration.json");

      const funxLang = languages.find((l) => l.id === "funscriptx");
      expect(funxLang).toBeDefined();
      expect(funxLang.extensions).toContain(".funx");
      expect(funxLang.configuration).toBe("./language-configuration.json");
    });

    it("registers TextMate grammar contributions for funscript and funscriptx", async () => {
      const content = await fs.readFile(packageJsonPath, "utf-8");
      const pkg = JSON.parse(content);

      const grammars: any[] = pkg.contributes?.grammars;
      expect(Array.isArray(grammars)).toBe(true);

      const funGrammar = grammars.find((g) => g.language === "funscript");
      expect(funGrammar).toBeDefined();
      expect(funGrammar.scopeName).toBe("source.fun");
      expect(funGrammar.path).toBe("./syntaxes/funscript.tmLanguage.json");

      const funxGrammar = grammars.find((g) => g.language === "funscriptx");
      expect(funxGrammar).toBeDefined();
      expect(funxGrammar.scopeName).toBe("source.funx");
      expect(funxGrammar.path).toBe("./syntaxes/funscript.tmLanguage.json");
    });

    it("configures activation events for onLanguage:funscript and onLanguage:funscriptx", async () => {
      const content = await fs.readFile(packageJsonPath, "utf-8");
      const pkg = JSON.parse(content);

      expect(pkg.activationEvents).toContain("onLanguage:funscript");
      expect(pkg.activationEvents).toContain("onLanguage:funscriptx");
    });

    it("has a valid language-configuration.json with comments, brackets, and autoClosingPairs", async () => {
      const content = await fs.readFile(langConfigPath, "utf-8");
      const config = JSON.parse(content);

      expect(config.comments?.lineComment).toBe("#");
      expect(config.brackets).toEqual(
        expect.arrayContaining([
          ["{", "}"],
          ["[", "]"],
          ["(", ")"],
        ])
      );
      expect(config.autoClosingPairs).toBeDefined();
    });
  });

  describe("TextMate Grammar (funscript.tmLanguage.json)", () => {
    it("has a valid schema and scopeName", async () => {
      const content = await fs.readFile(grammarPath, "utf-8");
      const grammar = JSON.parse(content);

      expect(grammar.name).toBe("FunScript");
      expect(grammar.scopeName).toBe("source.fun");
      expect(Array.isArray(grammar.patterns)).toBe(true);
      expect(grammar.repository).toBeDefined();
    });

    it("compiles all pattern regular expressions without error", async () => {
      const content = await fs.readFile(grammarPath, "utf-8");
      const grammar = JSON.parse(content);

      function checkPatterns(patterns: any[]) {
        for (const p of patterns) {
          if (p.match) {
            expect(() => new RegExp(p.match, "u")).not.toThrow();
          }
          if (p.begin) {
            expect(() => new RegExp(p.begin, "u")).not.toThrow();
          }
          if (p.end) {
            expect(() => new RegExp(p.end, "u")).not.toThrow();
          }
          if (p.patterns) {
            checkPatterns(p.patterns);
          }
        }
      }

      checkPatterns(grammar.patterns);
      for (const repoItem of Object.values(grammar.repository) as any[]) {
        if (repoItem.patterns) {
          checkPatterns(repoItem.patterns);
        }
      }
    });

    it("tokenizes keywords: effect, match, mut, schema, service, error, export, import, js, ts, etc.", async () => {
      const content = await fs.readFile(grammarPath, "utf-8");
      const grammar = JSON.parse(content);

      const controlKeywords = grammar.repository.keywords.patterns.find(
        (p: any) => p.name === "keyword.control.funscript"
      );
      expect(controlKeywords).toBeDefined();
      const controlRegex = new RegExp(controlKeywords.match);
      for (const kw of ["effect", "match", "mut", "schema", "service", "error", "export", "import", "from", "when"]) {
        expect(controlRegex.test(kw)).toBe(true);
      }

      const otherKeywords = grammar.repository.keywords.patterns.find(
        (p: any) => p.name === "keyword.other.funscript"
      );
      expect(otherKeywords).toBeDefined();
      const otherRegex = new RegExp(otherKeywords.match);
      expect(otherRegex.test("js")).toBe(true);
      expect(otherRegex.test("ts")).toBe(true);

      const logicalKeywords = grammar.repository.keywords.patterns.find(
        (p: any) => p.name === "keyword.operator.logical.funscript"
      );
      expect(logicalKeywords).toBeDefined();
      const logicalRegex = new RegExp(logicalKeywords.match);
      expect(logicalRegex.test("and")).toBe(true);
      expect(logicalRegex.test("or")).toBe(true);
      expect(logicalRegex.test("not")).toBe(true);
    });

    it("marks banned keywords as invalid.illegal", async () => {
      const content = await fs.readFile(grammarPath, "utf-8");
      const grammar = JSON.parse(content);

      const illegalPattern = grammar.repository.keywords.patterns.find(
        (p: any) => p.name === "invalid.illegal.funscript"
      );
      expect(illegalPattern).toBeDefined();
      const regex = new RegExp(illegalPattern.match);
      for (const banned of ["let", "var", "const", "function", "class", "return", "try", "catch"]) {
        expect(regex.test(banned)).toBe(true);
      }
    });

    it("tokenizes pipeline operator, bind operator, arrow, and typed hole", async () => {
      const content = await fs.readFile(grammarPath, "utf-8");
      const grammar = JSON.parse(content);
      const pipelinePatterns: any[] = grammar.repository.pipeline.patterns;

      const pipeRule = pipelinePatterns.find((p) => p.name === "keyword.operator.pipeline.funscript");
      expect(pipeRule).toBeDefined();
      expect(new RegExp(pipeRule.match).test("|>")).toBe(true);

      const bindRule = pipelinePatterns.find((p) => p.name === "keyword.operator.arrow.left.funscript");
      expect(bindRule).toBeDefined();
      expect(new RegExp(bindRule.match).test("<-")).toBe(true);

      const arrowRule = pipelinePatterns.find((p) => p.name === "keyword.operator.arrow.right.funscript");
      expect(arrowRule).toBeDefined();
      expect(new RegExp(arrowRule.match).test("->")).toBe(true);

      const holeRule = pipelinePatterns.find((p) => p.name === "keyword.operator.typed-hole.funscript");
      expect(holeRule).toBeDefined();
      expect(new RegExp(holeRule.match).test("???")).toBe(true);
    });

    it("tokenizes primitive types and UpperCamelCase custom type identifiers", async () => {
      const content = await fs.readFile(grammarPath, "utf-8");
      const grammar = JSON.parse(content);
      const typePatterns: any[] = grammar.repository.types.patterns;

      const primRule = typePatterns.find((p) => p.name === "support.type.primitive.funscript");
      const primRegex = new RegExp(primRule.match);
      for (const t of ["number", "string", "boolean", "unknown", "never", "void", "Effect", "Option", "Either"]) {
        expect(primRegex.test(t)).toBe(true);
      }

      const customTypeRule = typePatterns.find((p) => p.name === "entity.name.type.funscript");
      const customRegex = new RegExp(customTypeRule.match);
      expect(customRegex.test("User")).toBe(true);
      expect(customRegex.test("OrderService")).toBe(true);
      expect(customRegex.test("variableName")).toBe(false);
    });

    it("tokenizes JSX tags and component elements in .funx files", async () => {
      const content = await fs.readFile(grammarPath, "utf-8");
      const grammar = JSON.parse(content);
      const jsxPatterns: any[] = grammar.repository.jsx.patterns;

      const compTagRule = jsxPatterns.find(
        (p) => p.beginCaptures?.["2"]?.name === "support.class.component.funscript"
      );
      expect(compTagRule).toBeDefined();
      expect(new RegExp(compTagRule.begin).test("<Button")).toBe(true);
      expect(new RegExp(compTagRule.begin).test("<div")).toBe(false);

      const htmlTagRule = jsxPatterns.find(
        (p) =>
          p.begin?.startsWith("(<)([a-z]") &&
          p.beginCaptures?.["2"]?.name === "entity.name.tag.funscript"
      );
      expect(htmlTagRule).toBeDefined();
      expect(new RegExp(htmlTagRule.begin).test("<div")).toBe(true);
      expect(new RegExp(htmlTagRule.begin).test("<span")).toBe(true);

      const closeTagRule = jsxPatterns.find((p) => p.name === "meta.jsx.tag.closing.funscript");
      expect(closeTagRule).toBeDefined();
      expect(new RegExp(closeTagRule.begin).test("</div>")).toBe(true);
      expect(new RegExp(closeTagRule.begin).test("</Button>")).toBe(true);
    });

    it("tokenizes comments, strings, and ts escape syntax", async () => {
      const content = await fs.readFile(grammarPath, "utf-8");
      const grammar = JSON.parse(content);

      const commentRule = grammar.repository.comments.patterns[0];
      expect(new RegExp(commentRule.match).test("# This is a comment")).toBe(true);

      const tsRule = grammar.repository["ts-escape"].patterns[0];
      const tsMatch = 'ts "import(\'effect\').Effect"'.match(new RegExp(tsRule.match));
      expect(tsMatch).not.toBeNull();
      expect(tsMatch?.[1]).toBe("ts");
      expect(tsMatch?.[2]).toBe('"import(\'effect\').Effect"');
    });
  });

  describe("Extension Entry Point & LSP Client Wire-up", () => {
    it("builds ServerOptions pointing to 'funscript lsp --stdio'", async () => {
      const { buildServerOptions } = await import("../editors/vscode/src/extension.js");
      const serverOptions = buildServerOptions();

      expect(serverOptions.command).toBe("funscript");
      expect(serverOptions.args).toEqual(["lsp", "--stdio"]);
    });

    it("respects custom server path argument in ServerOptions", async () => {
      const { buildServerOptions } = await import("../editors/vscode/src/extension.js");
      const customOptions = buildServerOptions("/usr/local/bin/custom-funscript");

      expect(customOptions.command).toBe("/usr/local/bin/custom-funscript");
      expect(customOptions.args).toEqual(["lsp", "--stdio"]);
    });

    it("builds ClientOptions with document selectors for .fun and .funx", async () => {
      const { buildClientOptions } = await import("../editors/vscode/src/extension.js");
      const clientOptions = buildClientOptions();

      expect(clientOptions.documentSelector).toEqual([
        { scheme: "file", language: "funscript" },
        { scheme: "file", language: "funscriptx" },
        { scheme: "untitled", language: "funscript" },
        { scheme: "untitled", language: "funscriptx" },
      ]);
      expect(clientOptions.synchronize?.fileEvents).toBeDefined();
    });

    it("activates and starts the language client", async () => {
      const { activate, deactivate, getClient } = await import("../editors/vscode/src/extension.js");

      const subscriptions: any[] = [];
      const mockContext: any = {
        subscriptions,
      };

      activate(mockContext);
      const client = getClient();
      expect(client).toBeDefined();
      expect(client?.name).toBe("FunScript Language Server");
      expect((client as any).started).toBe(true);

      const deactResult = deactivate();
      if (deactResult && typeof deactResult.then === "function") {
        await deactResult;
      }
      expect((client as any).stopped).toBe(true);
    });
  });

  describe("LSP Server Launch over Stdio Integration", () => {
    it("successfully launches 'funscript lsp --stdio' and communicates JSON-RPC lifecycle", async () => {
      const cliPath = path.resolve(__dirname, "../dist/cli/index.js");
      const child = spawn("node", [cliPath, "lsp", "--stdio"]);

      const reader = new StreamMessageReader(child.stdout);
      const writer = new StreamMessageWriter(child.stdin);

      const messages: any[] = [];
      reader.listen((msg) => messages.push(msg));

      // 1. Initialize
      writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          capabilities: {},
        },
      } as any);

      await vi.waitFor(
        () => {
          expect(messages.some((m) => m.id === 1)).toBe(true);
        },
        { timeout: 5000 }
      );

      const initRes = messages.find((m) => m.id === 1);
      expect(initRes.result).toBeDefined();
      expect(initRes.result.capabilities).toBeDefined();
      expect(initRes.result.serverInfo?.name).toBe("funscript-lsp");

      // 2. Open document
      writer.write({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "file:///test.fun",
            languageId: "funscript",
            version: 1,
            text: "x = 42\n",
          },
        },
      } as any);

      await vi.waitFor(
        () => {
          expect(
            messages.some(
              (m) =>
                m.method === "textDocument/publishDiagnostics" &&
                m.params.uri === "file:///test.fun"
            )
          ).toBe(true);
        },
        { timeout: 5000 }
      );

      // 3. Shutdown
      writer.write({
        jsonrpc: "2.0",
        id: 2,
        method: "shutdown",
      } as any);

      await vi.waitFor(
        () => {
          expect(messages.some((m) => m.id === 2)).toBe(true);
        },
        { timeout: 5000 }
      );

      // 4. Exit
      const exitPromise = new Promise<number>((resolve) => {
        child.on("exit", (code) => resolve(code ?? 0));
      });

      writer.write({
        jsonrpc: "2.0",
        method: "exit",
      } as any);

      const exitCode = await exitPromise;
      expect(exitCode).toBe(0);

      reader.dispose();
      writer.dispose();
    });
  });
});
