# Survey: Explicit-Return Migration Candidates and Safety Analysis

## Purpose and Boundary

This document gathers technical evidence for an architectural and tooling decision regarding explicit-return migration in FunScript. It surveys the current syntax definitions, parser mechanics, formatter expectations, and test suites, contrasting supported explicit-return constructs with evidenced and hypothesized legacy forms.

### Boundary and Scope
- **In Scope:**
  - Auditing `docs/syntax.md`, `src/parser/parser.ts`, `tests/parser.test.ts`, and `tests/formatter.test.ts`.
  - Documenting current explicit-return rules, AST representations, and parser enforcement.
  - Recording candidate before-and-after examples for syntax transformations.
  - Analyzing semantic safety limitations, ambiguous syntactic contexts, preview mechanisms, and rollback constraints.
  - Explicitly distinguishing evidenced historical syntax from unevidenced or banned language constructs.
  - Presenting balanced compatibility options for project leadership without choosing on behalf of the user.
- **Out of Scope:**
  - Implementing, generating, or running codemods or automated AST transforms.
  - Unilaterally altering language syntax, parser error rules, emitter behavior, or formatter output.
  - Deciding or enforcing breaking-change compatibility policies.
  - Assuming undocumented legacy forms exist without direct evidence in the repository or git history.

---

## Verified Starting Point: Current Rules and Implementation

An audit of the codebase establishes the current language specification and parser behavior:

