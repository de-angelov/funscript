# Survey: converting imported TypeScript types to Effect schemas

## Purpose and boundary

This is a decision brief for a possible feature that derives an Effect `Schema`
from an imported TypeScript type. It does not propose that a static type proves
an external value valid. Any derived schema would be a runtime decoder with
specific decoding and encoding behavior; callers would still need to run it on
untrusted values.

## Verified starting point

- The language already has runtime `schema` declarations for record shapes,
  tagged unions, primitive/type signatures, and refinements. The parser's
  `parseSchemaDeclaration` dispatches to record, tagged-union, or type-signature
  parsing; record fields currently accept a name, colon, type, and optional
  default (`src/parser/parser.ts`, `parseSchemaBody` and `parseRecordSchema`).
- Annotation record types are parsed separately. The current record-type parser
  records required named fields and their types; it has no explicit handling for
  `?` optional property markers or `readonly` modifiers. Type syntax otherwise
  permits uppercase type names, generic arguments, function types, and a `ts`
  escape hatch (`parsePrimaryType`).
- `docs/syntax.md` says `Unknown` is the boundary type and describes
  `Schema.decodeUnknown`, while complex `ts` aliases do not acquire runtime
  validators merely from their static type. Existing schema declarations lower
  to both an Effect schema value and a static type.
- `package.json` declares `effect: ^4.1.1` and `typescript: ^5.6.3`;
  `package-lock.json` and this install resolve Effect 4.1.1 and TypeScript
  5.9.3. In Effect 4.1.1 `src/Schema.ts`, the declarations expose
  `Unknown`, `Null`, `Undefined`, `String`, `Number`, `Boolean`, `Struct`,
  `Record`, `Union`, and `suspend`; `optional` is a field combinator. These
  names are verified for this locked version, not for every version admitted
  by the package's caret range.
- TypeScript 5.9.3's public `TypeChecker` declarations expose
  `getSymbolAtLocation`, `getAliasedSymbol`, `getTypeAtLocation`,
  `isArrayType`, `isTupleType`, and type-level `getProperties` / `isUnion`.
  These provide a checker-based investigation path; they do not themselves
  define a stable serialization or conversion contract.

## Candidate declaration surfaces

### A. Explicit import-time schema binding

```funscript
import type { User as UserType } from "./model"
schema User = from TypeScript<UserType>
```

This makes the static source and runtime schema visibly distinct and puts
conversion in a schema declaration. It requires grammar and name-resolution
work, and `TypeScript<T>` is illustrative syntax rather than supported syntax.

### B. Derive at the import site

```funscript
import { schemaOf } from "funscript/typescript"
import type { User } from "./model"
UserSchema = schemaOf<User>()
```

This resembles a library API and keeps the DSL parser small, but a type-only
import has no runtime value. The compiler would need to recognize and transform
the call using the TypeScript checker; ordinary TypeScript cannot reflect the
erased type at runtime.

### C. Explicit field mapping

```funscript
schema User = {
  id: UUID
  name: NonEmptyString
  tags: Array<String>
}
```

This uses existing declaration syntax and supports domain refinements, but
duplicates imported shape information. It is the current fallback and a useful
escape when automatic conversion is ambiguous or unsupported.

## Candidate mapping and decision points

| TypeScript shape | Possible schema mapping | Open behavior / tradeoff |
| --- | --- | --- |
| `string`, `number`, `boolean` | `Schema.String`, `Schema.Number`, `Schema.Boolean` | These accept broad primitive domains; they do not infer branded or refined domain constraints. |
| `T[]` / `Array<T>` | `Schema.Array(convert(T))` is a candidate | Effect's `Schema.Array` declaration should be checked in the package API; generated static type and mutability policy need to agree. `ReadonlyArray<T>` has the same runtime array shape but a readonly static view. |
| `{ a: string; b: number }` | struct schema with required fields | Decide whether unknown keys are preserved, stripped, or rejected. TypeScript's structural assignability alone does not choose a runtime policy. |
| `{ a?: string }` | `Schema.optional(convert(string))` is a candidate field declaration | Effect 4.1.1 exports the `optional` struct-field combinator. Decide whether it means property absence, present-with-`undefined`, or both for decode and encode. The FunScript parser has no `?` field marker in either record schemas or record annotation types. |
| `T \| null`, `T \| undefined` | `Schema.Union([convert(T), Schema.Null])` or the corresponding `Schema.Undefined` union | Effect 4.1.1 declares both `Null` and `Undefined` and helpers `NullOr`, `UndefinedOr`, and `NullishOr`. These represent values, not an absent struct key. Do not silently collapse either to `Option<T>`. |
| `A \| B` | `Schema.Union([convert(A), convert(B)])` is a candidate | Effect 4.1.1 exports `Union`; overlapping structural members need an explicit decode/error policy. Discriminated unions may map more predictably when a literal tag exists. |
| recursive interface/type alias | `Schema.suspend(() => schemaRef)` is a candidate | Effect 4.1.1 exports `suspend`. The converter still needs cycle detection and a defined cache entry before descending; recursive static aliases may include unsupported constructs. |
| `readonly` fields / `ReadonlyArray<T>` | same validation shape, readonly static output | `readonly` is a static mutation constraint, not necessarily a runtime freeze. Decide whether it affects generated type only. |
| index signature / extra keys | record/key schema or open struct | Generic keys and arbitrary values may require explicit `unknown` schema and a policy for undeclared keys. |
| `unknown` | `Schema.Unknown` | It validates nothing. This is a passthrough escape, not proof of a domain shape. |
| `any`, functions, conditional/mapped types, generics | reject, or explicit schema | Guessing semantics is unsafe; checker-resolved instantiations may help but could make conversion context-dependent. |

