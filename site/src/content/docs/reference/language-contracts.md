---
title: Language Contracts
description: How FunScript keeps every lexer token covered by a behavior-tested example, and how to add a new contract.
---

A language contract is a small FunScript program paired with two things: the lexer
tokens that program exercises, and a concrete expectation about what the program
does when it runs. Contracts keep the token set in `src/lexer/tokens.ts` honest:
every token is either demonstrated by an executable example or explicitly listed
as legacy debt.

The contract fixtures live in `tests/fixtures/language-contracts`, the loader is
`scripts/language-contracts.mjs`, and the rules are enforced by
`tests/language-contracts.test.ts`.

## Why contracts exist

Adding a `TokenType` is cheap; keeping it documented and exercised is not. The
contract suite closes that gap:

- **No orphan tokens.** A new enum value fails the suite until a contract lists it
  or it is added to the legacy baseline.
- **Coverage is proven, not claimed.** For each contract, the test lexes the
  fixture and verifies that every declared token is actually produced.
- **Examples stay executable.** Each fixture is compiled and run, so a contract
  cannot describe behavior the compiler no longer implements.
- **Generated docs stay in sync.** The same catalog feeds
  `docs/reference/tested-examples.md` through `npm run docs:generate`.

## Where contracts live

| Path                                             | Purpose                                             |
| ------------------------------------------------ | --------------------------------------------------- |
| `tests/fixtures/language-contracts/catalog.json` | The contract catalog and legacy token baseline.     |
| `tests/fixtures/language-contracts/*.fun`        | Source fixtures referenced by `catalog.json`.       |
| `scripts/language-contracts.mjs`                 | Loads the catalog and computes unclassified tokens. |
| `tests/language-contracts.test.ts`               | Enforces coverage, schema, and runtime behavior.    |
| `docs/reference/tested-examples.md`              | Generated from the catalog; do not edit by hand.    |

## Anatomy of a contract

`catalog.json` has two top-level keys: `contracts` and `legacyTokens`.

```json
{
  "contracts": [
    {
      "id": "numeric-comparison",
      "title": "Numeric comparison",
      "description": "Combine numeric comparisons with short-circuit conjunction.",
      "file": "numeric-comparison.fun",
      "tokens": [">=", "<", "and"],
      "behavior": {
        "export": "inRange",
        "cases": [
          { "args": [5], "expected": true },
          { "args": [10], "expected": false }
        ]
      }
    }
  ],
  "legacyTokens": ["NUMBER", "STRING", "IDENTIFIER"]
}
```

The matching fixture exports the binding named by `behavior.export`:

```funscript
export inRange = (value: Number) => value >= 0 and value < 10
```

### Contract fields

| Field               | Required            | Meaning                                                       |
| ------------------- | ------------------- | ------------------------------------------------------------- |
| `id`                | Yes                 | Unique, stable, kebab-case identifier.                        |
| `title`             | Yes                 | Human-readable name, non-empty.                               |
| `description`       | Yes                 | One sentence explaining what the fixture demonstrates.        |
| `file`              | Yes                 | Fixture filename, resolved relative to the catalog directory. |
| `tokens`            | Yes                 | Token type strings the fixture exercises; must be non-empty.  |
| `behavior.export`   | Yes                 | Name of the exported binding to execute.                      |
| `behavior.effect`   | For effect programs | Set to `true` when the export is an Effect.                   |
| `behavior.expected` | For effect programs | Value produced by `Effect.runSync(exported)`.                 |
| `behavior.cases`    | For functions       | Array of `{ "args": [...], "expected": ... }` calls.          |

A contract has exactly two behavior shapes:

- **Effect program** — set `"effect": true` and provide `"expected"`. The test runs
  the export with `Effect.runSync` and compares the result.

  ```funscript
  import { Effect } from "effect"
  
  export program =
    effect {
      value <- Effect.succeed(2)
      => value + 1
    }
  ```

  ```json
  { "export": "program", "effect": true, "expected": 3 }
  ```

- **Plain function** — omit `effect` and provide `cases`. The test asserts the
  export is a function, calls it with each case's `args`, and compares the return
  value to `expected`.

  ```funscript
  as { export function square(value: f64): f64 { return value * value; } }
  
  export squareNumber = (value: Number) => square(value)
  ```

  ```json
  {
    "export": "squareNumber",
    "cases": [
      { "args": [3], "expected": 9 },
      { "args": [-2], "expected": 4 }
    ]
  }
  ```

## How tokens are classified

Token classification happens at two levels: the lexer turns source characters
into `TokenType` values, and the contract suite partitions those values into
"covered" and "legacy".

### Source to token

`src/lexer/tokens.ts` defines the `TokenType` enum. Its string values are the
identifiers used everywhere else, including in `catalog.json`. Note that keyword
token values are the keyword text itself (`AND = "and"`, `LARROW = "<-"`), while
structural and literal tokens use symbolic names (`NUMBER`, `TS_CODE`).

The lexer classifies input in this order:

1. **Layout** — line starts emit `INDENT` / `DEDENT`, line breaks emit
   `NEWLINE`, and the end of input emits `EOF`. Tabs are rejected.
2. **JSX** — only in `.funx` files (or when JSX is explicitly enabled). The lexer
   emits `JSX_TAG_OPEN`, `JSX_CLOSING_TAG_OPEN`, `JSX_TAG_CLOSE`,
   `JSX_SLASH_CLOSE`, `JSX_ATTRIBUTE_NAME`, and `JSX_TEXT`. A `<` is treated as a
   comparison operator unless it starts a tag.
3. **Comments and banned symbols** — `//` comments are skipped. Banned operators
   such as `&&`, `||`, `!`, `==`, `!=`, `===`, `!==`, and `??` raise a lexer error
   with a migration hint instead of producing a token.
