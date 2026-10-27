import { describe, it, expect } from "vitest";
import {
  getHoverDocumentation,
  getDocItem,
  getAllDocKeywords,
  DOC_CATALOG,
  formatDocToMarkdown,
} from "../src/lsp/docs.js";

describe("LSP Keyword & Built-in Documentation Catalog", () => {
  describe("Core Required FunScript Keywords", () => {
    const requiredKeywords = [
      "service",
      "record",
      "variant",
      "effect",
      "match",
      "mut",
      "fail",
    ];

    for (const kw of requiredKeywords) {
      it(`provides rich Markdown documentation for '${kw}'`, () => {
        const doc = getHoverDocumentation(kw);
        expect(doc).toBeTypeOf("string");
        expect(doc).not.toBeNull();

        // Must include code snippet / syntax block
        expect(doc).toContain("```funscript");
        expect(doc).toContain("```");

        // Must include keyword name and explanation
        expect(doc).toContain(kw);

        // Must include Example section
        expect(doc).toContain("### Example");

        // Verify the underlying DocItem
        const item = getDocItem(kw);
        expect(item).toBeDefined();
        expect(item?.name).toBe(kw);
        expect(item?.summary.length).toBeGreaterThan(10);
        expect(item?.description.length).toBeGreaterThan(20);
        expect(item?.snippet.length).toBeGreaterThan(10);
      });
    }

    it("verifies 'service' documentation details", () => {
      const doc = getHoverDocumentation("service")!;
      expect(doc).toContain("Context.Service");
      expect(doc).toContain("UserRepo");
      expect(doc).toContain("Layer.succeed");
    });

    it("verifies 'record' documentation details", () => {
      const doc = getHoverDocumentation("record")!;
      expect(doc).toContain("immutable");
      expect(doc).toContain("Mutative");
      expect(doc).toContain("dot-path");
    });

    it("verifies 'variant' documentation details", () => {
      const doc = getHoverDocumentation("variant")!;
      expect(doc).toContain("Data.TaggedEnum");
      expect(doc).toContain("tagged union");
      expect(doc).toContain("Circle");
    });

    it("verifies 'effect' documentation details", () => {
      const doc = getHoverDocumentation("effect")!;
      expect(doc).toContain("Effect.gen");
      expect(doc).toContain("<-");
    });

    it("verifies 'match' documentation details", () => {
      const doc = getHoverDocumentation("match")!;
      expect(doc).toContain("ts-pattern");
      expect(doc).toContain("exhaustive");
      expect(doc).toContain("when");
    });

    it("verifies 'mut' documentation details", () => {
      const doc = getHoverDocumentation("mut")!;
      expect(doc).toContain("Mutative");
      expect(doc).toContain("copy-on-write");
    });

    it("verifies 'fail' documentation details", () => {
      const doc = getHoverDocumentation("fail")!;
      expect(doc).toContain("Effect.fail");
      expect(doc).toContain("`E` channel");
      expect(doc).toContain("recoverable");
    });
  });

  describe("Additional Language Keywords", () => {
    const additionalKeywords = [
      "schema",
      "error",
      "import",
      "export",
      "when",
      "and",
      "or",
      "not",
      "true",
      "false",
      "from",
    ];

    for (const kw of additionalKeywords) {
      it(`provides documentation for '${kw}'`, () => {
        const doc = getHoverDocumentation(kw);
        expect(doc).toBeTypeOf("string");
        expect(doc).not.toBeNull();
        expect(doc).toContain("```funscript");
        expect(doc).toContain(kw);
      });
    }
  });

  describe("Standard Primitives & Types", () => {
    const primitives = [
      "string",
      "number",
      "boolean",
      "void",
      "unknown",
      "never",
      "Array",
      "Record",
      "Option",
      "Some",
      "None",
      "Either",
      "Ref",
      "Duration",
      "DateTime",
      "Int",
      "UUID",
      "NonEmptyString",
      "Chunk",
      "HashMap",
      "HashSet",
    ];

    for (const prim of primitives) {
      it(`provides documentation for primitive '${prim}'`, () => {
        const doc = getHoverDocumentation(prim);
        expect(doc).toBeTypeOf("string");
        expect(doc).not.toBeNull();
        expect(doc).toContain(prim);
        expect(doc).toContain("```funscript");
      });
    }
  });

  describe("Effect Functions & Operators", () => {
    const effectMembers = [
      "Effect",
      "Effect.succeed",
      "Effect.fail",
      "Effect.sync",
      "Effect.tryPromise",
      "Effect.map",
      "Effect.flatMap",
      "Effect.andThen",
      "Effect.catchAll",
      "Effect.catchTag",
      "Effect.all",
      "Effect.forEach",
      "Effect.die",
      "Effect.orDie",
      "Effect.retry",
      "Effect.repeat",
      "Effect.timeout",
      "Effect.fork",
      "Effect.forkScoped",
      "Effect.scoped",
      "Effect.runPromise",
      "Effect.runSync",
      "Layer",
      "Layer.succeed",
      "Layer.effect",
      "Layer.scoped",
      "Context",
      "Schedule",
      "pipe",
    ];

    for (const member of effectMembers) {
      it(`provides documentation for '${member}'`, () => {
        const doc = getHoverDocumentation(member);
        expect(doc).toBeTypeOf("string");
        expect(doc).not.toBeNull();
        expect(doc).toContain("```funscript");
      });
    }
  });

  describe("Syntax Operators", () => {
    const operators = ["|>", "<-", "->", "???"];

    for (const op of operators) {
      it(`provides documentation for operator '${op}'`, () => {
        const doc = getHoverDocumentation(op);
        expect(doc).toBeTypeOf("string");
        expect(doc).not.toBeNull();
        expect(doc).toContain(op);
      });
    }
  });

  describe("Lookup Resolution & Aliases", () => {
    it("distinguishes lowercase keywords from capitalized types", () => {
      const recordKw = getDocItem("record");
      const recordType = getDocItem("Record");
      expect(recordKw?.category).toBe("keyword");
      expect(recordType?.category).toBe("primitive");

      const effectKw = getDocItem("effect");
      const effectType = getDocItem("Effect");
      expect(effectKw?.category).toBe("keyword");
      expect(effectType?.category).toBe("effect");
    });

    it("resolves keywords case-insensitively", () => {
      expect(getHoverDocumentation("SERVICE")).toBe(getHoverDocumentation("service"));
      expect(getHoverDocumentation("Match")).toBe(getHoverDocumentation("match"));
      expect(getHoverDocumentation("MUT")).toBe(getHoverDocumentation("mut"));
    });

    it("resolves Effect function aliases without 'Effect.' prefix", () => {
      expect(getHoverDocumentation("succeed")).toBe(getHoverDocumentation("Effect.succeed"));
      expect(getHoverDocumentation("catchTag")).toBe(getHoverDocumentation("Effect.catchTag"));
      expect(getHoverDocumentation("forEach")).toBe(getHoverDocumentation("Effect.forEach"));
      expect(getHoverDocumentation("orDie")).toBe(getHoverDocumentation("Effect.orDie"));
    });

    it("trims surrounding whitespace", () => {
      expect(getHoverDocumentation("  service  ")).toBe(getHoverDocumentation("service"));
      expect(getHoverDocumentation("\teffect\n")).toBe(getHoverDocumentation("effect"));
    });

    it("returns null for unknown keywords", () => {
      expect(getHoverDocumentation("nonExistentKeyword42")).toBeNull();
      expect(getHoverDocumentation("foobar")).toBeNull();
      expect(getHoverDocumentation("")).toBeNull();
      expect(getHoverDocumentation("   ")).toBeNull();
      expect(getHoverDocumentation(null as any)).toBeNull();
      expect(getHoverDocumentation(undefined as any)).toBeNull();
    });
  });

  describe("Catalog Integrity", () => {
    it("ensures all catalog entries are well-formed", () => {
      const allKeys = getAllDocKeywords();
      expect(allKeys.length).toBeGreaterThan(30);

      for (const key of allKeys) {
        const item = DOC_CATALOG[key];
        expect(item).toBeDefined();
        expect(item.name).toBeTruthy();
        expect(item.category).toBeTruthy();
        expect(item.signature).toBeTruthy();
        expect(item.summary).toBeTruthy();
        expect(item.description).toBeTruthy();
        expect(item.snippet).toBeTruthy();

        // formatDocToMarkdown should produce Markdown without throwing
        const md = formatDocToMarkdown(item);
        expect(md).toContain("```funscript\n" + item.signature + "\n```");
        expect(md).toContain(`**${item.name}** (\`${item.category}\`) — ${item.summary}`);
        expect(md).toContain(item.description);
        expect(md).toContain("### Example\n```funscript\n" + item.snippet + "\n```");
      }
    });
  });
});
