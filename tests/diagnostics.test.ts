import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { compileString } from "../src/compiler.js";
import { Parser, ParseError } from "../src/parser/parser.js";
import { Lexer } from "../src/lexer/lexer.js";
import {
  validateFunScript,
  FunScriptLspServer,
  DiagnosticSeverity,
  type PublishDiagnosticsParams,
} from "../src/lsp/index.js";

function parseCode(source: string, filename = "<test>") {
  const lexer = new Lexer(source, filename);
  const tokens = lexer.tokenize();
  const parser = new Parser(tokens, filename, source);
  return parser.parse();
}

describe("Actionable Diagnostic Explanations and Suggestions", () => {
  describe("Implicit returns in function blocks", () => {
    it("rejects braced function block missing explicit '=>' with explanation, alternative construct, and doc link", async () => {
      const source = `
export calculate = (x: Number) => {
  temp = x + 1
  temp
}
`.trim();

      let err: any;
      try {
        await Effect.runPromise(compileString(source, "calc.fun"));
      } catch (e) {
        err = e;
      }

      expect(err).toBeDefined();
      expect(err.message).toContain("Function block must end with an explicit '=> returnValue'");
      expect(err.message).toContain(
        "Multi-statement functions require an explicit return arrow to distinguish returned values from side effects."
      );
      expect(err.message).toContain(
        "Use '=> value' or rewrite as an inline single-expression lambda '(args) => expr'."
      );
      expect(err.message).toContain("docs/syntax.md#311-explicit-returns-and-conditional-execution");
      expect(err.span).toBeDefined();
      expect(err.span.start.line).toBe(3);
      expect(err.span.start.column).toBe(3);
    });

    it("rejects indented function block missing explicit '=>' with actionable diagnostic", () => {
      const source = `
export calculate = (x: Number) =>
  temp = x + 1
  temp
`.trim();

      expect(() => parseCode(source)).toThrow(ParseError);
      expect(() => parseCode(source)).toThrow(
        "Function block must end with an explicit '=> returnValue'. Multi-statement functions require an explicit return arrow to distinguish returned values from side effects. Use '=> value' or rewrite as an inline single-expression lambda '(args) => expr'. See docs/syntax.md#311-explicit-returns-and-conditional-execution."
      );
    });

    it("rejects function block ending with trailing binding declaration", () => {
      const source = `
export calculate = (x: Number) =>
  temp = x + 1
`.trim();

      expect(() => parseCode(source)).toThrow(ParseError);
      expect(() => parseCode(source)).toThrow(
        "Function block must end with an explicit '=> returnValue'. Multi-statement functions require an explicit return arrow to distinguish returned values from side effects. Use '=> value' or rewrite as an inline single-expression lambda '(args) => expr'. See docs/syntax.md#311-explicit-returns-and-conditional-execution."
      );
    });

    it("rejects braced function block without return expression", () => {
      const source = `
export bad = () => {
  x = 1
}
`.trim();

      expect(() => parseCode(source)).toThrow(ParseError);
      expect(() => parseCode(source)).toThrow(
        "Function block must end with an explicit '=> returnValue'. Multi-statement functions require an explicit return arrow to distinguish returned values from side effects. Use '=> value' or rewrite as an inline single-expression lambda '(args) => expr'. See docs/syntax.md#311-explicit-returns-and-conditional-execution."
      );
    });

    it("accepts valid explicit returns and expression-bodied functions without diagnostics", async () => {
      const source = `
export calculate = (x: Number) => {
  temp = x + 1
  => temp
}
export inlineCalc = (x: Number) => x + 1
`.trim();

      const result = await Effect.runPromise(compileString(source, "valid-fn.fun"));
      expect(result.typescript).toContain("return (temp);");
      expect(result.typescript).toContain("(x + 1)");
    });
  });

  describe("Implicit returns and bare expressions in effect blocks", () => {
    it("rejects effect block missing explicit '=>' return with explanation, alternative construct, and doc link", async () => {
      const source = `
export compute = effect {
  x <- Effect.succeed(21)
  total = x * 2
}
`.trim();

      let err: any;
      try {
        await Effect.runPromise(compileString(source, "compute.fun"));
      } catch (e) {
        err = e;
      }

      expect(err).toBeDefined();
      expect(err.message).toContain("Effect block must end with an explicit '=> returnValue'");
      expect(err.message).toContain(
        "Effect blocks require an explicit return arrow to ensure values are yielded and returned properly."
      );
      expect(err.message).toContain(
        "Use '=> value' to return, or '_ <- effect' followed by '=> Unit' to discard."
      );
      expect(err.message).toContain("docs/syntax.md#93-the-non-final-expression-rule-and-control-flow-lowering");
      expect(err.span).toBeDefined();
      expect(err.span.start.line).toBe(1);
      expect(err.span.start.column).toBe(18);
    });

    it("rejects effect block ending in bare unyielded expression", () => {
      const source = `
export compute = effect {
  x <- Effect.succeed(21)
  x * 2
}
`.trim();

      expect(() => parseCode(source)).toThrow(ParseError);
      expect(() => parseCode(source)).toThrow(
        "Effect block must end with an explicit '=> returnValue'. Effect blocks require an explicit return arrow to ensure values are yielded and returned properly. Use '=> value' to return, or '_ <- effect' followed by '=> Unit' to discard. See docs/syntax.md#93-the-non-final-expression-rule-and-control-flow-lowering."
      );
    });

    it("rejects non-final bare expression in effect block with actionable alternative and doc link", () => {
      const source = `
export compute = effect {
  x <- Effect.succeed(21)
  Console.log("step")
  => x
}
`.trim();

      expect(() => parseCode(source)).toThrow(ParseError);
      expect(() => parseCode(source)).toThrow(
        "Non-final bare expression in effect block is not executed. Use '<-' to run an effect or '_ <-' to discard its value. See docs/syntax.md#93-the-non-final-expression-rule-and-control-flow-lowering."
      );
    });

    it("accepts valid explicit returns in effect blocks without diagnostics", async () => {
      const source = `
export compute = effect {
  x <- Effect.succeed(21)
  => x * 2
}
`.trim();

      const result = await Effect.runPromise(compileString(source, "valid-effect.fun"));
      expect(result.typescript).toContain("return (x * 2);");
    });
  });

  describe("Non-numeric relational comparisons", () => {
    it("rejects '<' comparison on strings with explanatory context, actionable suggestion, and doc link", async () => {
      const source = `
export check = (a: String, b: String) => a < b
`.trim();

      let err: any;
      try {
        await Effect.runPromise(compileString(source, "comparison.fun"));
      } catch (e) {
        err = e;
      }

      expect(err).toBeDefined();
      expect(err.message).toContain("< is only available for numbers; this operand has type string.");
      expect(err.message).toContain(
        "Use Order.isLessThan(String.Order)(...) or an explicit domain Order."
      );
      expect(err.message).toContain("docs/syntax.md#42-equality-and-comparisons");
      expect(err.span).toBeDefined();
    });

    it("rejects other relational operators (<=, >, >=) on strings with corresponding Order helpers", async () => {
      const cases = [
        { op: "<=", helper: "isLessThanOrEqualTo" },
        { op: ">", helper: "isGreaterThan" },
        { op: ">=", helper: "isGreaterThanOrEqualTo" },
      ];

      for (const { op, helper } of cases) {
        const source = `export check = (a: String, b: String) => a ${op} b`;
        let err: any;
        try {
          await Effect.runPromise(compileString(source, "test.fun"));
        } catch (e) {
          err = e;
        }

        expect(err).toBeDefined();
        expect(err.message).toContain(`${op} is only available for numbers; this operand has type string.`);
        expect(err.message).toContain(
          `Use Order.${helper}(String.Order)(...) or an explicit domain Order.`
        );
        expect(err.message).toContain("docs/syntax.md#42-equality-and-comparisons");
      }
    });

    it("accepts valid numeric comparisons without diagnostics", async () => {
      const source = `
export inRange = (n: Number) => n >= 0 and n <= 100
`.trim();

      const result = await Effect.runPromise(compileString(source, "numeric.fun"));
      expect(result.typescript).toContain("n >= 0");
      expect(result.typescript).toContain("n <= 100");
    });
  });

  describe("Banned keyword alternatives", () => {
    it("rejects 'return' keyword with actionable replacement suggestion and doc link", () => {
      const source = `
export bad = (x: Number) => {
  return x
}
`.trim();

      let err: any;
      try {
        parseCode(source);
      } catch (e) {
        err = e;
      }

      expect(err).toBeDefined();
      expect(err.message).toContain("FunScript uses '=> value' for explicit returns in function and effect blocks; replace 'return x' with '=> x'.");
      expect(err.message).toContain("docs/syntax.md#311-explicit-returns-and-conditional-execution");
    });

    it("rejects 'let' keyword with immutable and mutable binding alternatives", () => {
      const source = "let x = 1";
      expect(() => parseCode(source)).toThrow(
        "FunScript has no 'let'; use 'name = value' for immutable bindings, or 'mut name = value' for local mutable drafts."
      );
    });
  });

  describe("LSP Diagnostic Output Surfacing", () => {
    it("surfaces enhanced diagnostic for implicit function return in validateFunScript", () => {
      const code = `
calculate = (x: Number) => {
  temp = x + 1
  temp
}
`.trim();

      const diagnostics = validateFunScript(code, "file:///calc.fun");
      expect(diagnostics).toHaveLength(1);
      const diag = diagnostics[0];
      expect(diag.severity).toBe(DiagnosticSeverity.Error);
      expect(diag.source).toBe("funscript");
      expect(diag.message).toContain("Function block must end with an explicit '=> returnValue'");
      expect(diag.message).toContain(
        "Multi-statement functions require an explicit return arrow to distinguish returned values from side effects."
      );
      expect(diag.message).toContain(
        "Use '=> value' or rewrite as an inline single-expression lambda '(args) => expr'."
      );
      expect(diag.message).toContain("docs/syntax.md#311-explicit-returns-and-conditional-execution");
      expect(diag.range).toEqual({
        start: { line: 2, character: 2 },
        end: { line: 2, character: 6 },
      });
    });

    it("surfaces enhanced diagnostic for implicit effect return in validateFunScript", () => {
      const code = `
compute = effect {
  x <- Effect.succeed(10)
  total = x * 2
}
`.trim();

      const diagnostics = validateFunScript(code, "file:///compute.fun");
      expect(diagnostics).toHaveLength(1);
      const diag = diagnostics[0];
      expect(diag.severity).toBe(DiagnosticSeverity.Error);
      expect(diag.source).toBe("funscript");
      expect(diag.message).toContain("Effect block must end with an explicit '=> returnValue'");
      expect(diag.message).toContain(
        "Effect blocks require an explicit return arrow to ensure values are yielded and returned properly."
      );
      expect(diag.message).toContain(
        "Use '=> value' to return, or '_ <- effect' followed by '=> Unit' to discard."
      );
      expect(diag.message).toContain("docs/syntax.md#93-the-non-final-expression-rule-and-control-flow-lowering");
      expect(diag.range).toEqual({
        start: { line: 0, character: 10 },
        end: { line: 3, character: 1 },
      });
    });

    it("surfaces enhanced diagnostic for non-numeric comparison in validateFunScript", () => {
      const code = "export valid = (left: String, right: String) => left < right";
      const diagnostics = validateFunScript(code, "file:///test.fun");
      expect(diagnostics).toHaveLength(1);
      const diag = diagnostics[0];
      expect(diag.severity).toBe(DiagnosticSeverity.Error);
      expect(diag.source).toBe("funscript");
      expect(diag.message).toContain("< is only available for numbers; this operand has type string.");
      expect(diag.message).toContain(
        "Use Order.isLessThan(String.Order)(...) or an explicit domain Order."
      );
      expect(diag.message).toContain("docs/syntax.md#42-equality-and-comparisons");
      expect(diag.range).toEqual({
        start: { line: 0, character: 48 },
        end: { line: 0, character: 49 },
      });
    });

    it("publishes enhanced diagnostics over LSP server textDocument/didOpen and clears them on didChange", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });

      const diagEvents: PublishDiagnosticsParams[] = [];
      server.on("diagnostics", (p) => diagEvents.push(p));

      const invalidCode = `
calculate = (x: Number) => {
  temp = x + 1
  temp
}
`.trim();

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "file:///workspace/test.fun",
            languageId: "funscript",
            version: 1,
            text: invalidCode,
          },
        },
      });

      expect(diagEvents).toHaveLength(1);
      const openDiag = diagEvents[0].diagnostics;
      expect(openDiag).toHaveLength(1);
      expect(openDiag[0].message).toContain(
        "Function block must end with an explicit '=> returnValue'"
      );
      expect(openDiag[0].message).toContain(
        "Use '=> value' or rewrite as an inline single-expression lambda '(args) => expr'."
      );
      expect(openDiag[0].message).toContain(
        "docs/syntax.md#311-explicit-returns-and-conditional-execution"
      );

      const fixedCode = `
calculate = (x: Number) => {
  temp = x + 1
  => temp
}
`.trim();

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didChange",
        params: {
          textDocument: {
            uri: "file:///workspace/test.fun",
            version: 2,
          },
          contentChanges: [{ text: fixedCode }],
        },
      });

      expect(diagEvents).toHaveLength(2);
      expect(diagEvents[1].diagnostics).toEqual([]);
    });
  });
});
