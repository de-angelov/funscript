# Survey: Language Compatibility Policy Options

## Purpose and Boundary

This document surveys compatibility policy options for FunScript. As the language matures alongside the upstream Effect ecosystem, policies are required to govern three distinct evolutionary pressures:

1. **Effect Aliases:** Handling renames, deprecations, and removals in upstream Effect companion modules.
2. **Breaking Syntax Changes:** Evolving language syntax, grammar productions, and enforcement rules.
3. **Newly Ambiguous Pipeline Operations:** Managing pipeline companion resolution when catalog expansions or type inference limits introduce ambiguity diagnostics.

### Boundary and Scope
- **In Scope:**
  - Auditing current Effect compatibility aliases in [pipeline-catalog.ts](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/src/emitter/pipeline-catalog.ts#L50-L60) and [syntax.md](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/docs/syntax.md#L663-L667).
  - Auditing historical and documented breaking syntax changes in [syntax.md](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/docs/syntax.md#L533-L560) and [tooling.md](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/docs/tooling.md#L1-L60).
  - Auditing ambiguous pipeline diagnostics in [emitter.ts](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/src/emitter/emitter.ts#L748-L764) and [pipeline-companions.ts](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/src/compiler/pipeline-companions.ts#L8-L75).
  - Presenting concrete, actionable policy options across alias removal, breaking syntax, and newly ambiguous operations.
  - Analyzing versioning strategies, notice periods, and migration tooling tradeoffs.
  - Providing representative code examples and comparative evaluation criteria.
- **Out of Scope:**
  - Unilaterally deciding or adopting a specific compatibility policy.
  - Implementing compiler, parser, emitter, or tooling changes.
  - Modifying Effect dependencies or editing existing language syntax rules.

---

## Verified Starting Point: Codebase Facts and Technical Precedent

An audit of the current compiler, documentation, and test suite identifies the technical constraints and historical practices governing compatibility:

### 1. Current Effect Compatibility Aliases
- **Compiler Pipeline Catalog:**
  In [`EFFECT_PIPELINE_COMPATIBILITY_ALIASES`](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/src/emitter/pipeline-catalog.ts#L50-L54), FunScript retains historical spellings where Effect v4 introduced renames:
  ```ts
  export const EFFECT_PIPELINE_COMPATIBILITY_ALIASES: Readonly<Record<string, string>> = {
    catchAll: "catch",
  };
  ```
  In [`pipelineCompanionCandidates`](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/src/emitter/pipeline-catalog.ts#L55-L60), candidates include operations matching the catalog or aliased within `Effect`. In [`EFFECT_V4_MEMBER_RENAMES`](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/src/emitter/emitter.ts#L102-L105), `catchAll` is mapped to `catch` and `fork` to `forkChild`.
- **Authoritative Syntax Contract:**
  Section 4.2 of [syntax.md](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/docs/syntax.md#L663-L667) explicitly defines the status of these aliases:
  > *"Effect companion names follow the installed Effect API. Existing Effect pipeline compatibility aliases are retained explicitly in the compiler's catalog; they are exceptions for compatibility, not a general naming convention for new operations."*
- **Historical Precedent for Alias Removal:**
  Commit `e603284` removed legacy `Number` comparison aliases (such as `greaterThan` in favor of `isGreaterThan`, and `lessThan` in favor of `isLessThan`) across examples, documentation, and tests, synchronizing FunScript with Effect's public exports and reinforcing native comparison operators.
- **Blessed Type Aliases:**
  Section 12.1 of [syntax.md](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/docs/syntax.md#L1935-L1970) blesses standard Effect type aliases (`Effect`, `Option`, `Either`, `Layer`, `Stream`, `Array`, `Queue`, `Fiber`, `Deferred`, `PubSub`, `Ref`, `Scope`) which auto-inject imports and map to their canonical TypeScript representations.

### 2. Documented Breaking Syntax Changes
- **Explicit Return Invariant:**
  Commit `7ec6982` eliminated implicit final expression returns. Function blocks and effect blocks require explicit `=> value` returns ([syntax.md#L533-L560](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/docs/syntax.md#L533-L560), [syntax.md#L1530-L1580](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/docs/syntax.md#L1530-L1580)). Bare trailing expressions in blocks are rejected by the parser.
- **Relational Comparisons Restricted to Numbers:**
  The operators `<`, `<=`, `>`, and `>=` are restricted strictly to proven numbers via TypeScript compilation checks ([syntax.md#L625-L662](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/docs/syntax.md#L625-L662), [language-change-journey.md](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/docs/language-change-journey.md#L1-L40)). String and domain comparisons must use explicit Effect orders (e.g. `String.Order`, `DateTime.greaterThan`), preventing JavaScript-style type coercion bugs.
- **Prohibited Control Flow and Operators:**
  FunScript explicitly rejects traditional imperative constructs (`for`, `while`, `do`, `break`, `continue`, `return`, `if/else`, ternary `? :`) and legacy symbol booleans (`&&`, `||`, `!`) in favor of `match`, `when`, and `and`/`or`/`not` ([syntax.md#L125-L135](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/docs/syntax.md#L125-L135)).

### 3. Pipeline Companion Resolution and Ambiguity Diagnostics
- **Type-Directed Resolution Without Priority Fallback:**
  Pipeline stage companion inference in [`inferPipelineCompanions`](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/src/compiler/pipeline-companions.ts#L8-L75) uses TypeScript's type checker on provisional emitted code to determine the receiver type.
- **Strict Ambiguity Diagnostic:**
  When a bare stage cannot be proven to belong to a specific companion and multiple candidate modules offer that operation name (e.g., `map` present in `Array`, `Effect`, `Option`, `Result`, and `Chunk`), [`assertPipelineStageIsNotAmbiguous`](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/src/emitter/emitter.ts#L748-L764) raises a compile-time `PipelineResolutionError`:
  ```text
  map is ambiguous for this pipeline; write Array.map(...) or Option.map(...)
  ```
  The compiler architecture intentionally avoids fallback heuristics or precedence orders between companions.

### 4. Tooling and CLI Context
- As documented in [tooling.md](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/docs/tooling.md#L1-L60), the CLI exposes a minimal, composable command surface (`check`, `fmt`, `run`, `build`). It does not currently provide automated migration commands (`migrate`), project scaffolding (`new`), or configuration-driven transformation hooks.

---

## Area 1: Effect Alias Removal Policy Options

When upstream Effect renames or deprecates an API (as occurred with `catchAll` -> `catch`), FunScript must determine how long to retain the older spelling and how to retire it.

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Upstream Effect Rename / Deprecation (e.g., catchAll -> catch)          │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │
           ┌─────────────────────────┼─────────────────────────┐
           ▼                         ▼                         ▼
   [Option 1A: Lockstep]    [Option 1B: Notice Window]  [Option 1C: Codemod]
   Immediate removal on      Retain alias + warning     CLI migrates code;
   dependency update         for N releases             retire on next bump
```

### Option 1A: Upstream Lockstep (Zero Retention)

Under this policy, FunScript treats upstream Effect exports as the sole source of truth. When the installed Effect dependency is upgraded, deprecated aliases are removed immediately from [`EFFECT_PIPELINE_COMPATIBILITY_ALIASES`](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/src/emitter/pipeline-catalog.ts#L50-L54).

- **Workflow:**
  1. Upgrade `effect` in `package.json`.
  2. Remove renamed keys from `EFFECT_PIPELINE_COMPATIBILITY_ALIASES` and `EFFECT_V4_MEMBER_RENAMES`.
  3. Bump FunScript minor version (in `0.x`) or major version (post-`1.0`).
- **Example:**
  ```funscript
  # Fails immediately at compile time upon upgrading:
  export recover = task |> catchAll((err) => Effect.succeed("fallback"))
  # Error: catchAll is not a recognized pipeline operation. Write Effect.catch(...)
  ```
- **Tradeoffs:**
  - *Advantages:* Zero catalog maintenance overhead; compiler never carries obsolete baggage; documentation remains 100% aligned with current Effect documentation.
  - *Disadvantages:* Causes immediate compile breaks for downstream users upgrading FunScript; forces simultaneous refactoring of all consumer call sites.

### Option 1B: Deprecation Notice Window with Static Diagnostics

Under this policy, aliases are retained for a defined notice period (e.g., two minor releases or six months). During this window, the compiler accepts the alias but emits a non-fatal warning diagnostic. Once the notice window expires, the alias is dropped.

- **Workflow:**
  1. Record the alias in a deprecation table with target removal version:
     `EFFECT_PIPELINE_COMPATIBILITY_ALIASES = { catchAll: { target: "catch", removedIn: "0.4.0" } }`.
  2. The compiler and LSP emit a diagnostic:
     `Warning: catchAll is deprecated in favor of catch and will be removed in v0.4.0`.
  3. The emitted TypeScript translates `catchAll` to `catch` seamlessly.
  4. At version `0.4.0`, remove the entry; bare calls become hard errors.
- **Example:**
  ```funscript
  # Emits compiler check warning, but generates valid TypeScript:
  export recover = task |> catchAll((err) => Effect.succeed("fallback"))
  # Diagnostic: 'catchAll' is deprecated. Use 'catch' instead (scheduled removal in v0.4.0).
  ```
- **Tradeoffs:**
  - *Advantages:* Gives users advance visibility without breaking continuous integration; predictable deprecation timeline; smooth adoption curve.
  - *Disadvantages:* Requires introducing warning diagnostic severity in the compiler (which currently uses binary pass/fail errors); increases catalog complexity during transition.

### Option 1C: Automated Migration Tooling (Codemod-Assisted Retirement)

Under this policy, aliases are retired alongside a dedicated CLI migration flag or script (e.g. `funscript fmt --migrate-aliases` or `funscript migrate`).

- **Workflow:**
  1. Announce alias retirement in release notes.
  2. Ship an automated migration rule that rewrites AST nodes or token streams, replacing alias identifiers with canonical Effect names.
  3. Drop support for the alias in the compiler catalog in the subsequent release.
- **Example:**
  ```bash
  # Before:
  # export recover = task |> catchAll(fallback)
  funscript fmt --migrate-aliases src/
  # After:
  # export recover = task |> catch(fallback)
  ```
- **Tradeoffs:**
  - *Advantages:* Eliminates manual developer toil; ensures mechanical accuracy across large repositories; facilitates rapid ecosystem modernization.
  - *Disadvantages:* Substantial engineering investment required to build and maintain safe AST/token rewriting tooling; adds CLI surface beyond current minimal design.

### Option 1D: Permanent Compatibility Shims (Indefinite Retention)

Under this policy, once an alias is accepted into `EFFECT_PIPELINE_COMPATIBILITY_ALIASES`, it is retained indefinitely.

- **Tradeoffs:**
  - *Advantages:* Permanent backwards compatibility for source code; zero migration churn.
  - *Disadvantages:* Perpetual compiler baggage; high risk of naming collisions if upstream Effect introduces an unrelated function with the old name; creates divergence between FunScript and Effect ecosystems.

---

## Area 2: Breaking Language and Syntax Changes Policy Options

Breaking syntax changes involve altering the grammar, parsing rules, or language invariants (such as the explicit return enforcement introduced in commit `7ec6982` or relational comparison restrictions).

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Language / Grammar Evolution (e.g., closing syntax exemptions)           │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │
           ┌─────────────────────────┼─────────────────────────┐
           ▼                         ▼                         ▼
  [Option 2A: SemVer-Strict]  [Option 2B: Staged Warn/Error] [Option 2C: Editions]
  Breaking changes only on     Phase 1: Warn on syntax       Project config flag
  major boundaries (0.x minor) Phase 2: Reject on syntax     selects language edition
```

### Option 2A: SemVer-Strict Cadence (Major / Pre-1.0 Minor Only)

Adhere to standard Semantic Versioning. During `0.x.y` development, breaking syntax changes are restricted to minor bumps (`0.2.0`, `0.3.0`). Once `1.0.0` is reached, breaking changes require a major version (`2.0.0`). Patch releases (`x.y.Z`) are strictly non-breaking bugfixes.

- **Workflow:**
  - Group syntax breaking changes into scheduled minor (pre-1.0) or major releases.
  - Document migrations in `CHANGELOG.md` and update `docs/syntax.md`.
- **Tradeoffs:**
  - *Advantages:* Universally understood industry standard; clear expectations for dependency managers and package consumers; prevents unexpected CI failures on patch updates.
  - *Disadvantages:* Can slow down language iteration if release cycles are infrequent; may accumulate breaking changes into large, disruptive upgrade hurdles.

### Option 2B: Staged "Warn-Then-Error" Enforcement

Introduce breaking grammar or invariant changes in two sequential release cycles.

- **Phase 1 (Deprecation Notice):** The parser accepts the legacy construct but annotates the AST with a deprecation warning or diagnostic. The formatter may automatically normalize it to modern syntax.
- **Phase 2 (Hard Rejection):** In the next release, the parser rejects the legacy construct with a syntax error pointing to the migration pattern.
- **Example: Trailing `match` in Function Blocks:**
  Today, a trailing `match` expression in a function block is accepted without `=>` due to an exemption in `parser.ts`:
  ```funscript
  # Legacy exemption:
  f = (x: Number) => {
    log(x)
    match x | 0 => "zero" | _ => "other"
  }
  ```
  - *Phase 1:* Accepted, but emits warning: *"Trailing match without explicit return '=>' is deprecated"*.
  - *Phase 2:* Hard parse error: *"Function block must end with explicit return '=> value'"*.
- **Tradeoffs:**
  - *Advantages:* Provides early discovery in developer editors before builds are blocked; allows phased repository modernization.
  - *Disadvantages:* Requires dual-state parsing logic; delays language cleanup by at least one release cycle.

### Option 2C: Language Editions / Feature Flags (`funscript.json`)

Allow repositories to specify a language edition (e.g. `"edition": "2026"`) or feature flags in their project configuration file.

- **Workflow:**
  - The compiler selects parser/checker rules based on the declared edition.
  - Newer editions enable strict invariants (e.g. mandatory explicit returns everywhere, stricter schema coercions), while older editions preserve legacy parsing.
- **Tradeoffs:**
  - *Advantages:* Decouples compiler toolchain upgrades from code refactoring; permits gradual multi-package migration within monorepos.
  - *Disadvantages:* Heavy complexity burden on the parser, AST, and documentation; fragments the FunScript community into distinct dialects; contradicts the "one way to write logic" philosophy described in [pit-of-success.md](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/docs/pit-of-success.md#L368-L400).

---

## Area 3: Newly Ambiguous Pipeline Operations Policy Options

FunScript's pipeline companion resolution relies on type inference via [`inferPipelineCompanions`](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/src/compiler/pipeline-companions.ts#L8-L75). When a pipeline receiver is untyped (`any`, `unknown`) or a union across modules, and the bare operation name belongs to multiple companion modules in [`PIPELINE_COMPANION_CATALOG`](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/src/emitter/pipeline-catalog.ts#L10-L48), the emitter throws [`PipelineResolutionError`](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/src/emitter/emitter.ts#L748-L764).

Crucially, **expanding the catalog** (for example, adding `Stream`, `Schedule`, or `Layer` operations, or upstream Effect adding new methods) can turn previously unambiguous bare calls into ambiguous compile errors.

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Pipeline Ambiguity Event (Catalog Expansion or Unproven Type)            │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │
           ┌─────────────────────────┼─────────────────────────┐
           ▼                         ▼                         ▼
  [Option 3A: Zero Fallback]  [Option 3B: Catalog Audit]  [Option 3C: Quick-Fix]
  Preserve hard error;       Treat new name collisions   LSP/CLI automated fixes
  never guess or prioritize  as breaking changes         guide explicit syntax
```

### Option 3A: Strict Invariant Enforcement (Zero Fallback / Status Quo)

Maintain the existing core language invariant: **ambiguous pipeline operations are always rejected at compile time; priority fallback is prohibited.**

- **Behavior:**
  When a stage is ambiguous, the compiler rejects compilation with an actionable error directing the developer to write the qualified companion call:
  ```funscript
  # Unproven input:
  export process = (data) => data |> map((x) => x + 1)
  # Compiler Error:
  # map is ambiguous for this pipeline; write Array.map(...) or Option.map(...)
  ```
- **Tradeoffs:**
  - *Advantages:* Perfectly sound; eliminates silent runtime or semantic bugs; guarantees deterministic TypeScript output; adheres strictly to [TECH.md](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/TECH.md#L9-L13).
  - *Disadvantages:* Any addition to `PIPELINE_COMPANION_CATALOG` that creates a new shared method name can break existing untyped bare call sites.

### Option 3B: Catalog Expansion Gating and Collision Impact Audits

Under this policy, additions to [`PIPELINE_COMPANION_CATALOG`](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/src/emitter/pipeline-catalog.ts#L10-L48) are formally audited for naming collisions against all existing candidate modules before inclusion.

- **Workflow:**
  1. Maintain an automated test checking cross-module method name overlap in the catalog.
  2. If adding a new companion module (such as promoting `Stream` from [`DEFERRED_PIPELINE_COMPANION_MODULES`](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/src/emitter/pipeline-catalog.ts#L62-L64)) introduces overlapping names (e.g. `filter`, `take`), that addition is classified as a **breaking change** and held for a scheduled breaking release.
  3. Release notes explicitly list newly ambiguous operations and migration paths.
- **Tradeoffs:**
  - *Advantages:* Protects developers from sudden compile failures on routine compiler upgrades; maintains rigorous oversight of the companion catalog.
  - *Disadvantages:* Slows down the integration of rich Effect modules into FunScript's bare pipeline syntax.

### Option 3C: First-Class Editor Quick-Fixes and Disambiguation Diagnostics

Retain strict compiler rejection (Option 3A), but augment the Language Server Protocol (LSP) and compiler error messages with automated code actions:

1. **Quick-Fix 1 (Qualify Callee):** Automatically rewrites the bare call to qualified form based on candidate choices:
   ```funscript
   # Candidate options presented in editor:
   data |> Array.map((x) => x + 1)
   data |> Option.map((x) => x + 1)
   ```
2. **Quick-Fix 2 (Annotate Receiver):** Suggests adding a type annotation to the input parameter or binding so type-directed inference succeeds:
   ```funscript
   export process = (data: Array<Number>) => data |> map((x) => x + 1)
   ```
- **Tradeoffs:**
  - *Advantages:* Resolves developer ambiguity in seconds without weakening type safety or introducing resolver heuristics; keeps compiler output deterministic.
  - *Disadvantages:* Requires LSP code action implementation; does not alter CI failures for existing code until addressed by the developer.

### Option 3D: Lexical Companion Directives (`using` / Module Scopes) — Evaluated and Discouraged

Under this concept, a source file or block could declare a fallback companion (e.g., `using companion Effect`). If receiver type inference failed, the compiler would select `Effect` rather than raising an ambiguity diagnostic.

- **Tradeoffs and Analysis:**
  - *Advantages:* Reduces qualification noise in files dominated by a single data type.
  - *Disadvantages:* **Directly violates core FunScript design decisions.** Introducing file-level fallback creates invisible precedence order, makes code fragile when refactored across files, and undermines the explicit guarantees described in [pit-of-success.md](file:///home/dangelov/projects/funscript/funscript-board/workspaces/repo-agent-3/docs/pit-of-success.md#L64-L100). This option is documented here to illustrate its structural drawbacks.

---

## Comparative Tradeoff Evaluation

The following matrix contrasts the primary policy options across critical engineering dimensions:

| Dimension | Option A (Strict / Immediate) | Option B (Staged / Notice Period) | Option C (Tooling / Codemod) |
| :--- | :--- | :--- | :--- |
| **Semantic Correctness** | **Highest:** Invariants strictly enforced immediately; zero ambiguous states. | **High:** Eventual consistency; temporary tolerance of legacy forms with warnings. | **High:** Automated transformations ensure exact semantic parity. |
| **Developer Upgrade Friction** | **High:** Builds break immediately on upgrade; requires immediate manual edits. | **Low:** Advance notice via non-fatal warnings allows scheduled refactoring. | **Lowest:** Single command modernizes codebase automatically. |
| **Compiler & Catalog Complexity** | **Lowest:** No deprecation state, no fallback logic, minimal catalog surface. | **Medium:** Requires warning diagnostic infrastructure and catalog versioning. | **High:** Requires AST transformation framework and CLI command surface. |
| **Upstream Effect Synchronization** | **Instant:** Mirrors installed Effect exports directly. | **Lagged:** Carries aliases across notice windows. | **Managed:** Rapidly transitions code to match upstream releases. |
| **Language Dialect Drift** | **None:** Exactly one valid syntax across all projects. | **Minimal:** Deprecations are short-lived. | **None:** Code is quickly brought up to current standard. |

---

## Synthesis: Versioning, Notice, and Migration Policies

A comprehensive compatibility policy coordinates versioning cadence, notice duration, and migration tooling:

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             Proposed Policy Synthesis                            │
├─────────────────────┬─────────────────────────────────────┬──────────────────────┤
│ Category            │ Recommended Approach                │ Upgrade Path         │
├─────────────────────┼─────────────────────────────────────┼──────────────────────┤
│ Effect Aliases      │ 2-minor deprecation notice window   │ Compiler warning ->  │
│                     │ with LSP suggestion (Option 1B)     │ hard error in N+2    │
├─────────────────────┼─────────────────────────────────────┼──────────────────────┤
│ Breaking Syntax     │ SemVer-strict cadence (Option 2A)   │ Released in 0.x.0 or │
│                     │ + Staged Warn/Error (Option 2B)     │ 1.0.0 with notice    │
├─────────────────────┼─────────────────────────────────────┼──────────────────────┤
│ Pipeline Ambiguity  │ Strict Zero-Fallback (Option 3A)    │ Actionable error     │
│                     │ + Collision Gating (Option 3B)      │ + LSP Quick-Fixes    │
└─────────────────────┴─────────────────────────────────────┴──────────────────────┘
```

### 1. Versioning Strategy
- **Pre-1.0 (`0.x.y`):**
  - Patch releases (`0.x.y` where `y > 0`): Bug fixes, internal refactorings, performance improvements, and non-colliding catalog additions only. Zero breaking changes.
  - Minor releases (`0.x.0`): May introduce breaking syntax changes or retire deprecated aliases, provided they were announced in prior minor versions.
- **Post-1.0 (`X.y.z`):**
  - Major releases (`X.0.0`): Exclusive home for breaking syntax, grammar changes, and alias removals.
  - Minor releases (`1.Y.0`): Backward-compatible feature additions, deprecation warnings for upcoming breaking changes, and non-colliding catalog additions.

### 2. Notice Windows and Deprecation Lifecycle
- **Minimum Notice Duration:** Deprecated aliases and legacy syntax must remain supported as warnings for at least **one full minor release cycle** before removal (e.g. deprecated in `0.3.0`, removed in `0.4.0` or `1.0.0`).
- **Actionable Diagnostic Messages:** Every deprecation diagnostic must specify:
  1. The deprecated construct.
  2. The canonical replacement.
  3. The scheduled removal version.

### 3. Migration Strategy
- In the absence of a standalone `funscript migrate` tool, every breaking change must provide:
  1. Clear, side-by-side migration patterns in `docs/syntax.md`.
  2. Actionable compile diagnostics that cite the exact replacement syntax (e.g. *"write Effect.catch(...) instead of catchAll"*).
  3. Formatter idempotence for newly accepted canonical forms.

---

---

## Human Decision (TASK-102)

**Adopted: Strict Zero-Alias Policy.**

- **Rationale:** FunScript is in early active development with zero external production consumers. Obsolete constructs should be cleanly removed immediately rather than accumulating technical debt and deprecation warnings.
- **Effect Aliases:** Remove historical Effect compatibility aliases (such as `catchAll` in favor of `catch`, `fork` in favor of `forkChild`) to remain 100% synchronized with upstream Effect v4 public exports.
- **Breaking Syntax:** Statically reject outdated syntax with actionable error diagnostics that cite the canonical form.
- **Pipeline Ambiguity:** Disallow heuristic guessing or module precedence; require explicit qualification (e.g. `Array.map`, `Effect.map`) when a bare stage is ambiguous across companion modules.