The Effect constructor names above are verified in the locked 4.1.1 source;
the mappings from TypeScript types to those constructors remain proposals, not
implemented or behavior-tested conversion. `Struct` and `Record` exist, but
unknown-key behavior must be selected and verified rather than inferred from
TypeScript structural assignability. Literal types, enums, tuples,
intersections, template-literal types, branded types, and declaration merging
also need an explicit support/rejection policy before a complete scope can be
defined.

## Compiler and runtime questions

1. **Symbol resolution.** Use the TypeScript checker on the source program to
   resolve the imported alias to a symbol and its type at the import site.
   Decide whether aliases are followed across package declarations, how
   re-exports and declaration merging work, and how to report missing or
   ambiguous symbols. Textual parsing of `.d.ts` files is unlikely to preserve
   TypeScript's actual type semantics.
2. **Runtime versus encoded types.** Effect schemas may distinguish the type
   accepted on decode from the type produced at runtime and the encoded type
   emitted on encode. A conversion contract must specify which side is meant by
   imported `T`; a static `T` alone cannot communicate coercions or transforms.
3. **Diagnostics.** Unsupported types should produce a source-located diagnostic
   naming the imported symbol and unsupported member/path, with an explicit
   suggestion to write a native schema or use an opaque `ts` type. Avoid
   silently widening to `unknown`.
4. **Caching.** Repeated conversions could memoize by checker type identity
   within a compilation. Cross-build or persistent caching needs invalidation
   for compiler options, declaration files, package versions, and referenced
   source changes. Recursive references require an in-progress cache entry or
   equivalent cycle handling.
5. **Effect version constraints.** The lockfile resolves Effect 4.1.1 and
   TypeScript 5.9.3. The declarations in Effect 4.1.1 provide the constructor
   names cited above, but the manifest range `^4.1.1` can admit later compatible
   releases. Optional-field semantics, suspend behavior, unknown-key behavior,
   and encoded/runtime type behavior need focused verification against the
   supported Effect range before implementation. Pinning or testing the range
   is an implementation decision.
6. **Upstream schema preference.** When a library already exports a runtime
   Effect schema alongside its type, import and reuse that schema. It preserves
   author intent for refinements, transforms, defaults, brands, and edge-case
   semantics that cannot be reconstructed from a TypeScript type. Derivation is
   most useful for plain structural declarations without such runtime metadata.

## Human decision (TASK-095)

**Adopted: Declaration Modifier Syntax (`ts schema User = UserType`).**

### 1. Approved and Rejected Syntax

- **Approved Syntax (Declaration Modifier `ts schema`):**
  Uses `ts` as a declaration modifier directly in front of `schema`, aligning with FunScript's existing `js` declaration modifier (`export js greet = ...`):
  ```funscript
  import type { User as UserType } from "./model"

  ts schema User = UserType
  export ts schema User = UserType
  ```
  - **LHS:** The runtime Effect `Schema` binding to produce in FunScript (`User`).
  - **RHS:** The source TypeScript type symbol (`UserType`).
  - **Zero Syntax Clutter:** No generic wrappers (`< >`), no prepositions (`from`), and no unnecessary braces (`{ }`).
- **Rejected Syntax:**
  - **`schema User = from ts<UserType>`:** Rejected as overly verbose and un-aesthetic with generic syntax noise.
  - **Option B (Import-site derivation `schemaOf<T>()`):** Rejected. Type-only imports have no runtime presence in TypeScript; converting them at call sites requires synthetic compiler reflection and checker-driven expression rewrites rather than declarative schema bindings.
  - **Illustrative `TypeScript<T>` wrapper:** Rejected in favor of FunScript's existing `ts` keyword.
  - **Implicit derivation:** Rejected. Conversion must be opt-in and explicitly stated via `ts schema Name = Type`.

