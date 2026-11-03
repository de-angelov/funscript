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

## Decision requested

Choose whether derivation belongs in the language at all, and if so, whether the
surface is a declaration (`schema X = from ...`) or a checker-aware import API.
Then define a deliberately narrow first supported subset and its policies for
optional/undefined fields, extra keys, unions, readonly, and recursion. Keep
explicit native schemas and upstream runtime schemas as the predictable
fallbacks. No choice is made by this survey.