4. **Multi-character operators** — `???`, `...`, `=>`, `<-`, `|>`, `**`, `#=`,
   `#!`, `@=`, `@!`, `<=`, and `>=` are matched before their single-character
   prefixes.
5. **Literals** — numbers become `NUMBER`; double-quoted strings become `STRING`
   or a `STRING_PART` / `INTERPOLATION_START` / `INTERPOLATION_END` sequence;
   backtick templates become `TEMPLATE_STRING` or `TEMPLATE_PART` /
   `INTERPOLATION_START` / `INTERPOLATION_END`.
6. **Identifiers and keywords** — after reading an identifier-shaped run:
   - `BANNED_KEYWORDS` are checked first and throw an actionable error, with
     narrow escapes where the word is legal (for example after a `.`, inside an
     import, or as a record field).
   - `KEYWORDS` is consulted next, producing tokens such as `and`, `effect`,
     `match`, `schema`, and `service`.
   - `_` becomes `UNDERSCORE`.
   - A leading uppercase letter produces `UPPER_IDENTIFIER`; otherwise
     `IDENTIFIER`.
7. **Verbatim blocks** — `ts { ... }` emits `TS` followed by `TS_CODE`, and
   `as { ... }` emits `AS` followed by `AS_CODE`. The body is captured with
   brace, string, and comment awareness, and its trimmed start is recorded as
   `contentStart`.
8. **Single-character operators and delimiters** — the remaining punctuation
   maps to tokens such as `EQ`, `PLUS`, `LPAREN`, `LBRACE`, and `COMMA`.

The enum groups are:

| Group                    | Examples                                                    |
| ------------------------ | ----------------------------------------------------------- |
| Layout                   | `INDENT`, `DEDENT`, `NEWLINE`, `EOF`                        |
| Literals                 | `NUMBER`, `STRING`, `TS_CODE`, `AS_CODE`, `TEMPLATE_STRING` |
| Identifiers              | `IDENTIFIER`, `UPPER_IDENTIFIER`                            |
| Keywords                 | `and`, `effect`, `match`, `schema`, `service`               |
| Operators and delimiters | `=>`, `<-`, `                                               | >`, `#=`, `@=`, `>=`, `...` |
| JSX                      | `JSX_TAG_OPEN`, `JSX_TEXT`, `JSX_ATTRIBUTE_NAME`            |

### Contract to token coverage

The suite treats the set of all `TokenType` values as the universe that must be
classified. Each value must appear in exactly one of two places:

- the union of every contract's `tokens` array, or
- the `legacyTokens` array in `catalog.json`.

`unclassifiedTokens(tokens, contracts, legacyTokens)` implements this check by
building the classified set, removing duplicates from the observed tokens, and
returning the sorted remainder. The test expects that remainder to be empty.

`legacyTokens` is a debt ledger for tokens that predate the contract system. It
is not a second documentation channel: once a token is covered by a contract, it
must be removed from the legacy list.

## Invariants enforced by the suite

The contract tests fail if any of the following is false:

- Every value in `legacyTokens` exists in `TokenType`.
- Every token named by a contract exists in `TokenType`.
- `legacyTokens` contains no duplicates.
- No token is both contract-covered and legacy.
- Every token value is covered or legacy.
- Every contract `id` is unique, and `title` / `description` are non-empty.
- Every contract declares at least one token.
- Every contract sets `behavior.export`.
- A contract is either an effect program (`effect: true` plus `expected`) or has
  at least one case; every case has `args` and `expected`.
- Every declared token is actually emitted when the fixture is lexed.
- The fixture compiles and its export produces the declared behavior.

## Adding a contract

1. **Create the fixture.** Add a `.fun` file under
   `tests/fixtures/language-contracts/` that compiles, exports the binding you
   want to test, and uses the tokens you intend to cover.

2. **Add a catalog entry.** Append to `contracts` in `catalog.json` with a unique
   kebab-case `id`, a title, a description, the fixture filename, the token list,
   and a behavior block.

3. **List tokens precisely.** Use the exact `TokenType` string values, such as
   `"effect"`, `"<-"`, `"=>"`, `"NUMBER"`, or `"AS_CODE"`. Only list tokens the
   fixture really emits; the suite lexes it and checks each one.

4. **Update the legacy baseline.** If a token you now cover was in
   `legacyTokens`, remove it. Leaving it in both places fails the suite.

5. **Run the contract tests.**

   ```bash
   npx vitest run tests/language-contracts.test.ts
   ```

6. **Refresh generated references.** If you changed the catalog, regenerate the
   tested-examples page:

   ```bash
   npm run docs:generate
   ```

### Adding a brand-new token

When you introduce a token to `src/lexer/tokens.ts`, add its contract in the same
change. Do not add new tokens to `legacyTokens`; that list exists only for tokens
that were already in the language before the contract suite. The suite reports
the new value as unclassified until a contract covers it.

## Troubleshooting

| Failure                                                           | Fix                                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `New tokens need a documented, behavior-tested language contract` | Add a contract that lists the token, or remove the token.                    |
| `<id> must use token <token>`                                     | The fixture does not emit that token; correct the fixture or the token list. |
| `Remove covered tokens from the legacy baseline`                  | A token is in both a contract and `legacyTokens`; delete the legacy entry.   |
| `Remove obsolete legacy tokens`                                   | `legacyTokens` names a value that no longer exists in `TokenType`.           |
| `Remove obsolete contract tokens`                                 | A contract names a value that no longer exists in `TokenType`.               |
| Generated references are stale                                    | Run `npm run docs:generate`.                                                 |