### 1. Authoritative Documentation (`docs/syntax.md`)
- **Block Return Rule (§0.1, §3.1, §9.3, §9.4):**
  - "An inline expression is the concise return form. Every function block must end in `=> expr`; the final bare expression is never returned implicitly" ([syntax.md#L533-L537](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/docs/syntax.md#L533-L537)).
  - "In a braced or indented function block, `=> expression` is required for the final return and can also be used for an early return" ([syntax.md#L546-L548](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/docs/syntax.md#L546-L548)).
  - "The block must end with an explicit return, `=> value`" inside `effect` blocks ([syntax.md#L1533](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/docs/syntax.md#L1533)).
  - "An `effect` block ends with `=> value`, which returns that value. There is no `return` statement: branching uses `match`, and short-circuiting on a recoverable failure uses `<- Effect.fail(...)`" ([syntax.md#L1573-L1575](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/docs/syntax.md#L1573-L1575)).
  - "An `Effect` value returned with `=>` is **not** automatically yielded. It is returned as a value" ([syntax.md#L1577-L1579](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/docs/syntax.md#L1577-L1579)).
- **Concise Expression-Bodied Functions (§3.1):**
  - Single-line functions (`add = (a: Number, b: Number) => a + b`) do not use blocks or explicit `=>` return statements; the expression is the body ([syntax.md#L499](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/docs/syntax.md#L499)).
- **Early Returns (§3.1.1):**
  - `when (condition) => value` performs an early return from an enclosing function ([syntax.md#L557-L560](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/docs/syntax.md#L557-L560)).
- **Banned Surface (§0.1, §15):**
  - The `return` keyword is explicitly banned: "`if`, `else`, `then`, `switch`, ternary `? :`, `return` (use `match` or `when`... while function and effect blocks require an explicit `=> value` return)" ([syntax.md#L126-L128](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/docs/syntax.md#L126-L128), [syntax.md#L2313](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/docs/syntax.md#L2313)).

### 2. Lexer Token Definitions (`src/lexer/`)
- In [`src/lexer/tokens.ts#L123`](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/lexer/tokens.ts#L123), `return` is registered in `BANNED_KEYWORDS`:
  ```ts
  return: "FunScript uses '=> value' for explicit returns in function and effect blocks.",
  ```
- In [`src/lexer/lexer.ts#L580-L582`](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/lexer/lexer.ts#L580-L582), encountering `return` triggers a fatal `LexerError`. There is no token type for `return` in FunScript AST.

### 3. Parser Implementation (`src/parser/parser.ts`)
- **Block Dispatches and Flags:**
  - `parseFunctionDeclaration` calls `parseFunctionBody(true)` or `parseBraceBlock(true)` / `parseIndentedBlock(true)` ([parser.ts#L587-L596](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/parser/parser.ts#L587-L596)).
  - Arrow expressions (`() => ...`, `(params) => ...`, `=> ...`) call `parseFunctionBody(true)` ([parser.ts#L1014, L1072, L1099, L1115](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/parser/parser.ts#L1014-L1115)).
  - `parseMutBlock` (`mut (draft) => ...`) calls `parseFunctionBody()` with default `requireExplicitReturn = false` ([parser.ts#L733](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/parser/parser.ts#L733)).
  - `parseMatchExpression` match arms call `parseFunctionBody()` with default `requireExplicitReturn = false` ([parser.ts#L1324](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/parser/parser.ts#L1324)).
- **Explicit Return Parsing:**
  - Matching `TokenType.ARROW` inside `parseBraceBlock` or `parseIndentedBlock` instantiates a `ReturnStatement` node (`kind: "ReturnStatement"`, `argument: retExpr`) ([parser.ts#L1672-L1680, L1788-L1796](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/parser/parser.ts#L1672-L1796)).
- **Parser Enforcement and Exceptions:**
  - If a function block ends with a bare expression when `requireExplicitReturn` is true:
    ```ts
    if (requireExplicitReturn && expr.kind !== "MatchExpression" && expr.kind !== "EffectBlockExpression") {
      throw new ParseError("Function block must end with an explicit '=> returnValue'", expr.span);
    }
    ```
    ([parser.ts#L1735, L1855](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/parser/parser.ts#L1735-L1855)).
    *Note:* Bare trailing `MatchExpression` and `EffectBlockExpression` bypass this error and are retained as `finalExpression`.
  - Trailing binding declarations (`bind = ...`) at the end of an indented block throw `ParseError("Function block must end with an explicit '=> returnValue'")` ([parser.ts#L1842](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/parser/parser.ts#L1842)).
  - Reaching the block terminator without a `ReturnStatement` or recognized `finalExpression` throws `ParseError("Function block must end with an explicit '=> returnValue'")` ([parser.ts#L1755-L1757, L1876-L1878](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/parser/parser.ts#L1755-L1878)).
- **Effect Blocks (`parseEffectBlock`):**
  - Requires `TokenType.ARROW` for the final return ([parser.ts#L1445-L1450](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/parser/parser.ts#L1445-L1450)).
  - Any trailing bare expression in an effect block throws `ParseError("Effect block must end with an explicit '=> returnValue'")` ([parser.ts#L1514-L1516, L1532-L1534](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/parser/parser.ts#L1514-L1534)). Unlike function blocks, effect blocks do *not* exempt match or effect expressions.

### 4. Formatter and Emitter Behavior (`src/formatter/`, `src/emitter/`)
- In [`src/formatter/index.ts#L612-L613`](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/formatter/index.ts#L612-L613), `ReturnStatement` is formatted canonically as `=> ${this.formatExpression(stmt.argument, indent)}`.
- In [`src/formatter/index.ts#L686`](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/formatter/index.ts#L686), `EffectBlockExpression` prefixes its `finalExpression` with `=> `.
- In [`src/formatter/index.ts#L653`](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/formatter/index.ts#L653), `BlockStatement.finalExpression` (such as exempted bare match expressions) formats without `=> `.
- In [`src/emitter/emitter.ts#L873-L882, L894-L900`](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/emitter/emitter.ts#L873-L900), both `ReturnStatement` and `finalExpression` emit TypeScript `return (${arg});`.

---

## Status of Legacy Forms: Presence vs. Absence

### Evidenced Historical Forms (From Git History and Tests)
1. **Implicit final-expression returns in function blocks:**
   - Evidenced in git commit `d15ec0c` ("feat: require explicit returns in function blocks", Nov 1, 2026) and active regression test in [`tests/parser.test.ts#L728-L733`](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/tests/parser.test.ts#L728-L733):
     ```funscript
     increment = (value) =>
       next = value + 1
       next
     ```
     Originally, the parser assigned the last expression of any block to `finalExpression` and emitted `return`.
2. **Implicit trailing binding returns in function blocks:**
   - Evidenced in `d15ec0c` diff in `src/parser/parser.ts`:
     ```ts
     statements.push(bind);
     finalExpression = bind.id;
     ```
     A trailing `x = value` binding previously returned the identifier `x`.
3. **Implicit final-expression returns in effect blocks:**
   - Evidenced in git commit `7ec6982` ("feat: require explicit effect returns and numeric comparisons", Nov 2, 2026), commit `ca60595` (TASK-156 doc updates), and active regression test in [`tests/parser.test.ts#L665-L668`](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/tests/parser.test.ts#L665-L668):
     ```funscript
     result = effect {
       user <- fetchUser()
       user
     }
     ```

### Unevidenced or Absent Forms
- **The `return` keyword:**
  - **Evidence status: ABSENT.** There is zero evidence in repository history, documentation, tests, or past commits that FunScript ever permitted a keyword-based `return expr` statement. `return` has always been banned by the lexer ([tokens.ts#L123](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/lexer/tokens.ts#L123)), with no AST production or emitter logic backing it.
- **Legacy forms in concise expression bodies:**
  - Single expression lambdas (`(a, b) => a + b`) were never subject to implicit-return deprecation; they are the standard concise form ([tests/parser.test.ts#L744-L748](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/tests/parser.test.ts#L744-L748)).
- **Legacy forms in `mut` blocks and `match` arms:**
  - `mut (draft) => ...` operates via in-place mutation of the draft ([tests/parser.test.ts#L555-L560](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/tests/parser.test.ts#L555-L560)); it never used or required explicit returns. Match arms evaluate direct expressions or statements without explicit `=>` return prefixes.

---

## Candidate Migration Surfaces and Examples

The following before-and-after examples demonstrate patterns affected by explicit-return migration:

### Candidate 1: Function Block with Trailing Bare Expression
- **Status:** Proved legacy form. Rejected by current parser ([tests/parser.test.ts#L728-L733](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/tests/parser.test.ts#L728-L733)). Supported with `=>` ([tests/parser.test.ts#L538-L551](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/tests/parser.test.ts#L538-L551)).
- **Before (Legacy / Invalid):**
  ```funscript
  calculate = (x: Number) =>
    multiplier = 2
    temp = x * multiplier
    temp + 1
  ```
- **After (Migrated / Valid):**
  ```funscript
  calculate = (x: Number) =>
    multiplier = 2
    temp = x * multiplier
    => temp + 1
  ```

### Candidate 2: Function Block with Trailing Binding Declaration
- **Status:** Proved legacy form (formerly returned the bound identifier). Rejected by current parser ([parser.ts#L1842](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/parser/parser.ts#L1842)).
- **Before (Legacy / Invalid):**
  ```funscript
  buildUser = (id: String, name: String) =>
    normalized = name |> String.trim()
    user = { id, name: normalized }
  ```
- **After (Migrated / Valid):**
  ```funscript
  buildUser = (id: String, name: String) =>
    normalized = name |> String.trim()
    user = { id, name: normalized }
    => user
  ```

### Candidate 3: Effect Block with Trailing Bare Expression
- **Status:** Proved legacy form. Rejected by current parser ([tests/parser.test.ts#L665-L668](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/tests/parser.test.ts#L665-L668)). Supported with `=>` ([tests/parser.test.ts#L670, L676-L685](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/tests/parser.test.ts#L670-L685)).
- **Before (Legacy / Invalid):**
  ```funscript
  loadUser = (id: String) =>
    effect {
      user <- UserRepo.find(id)
      _ <- Console.log("Found user")
      user
    }
  ```
- **After (Migrated / Valid):**
  ```funscript
  loadUser = (id: String) =>
    effect {
      user <- UserRepo.find(id)
      _ <- Console.log("Found user")
      => user
    }
  ```

### Candidate 4: Function Block Ending in Bare Match Expression
- **Status:** Syntactic quirk in current parser ([parser.ts#L1735, L1855](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/parser/parser.ts#L1735-L1855)). Parses today without error, but represents an inconsistency with general explicit-return rules.
- **Before (Current parser exception):**
  ```funscript
  describeNumber = (n: Number) =>
    logged = logInspection(n)
    match n
      | 0 => "zero"
      | _ => "other"
  ```
- **Candidate Migration Option A (Explicit return prefix):**
  ```funscript
  describeNumber = (n: Number) =>
    logged = logInspection(n)
    => match n
      | 0 => "zero"
      | _ => "other"
  ```
- **Candidate Migration Option B (Refactor to expression body if single statement):**
  ```funscript
  describeNumber = (n: Number) => match n
    | 0 => "zero"
    | _ => "other"
  ```

---

## Safety Limitations and Cases That Cannot Be Proven Safe

Any automated migration tool or codemod faces significant semantic boundaries where safe code transformation cannot be proven without human intervention or full type-checker integration:

### 1. Ambiguity Between Side Effects and Intended Return Values in Functions
In impure functions containing multiple statements, FunScript does not require a `void` discard for normal function calls (unlike `_ <-` in `effect` blocks).
Consider:
```funscript
saveState = (state: State) =>
  serialized = serialize(state)
  writeDisk(serialized)
```
- **Uncertainty:** Did the author intend `saveState` to return the result of `writeDisk(...)` (e.g., bytes written or status code)? Or was `writeDisk` called solely for its side effect, with the function contract intending to return `Unit` / `void`?
- **Safety Risk:** Mechanically prepending `=> writeDisk(...)` changes the inferred TypeScript return type from `void` to `number`/`boolean`, which can leak implementation internals and break downstream caller type contracts.

### 2. Effect Block Expressions: Yield (`<-`) vs. Return (`=>`) vs. Discard (`_ <-`)
This is the highest-risk ambiguity in the language. Per [`docs/syntax.md#L1577-L1579`](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/docs/syntax.md#L1577-L1579), **an `Effect` value returned with `=>` is not automatically yielded; it is returned as a plain value**.
Consider an invalid legacy block:
```funscript
program = effect {
  user <- fetchUser()
  Console.log("Done")
}
```
If an automated tool mechanically converts the trailing line to `=>`:
```funscript
program = effect {
  user <- fetchUser()
  => Console.log("Done")
}
```
- **Semantic Defect:** `Console.log("Done")` returns an `Effect<void>`. Because `=>` does not yield, `Console.log` **is never executed**. The effect block completes by returning an unexecuted `Effect` generator value, creating a silent runtime bug.
- **Alternative Intent:** The author may have intended:
  ```funscript
  program = effect {
    user <- fetchUser()
    _ <- Console.log("Done")
    => Unit
  }
  ```
- **Conclusion:** A mechanical migration tool **cannot safely decide** whether an unadorned expression in an effect block was intended to be yielded with `<-`, executed and discarded with `_ <-`, or returned with `=>`.

### 3. Trailing Binding Declarations
If a block ends with `result = compute()`:
- In the original pre-`d15ec0c` parser, this implicitly returned `result`.
- However, prepending `=>` directly (`=> result = compute()`) is a syntax error.
- Rewriting to two statements:
  ```funscript
  result = compute()
  => result
  ```
  assumes `result` was not an unused variable or a mistake. If the author intended `compute()` to be executed without returning `result`, this transformation preserves dead assignments or exposes internal variables.

### 4. Preservation of Comments and Syntactic Spans
- In FunScript's AST, comments are extracted separately and associated during formatting via end-of-line heuristics ([src/formatter/index.ts#L625-L654](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/formatter/index.ts#L625-L654)).
- Inserting `=>` tokens into source code or synthesizing AST nodes can shift token span boundaries and detach trailing or dangling comments from their enclosing expressions, degrading documentation integrity.

---

## Ambiguous and Edge Cases

| Pattern / Context | Syntactic Form | Ambiguity / Parser Quirk | Reference |
| :--- | :--- | :--- | :--- |
| **Trailing `MatchExpression` in function block** | `f = () => \n log() \n match x ...` | Accepted by parser today without `=>` due to explicit exception in `parser.ts#L1735, L1855`. Adding `=>` is technically breaking for existing code relying on the exemption. | [parser.ts#L1855](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/parser/parser.ts#L1855) |
| **Trailing `EffectBlockExpression` in function block** | `f = () => \n prepare() \n effect { ... }` | Accepted by parser without `=>` for the same reason. Bypasses explicit-return requirement. | [parser.ts#L1855](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/parser/parser.ts#L1855) |
| **Multiline match as lambda body** | `f = () => \n match x ...` | Parsed as expression body (not a block statement) via `parser.ts#L1641-L1643`. Does not require `=>`. | [parser.ts#L1641](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/parser/parser.ts#L1641) |
| **`when` conditional statement blocks** | `when (cond) { \n stmt \n }` | `parseWhenStatement` calls `parseIndentedBlock()` with `requireExplicitReturn = false`. Must not have `=>` injected. | [parser.ts#L658](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/parser/parser.ts#L658) |
| **`mut (draft) =>` blocks** | `mut (d) => \n d.x = 1 \n d` | Draft blocks mutate in place; trailing expressions are ignored or invalid. Must not be migrated to `=>`. | [parser.ts#L733](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/parser/parser.ts#L733) |
| **Early returns with fallthrough** | `when (c) => a \n b` | If `b` is migrated to `=> b`, does it accurately reflect the author's control flow intent? | [syntax.md#L557](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/docs/syntax.md#L557) |

---

## Preview and Rollback Considerations

If an explicit-return migration workflow or command is introduced in the future, the following precautions and operational constraints apply:

### Preview Mechanisms
1. **Dry-Run Diff Generation:**
   Any migration tool must implement a non-destructive dry-run mode (e.g., `funscript migrate --dry-run` or `funscript check --suggest-fixes`) outputting a unified diff of proposed insertions.
2. **Compiler Warning Pass:**
   Rather than hard parse errors on legacy input, a transitional compiler flag (e.g. `--warn-implicit-returns`) could emit source-located diagnostics indicating lines where `=>` is missing.
3. **Formatter Idempotency Check:**
   Because the formatter canonically formats `ReturnStatement` as `=> expr` ([src/formatter/index.ts#L612-L613](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/formatter/index.ts#L612-L613)), any automated change must be validated against `format(format(code)) === format(code)`.

### Rollback Constraints
1. **Mechanical Irreversibility:**
   - **Crucial limitation:** An automated explicit-return migration is **not mechanically reversible**.
   - In FunScript, `=> expr` is the valid, idiomatic representation for both newly migrated returns and deliberately authored explicit returns. A reverse tool cannot distinguish an explicit return that was added by migration from one that was hand-authored.
2. **Version Control as the Sole Reversal Gate:**
   - Because code-level reversal is lossy, all migrations must occur in dedicated, clean git commits. Reversion must rely on `git revert` rather than a secondary codemod.
3. **AST Round-Trip Fidelity:**
   - Codemods that parse and re-emit entire files risk stripping user formatting, indentation nuances, or trailing comments. Source-level micro-edits (inserting `=> ` at exact token spans) are safer than full AST re-serialization.

---

## Unsupported Assumptions

The following assumptions are unsupported by the codebase and must not guide migration design:

1. **Unsupported Assumption: "A `return` keyword exists in legacy code."**
   - *Fact:* `return` is banned at the lexer level ([tokens.ts#L123](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/lexer/tokens.ts#L123)) and has no grammar representation. Codemods do not need to convert `return x` to `=> x`.
2. **Unsupported Assumption: "Trailing expressions in function blocks always indicate return values."**
   - *Fact:* A trailing expression could be a side-effecting call meant to execute in a void-returning function.
3. **Unsupported Assumption: "Trailing bare expressions in `effect` blocks can safely receive `=>`."**
   - *Fact:* Prepending `=>` to an effect expression prevents it from executing (it returns the unyielded effect). This is almost certainly a semantic bug.
4. **Unsupported Assumption: "Trailing `match` expressions in functions are syntax errors."**
   - *Fact:* The parser explicitly exempts `MatchExpression` and `EffectBlockExpression` at block ends ([parser.ts#L1735, L1855](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-9/src/parser/parser.ts#L1735-L1855)).

---

## Decisions Requested (Options for User / Architecture Alignment)

The following open decisions are submitted for human / team lead guidance without choosing prematurely:

### Decision 1: Policy on Trailing `match` and `effect` in Function Blocks
- **Option A (Strict Unification):** Remove the exemption in `src/parser/parser.ts#L1735, L1855`. Require all function blocks to end with explicit `=> match ...` or `=> effect { ... }`, or be written as expression-bodied functions (`f = () => match ...`).
- **Option B (Preserve Current Exemption):** Retain the parser rule that permits bare trailing `match` and `effect` without `=>`, documenting it as a language convenience for block-level control-flow terminators.

### Decision 2: Handling Ambiguous Trailing Expressions in `effect` Blocks
- **Option A (Interactive / Manual Only):** Never automatically migrate trailing expressions in `effect` blocks. Flag them as compile errors and require the author to choose between `_ <- expr` (execution) and `=> expr` (return).
- **Option B (Type-Informed Migration):** If a migration tool is built, require integration with the TypeScript type checker: if the trailing expression has type `Effect<A, E, R>`, report an error or suggest `_ <-`; if it has a non-Effect value type, suggest `=>`.

### Decision 3: Scope of Migration Tooling
- **Option A (No Dedicated Codemod):** Rely entirely on clear compiler diagnostics (`ParseError: Function block must end with an explicit '=> returnValue'`) to guide manual developer updates during file edits.
- **Option B (Assisted CLI Tool):** Implement a conservative CLI command (`funscript migrate --explicit-returns`) that transforms unambiguous function block expressions, leaving ambiguous or effect-block cases untouched with warning markers.
