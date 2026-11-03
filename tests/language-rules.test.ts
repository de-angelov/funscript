import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { Lexer } from "../src/lexer/lexer.js";
import { Parser, ParseError } from "../src/parser/parser.js";
import { format } from "../src/formatter/index.js";
import { assertFormattingIdempotent } from "./helpers/conformance.js";
import { compileString, CompilerError } from "../src/compiler.js";
import {
  Program,
  ExportDeclaration,
  BindingDeclaration,
  BinaryExpression,
  EffectBlockExpression,
  EffectBindStatement,
  EffectDiscardStatement,
  Identifier,
} from "../src/ast/types.js";

function parse(source: string, filename = "rule-contract.fun"): Program {
  const lexer = new Lexer(source, filename);
  const parser = new Parser(lexer.tokenize(), filename, source);
  return parser.parse();
}

describe("Language Rule Contracts", () => {
  describe("Rule: Explicit Effect Returns", () => {
    describe("Stage 1: Parsing", () => {
      it("accepts braced effect block with explicit '=> returnValue'", () => {
        const source = `
export program = effect {
  user <- fetchUser()
  _ <- Console.log(user)
  summary = summarize(user)
  => summary
}
`.trim();

        const ast = parse(source);
        const exp = ast.body[0] as ExportDeclaration;
        const binding = exp.declaration as BindingDeclaration;
        expect(binding.init.kind).toBe("EffectBlockExpression");

        const effectBlock = binding.init as EffectBlockExpression;
        expect(effectBlock.body).toHaveLength(3);
        expect(effectBlock.body[0].kind).toBe("EffectBindStatement");
        expect((effectBlock.body[0] as EffectBindStatement).id.name).toBe("user");
        expect(effectBlock.body[1].kind).toBe("EffectDiscardStatement");
        expect(effectBlock.body[2].kind).toBe("BindingDeclaration");
        expect(((effectBlock.body[2] as BindingDeclaration).id as Identifier).name).toBe("summary");

        expect(effectBlock.finalExpression.kind).toBe("Identifier");
        expect((effectBlock.finalExpression as Identifier).name).toBe("summary");
      });

      it("accepts indented effect block compatibility form with explicit '=> returnValue'", () => {
        const source = `
export program = effect
  user <- fetchUser()
  => user
`.trim();

        const ast = parse(source);
        const exp = ast.body[0] as ExportDeclaration;
        const binding = exp.declaration as BindingDeclaration;
        const effectBlock = binding.init as EffectBlockExpression;
        expect(effectBlock.kind).toBe("EffectBlockExpression");
        expect(effectBlock.body).toHaveLength(1);
        expect((effectBlock.finalExpression as Identifier).name).toBe("user");
      });

      it("rejects braced effect block missing explicit '=>' on the final return expression", () => {
        const source = `
export program = effect {
  user <- fetchUser()
  user
}
`.trim();

        expect(() => parse(source)).toThrow(ParseError);
        expect(() => parse(source)).toThrow(
          "Effect block must end with an explicit '=> returnValue'"
        );
      });

      it("rejects single-expression effect block missing explicit '=>'", () => {
        const source = `
export program = effect {
  42
}
`.trim();

        expect(() => parse(source)).toThrow(ParseError);
        expect(() => parse(source)).toThrow(
          "Effect block must end with an explicit '=> returnValue'"
        );
      });

      it("rejects non-final bare expressions inside effect blocks", () => {
        const source = `
export program = effect {
  user <- fetchUser()
  Console.log("bare statement")
  => user
}
`.trim();

        expect(() => parse(source)).toThrow(ParseError);
        expect(() => parse(source)).toThrow(
          "Non-final bare expression in effect block is not executed. Use '<-' to run an effect or '_ <-' to discard its value."
        );
      });

      it("rejects statements following the explicit return arrow", () => {
        const source = `
export program = effect {
  user <- fetchUser()
  => user
  extra <- fetchOther()
}
`.trim();

        expect(() => parse(source)).toThrow(ParseError);
        expect(() => parse(source)).toThrow(
          "Effect block return must be the final statement"
        );
      });

      it("rejects empty effect block lacking an explicit return", () => {
        const source = `
export program = effect {
}
`.trim();

        expect(() => parse(source)).toThrow(ParseError);
        expect(() => parse(source)).toThrow(
          "Effect block must end with an explicit '=> returnValue'"
        );
      });
    });

    describe("Stage 2: Emission", () => {
      it("emits Effect.gen with yield* bindings and explicit return statement", async () => {
        const source = `
export runTask = effect {
  step1 <- init()
  _ <- notify(step1)
  total = step1 + 42
  => total
}
`.trim();

        const result = await Effect.runPromise(compileString(source, "runTask.fun"));
        expect(result.typescript).toContain('import { Effect } from "effect";');
        expect(result.typescript).toContain("export const runTask = Effect.gen(function* () {");
        expect(result.typescript).toContain("const step1 = yield* init();");
        expect(result.typescript).toContain("yield* notify(step1);");
        expect(result.typescript).toContain("const total = (step1 + 42);");
        expect(result.typescript).toContain("return total;");
      });

      it("emits function returning effect block with explicit return arrow", async () => {
        const source = `
export findUser = (id: String) =>
  effect {
    user <- fetchUser(id)
    => user
  }
`.trim();

        const result = await Effect.runPromise(compileString(source, "findUser.fun"));
        expect(result.typescript).toContain("Effect.gen(function* () {");
        expect(result.typescript).toContain("const user = yield* fetchUser(id);");
        expect(result.typescript).toContain("return user;");
      });
    });

    describe("Stage 3: Formatting", () => {
      it("formats effect block with canonical '=>' return and standard indentation", () => {
        const unformatted = `
export program = effect {
x <- fetchNumber()
_ <- Console.log(x)
y = x + 1
=> y
}
`.trim();

        const formatted = format(unformatted);
        expect(formatted).toBe(
          `export program =\n  effect {\n    x <- fetchNumber()\n    _ <- Console.log(x)\n    y = x + 1\n    => y\n  }\n`
        );
      });

      it("formats effect block idempotently", () => {
        const source = `
export program =
  effect {
    x <- fetchNumber()
    => x + 1
  }
`.trim();

        assertFormattingIdempotent(source);
      });

      it("rejects formatting malformed effect blocks missing explicit return", () => {
        const invalid = `
export program = effect {
  x <- fetchNumber()
  x
}
`.trim();

        expect(() => format(invalid)).toThrow(ParseError);
        expect(() => format(invalid)).toThrow("Effect block must end with an explicit '=> returnValue'");
      });
    });

    describe("Stage 4: Diagnostics", () => {
      it("succeeds compilation without diagnostics for valid explicit effect return", async () => {
        const valid = `
export program = effect {
  => 42
}
`.trim();

        const result = await Effect.runPromise(compileString(valid, "valid-effect.fun"));
        expect(result.typescript).toContain("return 42;");
      });

      it("reports compile error diagnostic with source span when explicit return is missing", async () => {
        const invalid = `
export program = effect {
  x <- fetchNumber()
  x
}
`.trim();

        await expect(Effect.runPromise(compileString(invalid, "invalid-effect.fun"))).rejects.toThrow(
          "Effect block must end with an explicit '=> returnValue'"
        );
      });

      it("reports compile error diagnostic when bare non-final expression is present", async () => {
        const invalid = `
export program = effect {
  Console.log("test")
  => 42
}
`.trim();

        await expect(Effect.runPromise(compileString(invalid, "bare-expr.fun"))).rejects.toThrow(
          "Non-final bare expression in effect block is not executed"
        );
      });

      it("reports compile error diagnostic when statements follow the return arrow", async () => {
        const invalid = `
export program = effect {
  => 42
  _ <- Console.log("after return")
}
`.trim();

        await expect(Effect.runPromise(compileString(invalid, "stmt-after-return.fun"))).rejects.toThrow(
          "Effect block return must be the final statement"
        );
      });
    });
  });

  describe("Rule: Numeric-Only Comparisons", () => {
    describe("Stage 1: Parsing", () => {
      it("accepts relational operators (<, <=, >, >=) as binary expressions", () => {
        const source = `export check = 1 < 2 and 3 <= 4 and 5 > 4 and 6 >= 6`;
        const ast = parse(source);
        const exp = ast.body[0] as ExportDeclaration;
        const binding = exp.declaration as BindingDeclaration;
        const and3 = binding.init as BinaryExpression;
        expect(and3.operator).toBe("and");

        const gte = and3.right as BinaryExpression;
        expect(gte.operator).toBe(">=");

        const and2 = and3.left as BinaryExpression;
        const gt = and2.right as BinaryExpression;
        expect(gt.operator).toBe(">");

        const and1 = and2.left as BinaryExpression;
        const lte = and1.right as BinaryExpression;
        expect(lte.operator).toBe("<=");

        const lt = and1.left as BinaryExpression;
        expect(lt.operator).toBe("<");
      });

      it("preserves operator precedence hierarchy: arithmetic > comparison > equality > logical", () => {
        const source = `export res = 1 + 2 * 3 < 8 #= true and ready`;
        const ast = parse(source);
        const exp = ast.body[0] as ExportDeclaration;
        const binding = exp.declaration as BindingDeclaration;

        // Top level: logical 'and'
        const logical = binding.init as BinaryExpression;
        expect(logical.operator).toBe("and");
        expect((logical.right as Identifier).name).toBe("ready");

        // Left of 'and': value equality '#='
        const equality = logical.left as BinaryExpression;
        expect(equality.operator).toBe("#=");

        // Left of '#=': comparison '<'
        const comparison = equality.left as BinaryExpression;
        expect(comparison.operator).toBe("<");

        // Left of '<': addition '+'
        const addition = comparison.left as BinaryExpression;
        expect(addition.operator).toBe("+");

        // Right of '+': multiplication '*'
        const multiplication = addition.right as BinaryExpression;
        expect(multiplication.operator).toBe("*");
      });

      it("allows parentheses to explicitly override natural operator precedence", () => {
        const source = `export res = (1 < 2 #= true) and (3 + 4) * 5 < 40`;
        const ast = parse(source);
        const exp = ast.body[0] as ExportDeclaration;
        const binding = exp.declaration as BindingDeclaration;
        const logical = binding.init as BinaryExpression;
        expect(logical.operator).toBe("and");

        const leftEquality = logical.left as BinaryExpression;
        expect(leftEquality.operator).toBe("#=");
        expect((leftEquality.left as BinaryExpression).operator).toBe("<");

        const rightComparison = logical.right as BinaryExpression;
        expect(rightComparison.operator).toBe("<");
        expect((rightComparison.left as BinaryExpression).operator).toBe("*");
      });

      it("rejects malformed relational expressions with missing operands or duplicate operators", () => {
        expect(() => parse("export bad = 1 < < 2")).toThrow(ParseError);
        expect(() => parse("export bad = 1 <")).toThrow(ParseError);
      });
    });

    describe("Stage 2: Emission", () => {
      it("emits native JavaScript/TypeScript relational comparison operators for numbers", async () => {
        const source = `export compare = (a: Number, b: Number) => a < b and a <= b and a > b and a >= b`;

        const result = await Effect.runPromise(compileString(source, "compare.fun"));
        expect(result.typescript).toContain("(a < b)");
        expect(result.typescript).toContain("(a <= b)");
        expect(result.typescript).toContain("(a > b)");
        expect(result.typescript).toContain("(a >= b)");
      });

      it("emits native comparison operators in funx source", async () => {
        const source = `export inRange = 10 < 20`;
        const result = await Effect.runPromise(compileString(source, "range.funx"));
        expect(result.typescript).toContain("(10 < 20)");
      });
    });

    describe("Stage 3: Formatting", () => {
      it("formats relational operators with standard spacing", () => {
        const unformatted = `export res = 1<2 and 3<=4 and 5>4 and 6>=5`;
        const formatted = format(unformatted);
        expect(formatted).toBe(`export res = 1 < 2 and 3 <= 4 and 5 > 4 and 6 >= 5\n`);
      });

      it("preserves arithmetic, comparison, and equality grouping idempotently", () => {
        const source = `export res = 1 + 2 < 3 * 4 #= true\n`;
        const formatted = assertFormattingIdempotent(source);
        expect(formatted).toBe(source);
      });

      it("rejects formatting malformed comparison syntax", () => {
        expect(() => format("export res = 1 < < 2")).toThrow(ParseError);
      });
    });

    describe("Stage 4: Diagnostics", () => {
      it("accepts valid numeric literal comparisons without diagnostics", async () => {
        const source = `export valid = 1 < 2 and 3 <= 4 and 5 > 0 and 10 >= 10`;
        const result = await Effect.runPromise(compileString(source, "valid-compare.fun"));
        expect(result.typescript).toContain("(1 < 2)");
      });

      it("accepts valid typed Number parameter comparisons without diagnostics", async () => {
        const source = `export isPositive = (n: Number) => n > 0`;
        const result = await Effect.runPromise(compileString(source, "positive.fun"));
        expect(result.typescript).toContain("(n > 0)");
      });

      it("rejects string literal operands with '<' and suggests Order.isLessThan(String.Order)", async () => {
        const source = `export invalid = "apple" < "banana"`;
        await expect(Effect.runPromise(compileString(source, "invalid-lt-literal.fun"))).rejects.toThrow(
          '< is only available for numbers; this operand has type "apple". Use Order.isLessThan(String.Order)(...) or an explicit domain Order.'
        );
      });

      it("rejects typed string operands with '<=' and suggests Order.isLessThanOrEqualTo(String.Order)", async () => {
        const source = `
ts { declare const str1: string; declare const str2: string }
export invalid = str1 <= str2
`.trim();
        await expect(Effect.runPromise(compileString(source, "invalid-lte-typed.fun"))).rejects.toThrow(
          "<= is only available for numbers; this operand has type string. Use Order.isLessThanOrEqualTo(String.Order)(...) or an explicit domain Order."
        );
      });

      it("rejects typed string operands with '>' and suggests Order.isGreaterThan(String.Order)", async () => {
        const source = `
ts { declare const str1: string; declare const str2: string }
export invalid = str1 > str2
`.trim();
        await expect(Effect.runPromise(compileString(source, "invalid-gt-typed.fun"))).rejects.toThrow(
          "> is only available for numbers; this operand has type string. Use Order.isGreaterThan(String.Order)(...) or an explicit domain Order."
        );
      });

      it("rejects typed string operands with '>=' and suggests Order.isGreaterThanOrEqualTo(String.Order)", async () => {
        const source = `
ts { declare const str1: string; declare const str2: string }
export invalid = str1 >= str2
`.trim();
        await expect(Effect.runPromise(compileString(source, "invalid-gte-typed.fun"))).rejects.toThrow(
          ">= is only available for numbers; this operand has type string. Use Order.isGreaterThanOrEqualTo(String.Order)(...) or an explicit domain Order."
        );
      });

      it("rejects boolean operands and points out the non-number type", async () => {
        const source = `
ts { declare const flag1: boolean; declare const flag2: boolean }
export invalid = flag1 < flag2
`.trim();
        await expect(Effect.runPromise(compileString(source, "invalid-bool.fun"))).rejects.toThrow(
          "< is only available for numbers; this operand has type boolean. Use Order.isLessThan(String.Order)(...) or an explicit domain Order."
        );
      });

      it("accepts explicit Order alternative for string comparisons without diagnostics", async () => {
        const source = `
ts { declare const isBefore: (a: string, b: string) => boolean }
export check = isBefore("apple", "banana")
`.trim();
        const result = await Effect.runPromise(compileString(source, "order-alternative.fun"));
        expect(result.typescript).toContain('isBefore("apple", "banana")');
      });
    });
  });
});