### 2. Supported and Rejected Examples

- **Supported Types (Initial Subset):**
  - **Primitives:**
    - `string` -> `Schema.String`
    - `number` -> `Schema.Number`
    - `boolean` -> `Schema.Boolean`
  - **Arrays:**
    - `T[]` or `Array<T>` -> `Schema.Array(convert(T))`
  - **Structs:**
    - `{ a: string; b: number }` -> `Schema.Struct({ a: Schema.String, b: Schema.Number })`
  - **Optionals and Nullables:**
    - Optional struct fields: `{ a?: string }` -> field combinator `Schema.optional(Schema.String)`
    - Nullable values: `T | null` -> `Schema.NullOr(convert(T))`
- **Rejected Types (Compile Errors):**
  - **Functions:** `() => void`, `(x: string) => number` are rejected with compile-time diagnostics.
  - **Classes / Instances:** `class User { ... }`, `Date`, and prototype instances are rejected.
  - **`any`:** Statically rejected with an actionable diagnostic. No silent widening to `Schema.Unknown` or permissive passthrough.
  - **Complex and Advanced Types:** Conditional types (`T extends U ? X : Y`), mapped types with dynamic keys, and template literal types are rejected at compile time.

### 3. Runtime and Encoded Semantics

- **Dual-Type Mapping:** The derived schema produces an Effect `Schema.Schema<A, I>` where:
  - Runtime type (`A` / `Schema.Schema.Type`): Matches the imported TypeScript static type `T`.
  - Encoded type (`I` / `Schema.Schema.Encoded`): Matches the runtime structural representation for plain data (primitives, arrays, structs, and nullable values).
- **Decoder Behavior:** Serves strictly as a structural validation boundary for untrusted inputs. It verifies primitive shapes, array element shapes, and struct field shapes.
- **No Inferred Domain Refinements:** Static TypeScript types cannot communicate semantic domain constraints (such as integer ranges, non-empty strings, or branded invariants); no such validations are inferred.

### 4. Remaining Limitations and Unresolved Points

- **Unknown Keys Policy:** Whether unexpected keys in decoded structs are preserved, stripped, or rejected remains an unresolved configuration decision to be aligned with Effect 4.x defaults.
- **Recursive Types:** Support for recursive types via `Schema.suspend` is deferred and unresolved for the initial subset.
- **General Unions:** General unions (`A | B`) beyond simple `T | null` require discriminator disambiguation and remain unresolved.
- **Symbol Resolution Across Packages:** Type resolution relies strictly on the TypeScript compiler `TypeChecker` on source files; ambient untyped modules or missing `.d.ts` declarations cannot be synthesized.
- **Upstream Schema Preference:** Upstream runtime Effect schemas remain preferred whenever available from library authors; type derivation is only intended for un-schematized third-party TypeScript interfaces.
- **Implementation Status:** TASK-095 records the human architectural decision only; parser grammar (`from ts<...>`) and compiler code generation will be implemented in subsequent tasks.

## Recursive imported schemas investigation (TASK-171)

The existing fixture `RecursiveTree` (`tests/fixtures/imported-schemas/model.ts`)
is a concrete plain-data use case: each node has an `id` and recursively nested
`children`. This shape appears in nested navigation trees, syntax trees, and
category hierarchies, so supporting it would make imported-schema derivation
useful for real data rather than only flat records. It is currently rejected
with a source-located `Recursive type 'RecursiveTree' ... is not supported`
diagnostic by the converter's type-identity cycle guard in
`src/compiler/imported-schemas.ts`.

Effect 4.1.1 exposes `Schema.suspend`, which provides the necessary lazy
reference, but merely wrapping the repeated child is insufficient: recursive
conversion needs a per-derivation identity table with an in-progress binding
before descending, and a generated schema expression that refers to that
binding. Otherwise the converter either recurses forever or duplicates a
recursive expression without a stable reference. Generated declarations must
also preserve the current schema binding and type inference behavior. The
tradeoff is additional state and code-generation complexity; unsupported
recursive constructs (for example cycles through a function or an unsupported
class) must continue to fail with the existing actionable diagnostic.

Recommendation: a focused follow-up is justified for recursive object records
and arrays, using `Schema.suspend` plus a per-schema cache keyed by TypeScript
type identity. Keep the current explicit rejection until that follow-up lands.
Its acceptance cases should include: (1) derive `RecursiveTree` and assert the
generated child reference is lazy; (2) decode a finite nested tree successfully;
(3) reject an invalid leaf field at a nested depth; and (4) verify generation
terminates for the recursive input and still rejects recursion that passes
through unsupported members. These exercise both compiler termination and
runtime traversal; no claim should be made that infinitely cyclic JavaScript
object values are valid serialized data.

