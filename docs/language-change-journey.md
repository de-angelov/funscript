# Language change journey: numeric comparisons

This guide traces `<` from source text to emitted TypeScript and editor help.
It is a contributor map for the number-only comparison rule; the canonical
language contract remains [Equality and comparisons in the syntax guide](syntax.md#42-equality-and-comparisons).

## Follow `<` through the implementation

1. **Lexing** — [token kinds](../src/lexer/tokens.ts) define `LT`, `LTE`, `GT`,
   and `GTE`. [The lexer](../src/lexer/lexer.ts) recognizes `<` and `<=` and
   emits their token values. Start with [lexer tests](../tests/lexer.test.ts).
   JSX has its own `<` disambiguation, covered in
   [lexer JSX tests](../tests/lexer-jsx.test.ts).
2. **Parsing** — [the parser's comparison production](../src/parser/parser.ts)
   consumes those four token kinds between additive expressions. It constructs
   the same binary node used by other operators. See
   [parser tests](../tests/parser.test.ts) for precedence and AST shape.
3. **AST** — [BinaryExpression](../src/ast/types.ts) stores the operator, left
   and right expressions, and source span. Comparisons do not have a dedicated
   node or type-analysis branch in the AST.
4. **Type analysis** — [compiler validation](../src/compiler.ts) emits a marked
   intermediate form and asks TypeScript's checker whether each operand is
   definitely numeric. Unknown, `any`, and non-number operands are rejected
   with a source diagnostic that points back to the FunScript operator. This
   preserves explicit Effect `Order` calls for strings and domain values.
   [Compiler tests](../tests/compiler.test.ts) and
   [language rule contract tests](../tests/language-rules.test.ts) cover acceptance,
   rejection, diagnostic text, and source mapping.
5. **Emission** — [binary expression emission](../src/emitter/emitter.ts)
   writes numeric comparisons as native TypeScript operators. The type check
   establishes when this native output is allowed; the emitter is not where
   operand types are inferred.
6. **Formatting** — [formatter precedence](../src/formatter/index.ts) keeps
   relational comparisons grouped at the equality level and below arithmetic.
   [Formatter tests](../tests/formatter.test.ts) check the resulting grouping
   and spacing.
7. **LSP help** — [operator hover metadata](../src/lsp/docs.ts) provides the
   summary and number-only guidance, and [hover lookup](../src/lsp/hover.ts)
   resolves operator tokens. See [LSP tests](../tests/lsp.test.ts) and
   [hover catalogue tests](../tests/lsp-docs.test.ts).

## Language rule contract tests

End-to-end contract tests for language rules across parsing, emission, formatting, and diagnostics are maintained in:
- [tests/language-rules.test.ts](../tests/language-rules.test.ts) — covers numeric comparisons (`<`, `<=`, `>`, `>=`) and explicit effect returns (`=> returnValue`), asserting traceable accepted and rejected examples across each compilation and tooling stage.

## Explicit effect returns journey

Explicit effect returns (`=> returnValue`) require every effect block to terminate with an explicit return arrow:
1. **Parsing** — [the parser's effect block production](../src/parser/parser.ts) requires `=>` before the final return expression. Missing return arrows or non-final bare expressions throw parse errors.
2. **AST** — [EffectBlockExpression](../src/ast/types.ts) stores block statements in `body` and the final return expression in `finalExpression`.
3. **Emission** — [the emitter](../src/emitter/emitter.ts) wraps the block in `Effect.gen(function* () { ... })` and emits the final expression as a TypeScript `return` statement.
4. **Formatting** — [the formatter](../src/formatter/index.ts) formats the return expression with an explicit `=> returnValue` prefix and standard indentation.
5. **Diagnostics** — parse and compiler diagnostics reject missing return arrows and unexecuted expressions with clear, actionable diagnostics.

Contract coverage for both rules is verified in [tests/language-rules.test.ts](../tests/language-rules.test.ts).

## Canonical and generated documentation

- Edit [the syntax guide](syntax.md#42-equality-and-comparisons) when the
  language contract changes. Its grammar also records the comparison
  production in [the grammar appendix](syntax.md#appendix-a-grammar). The keyword
  list is generated from the lexer; do not edit that section directly.
- Edit [LSP documentation metadata](../src/lsp/docs.ts) for hover text. The
  language reference at [docs/reference/language.md](reference/language.md) is
  generated from that metadata; do not edit it directly.
- [The reference generator](../scripts/generate-reference-docs.mjs) defines
  the generated outputs and `--check` mode. `docs:generate` builds first and
  regenerates references; `docs:check` builds first and verifies the checked-in outputs.
  Generation and keyword coverage checks cannot infer semantic changes: update the
  syntax guide, hover metadata, and behavior tests when language behavior changes.

## Change checklist

- [ ] Preserve the syntax contract and explicit `Order` guidance.
- [ ] Update lexer/token, parser/AST, compiler type validation, emission, and
  formatter only where the behavior or representation actually changes.
- [ ] Update focused tests for every changed stage, including source locations
  for diagnostics when compiler validation changes.
- [ ] Update canonical syntax and LSP hover metadata when their documented
  behavior changes; regenerate references instead of editing generated files.
- [ ] Resolve guide links, run `npm run docs:check`, and run `git diff --check`.

Focused checks for language rules:

```sh
npx vitest run tests/language-rules.test.ts tests/lexer.test.ts tests/lexer-jsx.test.ts tests/parser.test.ts tests/compiler.test.ts tests/formatter.test.ts tests/lsp.test.ts tests/lsp-docs.test.ts --reporter=basic --no-color
npm run build
npm run docs:check
git diff --check
```

## Syntax-checked documentation examples

`PARSED_DOC_EXAMPLES` in [the hover catalogue](../src/lsp/docs.ts) names complete
examples that the reference generator publishes and the documentation tests parse
with the current lexer and parser. To add one, write a complete FunScript program
in the catalogue and add its name to that list. Run `npm run docs:generate` and
`npm run docs:check`, then run `npx vitest run tests/reference-docs.test.ts`.
A parser failure means the example or language changed and requires review.

These checks cover syntax, not type checking, runtime behavior, or every hover
snippet. Other snippets may be illustrative fragments. Use the language rule
contract tests for behavior and keep the prose and examples in sync when rules
change; no automatic check can infer the intended meaning of arbitrary prose.
