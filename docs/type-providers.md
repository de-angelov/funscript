# Experimental type providers

Providers inspect a local source at build time and generate an Effect schema, a
matching TypeScript type, and a `NameFromUnknown` decoder. Paths are relative
to the declaring `.fun` file. Provider packages are also available as
`funscript/providers/csv`, `funscript/providers/json`, and
`funscript/providers/sqlite`; `funscript/providers` exports all three.

```funscript
export schema Customer = from csv<"./customers.csv">

export schema Order = from jsonSchema<"./order.schema.json">

export schema Example = from json<"./example.json">

export schema User = from sqlite<"./app.db", "users">
```

## CSV

The provider reads the header and validates the shape and quoting of all rows.
Headers must be nonempty and unique. Every field is a string; the compiler
never infers numbers or dates from samples. `parseCsv` from `funscript/csv`
parses CSV text to string-valued records that can be passed to the generated
decoder. CSV data is not embedded in the compiled output.

## JSON

`jsonSchema` consumes an explicit JSON Schema. Its supported subset is `type`
(`object`, `array`, `string`, `number`, `integer`, `boolean`, `null`),
`properties`, `required`, `items`, scalar `enum` and `const`, plus descriptive
`title`, `description`, `$schema` and `$id`. It rejects unsupported keywords,
including `$ref`, constraints, and `additionalProperties`, rather than silently
ignoring validation. Object decoders accept extra keys and Effect's struct
schema strips them. `enum` and `const` cannot be combined with other validation
keywords. Optional fields must be absent or contain the declared value.

`json` infers a shape from a sample. All observed object properties are
required; differing array elements produce a union. Empty arrays are rejected
because their element type cannot be inferred. Array samples are limited to
1,000 elements. A sample does not guarantee that later input matches; run the
generated decoder or use `jsonSchema` for an explicit contract.

## SQLite

`sqlite` takes a local database file and a table or view name. It opens the
existing database read-only and reads schema metadata; it does not query or
embed application rows. It uses `better-sqlite3`, a native dependency requiring
a supported prebuilt binary or a working native build toolchain.

For STRICT tables, `INT`, `INTEGER`, and `REAL` map to numbers, `TEXT` to
strings, and `BLOB` to `Uint8Array`. Other columns and all columns in ordinary
non-STRICT tables use a union of number, string, and `Uint8Array`, because
SQLite can store values that do not match a declared type. Nullable columns
also allow `null`. Integer decoding assumes a driver configured to return
JavaScript numbers; large integers may lose precision and drivers configured to
return `bigint` require a different schema. Database schema changes can make a
previously generated type stale: rebuild when the database schema changes.

### Drizzle queries

For a STRICT SQLite table, generate a TypeScript module containing a Drizzle
table definition:

```sh
funscript drizzle-schema ./app.db users > ./src/users-table.ts
```

The database is opened read-only during generation. At runtime, supply your
own connection and use Drizzle's query builder:

```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { table as users } from "./users-table.js";

const sqlite = new Database("./app.db");
const db = drizzle(sqlite);
const rows = db.select().from(users).where(eq(users.name, "Ada")).all();
sqlite.close();
```

TypeScript checks column names, comparisons, and selected row types. You can
export `db` and `table` from a TypeScript module and use them from Funscript:

```funscript
import { db, table } from "./db.js"

export users = db.select().from(table).all()
```

Re-run the command after a database schema change; this generated module is a
snapshot and is not watched automatically. The generator supports read queries
on STRICT tables with integer, real, text, or blob columns. It rejects generated
columns and `ANY`. It does not model keys, defaults, relations, or constraints,
so use Drizzle Kit's schema generation for writes and migrations.

The same generator is available as `generateSqliteDrizzleSchema` from
`funscript/providers/drizzle` and returns TypeScript source as a string.

## Development and limitations

CLI incremental builds fingerprint provider inputs, including SQLite WAL and
rollback journal files. The Vite plugin watches inputs and refreshes dependent
modules and its generated type view. The editor watches inputs for open
documents. Bun compiles current inputs when it loads a FunScript module, but a
change only to a provider input does not automatically trigger a Bun rebuild.

TypeScript 7.1 beta can check the project with `npm run check:ts71`. The
compiler and language server still use the TypeScript 5 API internally; the
beta is installed separately while that integration is migrated. Third-party
provider registration and remote database connections are not implemented.

## External provider contract (version 1)

This section specifies the public boundary for independently authored
providers. Its TypeScript types are exported from `funscript/providers/contract`
and re-exported from `funscript/providers`. The current compiler implementation
above is built-in dispatch for `csv`, `json`,
`jsonSchema`, and `sqlite`; it is not an implementation of this extension
contract. Today `resolveProviderSchemas` returns a map from schema name to an
emitted expression, and `providerDependencies` recognizes local input files
(and SQLite WAL/journal files). External registration, invocation, named runtime
module generation, and arbitrary dependency tracking remain future host work.
The exported contract lets provider authors implement and type-check the
boundary now; it does not imply that the compiler discovers or runs providers.

### F# background and FunScript adaptation

F# type providers can expose types based on static parameters and external
information sources. They may expose large type spaces lazily. F# distinguishes
generative providers, which produce .NET types that can be written into an
assembly, from erased providers, whose types are project-local compile-time
constructs. The F# tutorial also covers static parameters, resolution folders,
provided member code, caching, invalidation, and diagnostics. These are F#
mechanisms and facts, not promises of this contract. See Microsoft's [type
provider overview](https://learn.microsoft.com/dotnet/fsharp/tutorials/type-providers/),
[provider creation tutorial](https://learn.microsoft.com/en-us/dotnet/fsharp/tutorials/type-providers/creating-a-type-provider),
and [provider security guidance](https://learn.microsoft.com/en-us/dotnet/fsharp/tutorials/type-providers/type-provider-security).

FunScript instead resolves declarations to ordinary TypeScript declarations
and, optionally, ordinary TypeScript runtime modules. It makes no claim of CLR
erasure, F# semantic parity, lazy member expansion, or F# resolution-folder
behavior. A FunScript provider is a host-invoked generator of validated data;
it does not provide executable compiler callbacks or quoted member code.

### Request, arguments, identity, and compatibility

A source declaration names a registered provider and supplies only static
literal arguments. Version 1 permits strings, finite numbers, and booleans,
matching the scalar literal forms currently accepted by provider declarations;
lists, objects, expressions, interpolation, environment lookups, and runtime
values are unsupported. The declaration span is retained by the host. A
registration is host configuration, not data supplied by the source file. Its
minimum manifest shape is:

```ts
interface ProviderManifestV1 {
  id: string; // stable package-qualified provider ID
  version: string; // provider package SemVer
  contract: { major: 1; minMinor: number; maxMinor: number };
  parameters: ReadonlyArray<{
    name: string;
    kind: "string" | "number" | "boolean";
    required: boolean;
    path?: boolean; // legal only for string arguments
  }>;
  inputRoots: ReadonlyArray<string>; // canonical, host-authorized file roots
  requestedCapabilities: ReadonlyArray<"external-refresh">;
}
```

The host chooses the highest common minor in the provider's declared range and
its own supported range, then sends exactly that version. No common minor is a
compatibility diagnostic. The manifest declares argument names/order/types and
which string arguments are paths; the call's argument array follows that
order. Relative paths resolve against the declaring `.fun` file, matching the
current built-in behavior; the host canonicalizes path arguments before
invocation and rejects paths outside authorized roots. A provider must reject
missing, extra, or wrongly typed arguments. Path authorization is independent
of trusting the provider executable.

The host sends an immutable request equivalent to:

```ts
interface ProviderRequestV1 {
  contract: { major: 1; minor: number }; // negotiated exact version
  provider: { id: string; version: string };
  declaration: { source: string; name: string; span: ProviderSourceSpanV1 };
  arguments: ReadonlyArray<string | number | boolean>;
  paths: ReadonlyArray<{ argumentIndex: number; canonicalPath: string }>;
}
```

`SourceSpan` is a half-open range of UTF-16 offsets in the declaring source,
with start/end line and column available for display. Provider identity is a
stable reverse-DNS-style package ID plus provider ID; version is SemVer. The
cache key includes contract major, provider ID and version, canonical
arguments, host/compiler ABI version, and fingerprints for every declared
dependency. Providers must be deterministic for an identical request and
identical dependency contents. Cache reuse across machines or host/compiler
ABIs is not promised.

Contract 1.0 is data-only for runtime exports. Contract 1.1 adds typed callable
exports while retaining 1.0 data-only results. A host must negotiate minor 1
before accepting callable signatures; the same shape is invalid in a 1.0
response. Minor versions are additive only when older readers can safely ignore
the additions. An incompatible request, result, schema vocabulary, or
runtime-module change requires a new contract major; a host rejects an unknown
major and never coerces results. Provider package versions
are independent and participate in the key. A missing provider, unsupported
contract, invalid arguments, or invalid result is a source-located diagnostic.

### Result and generated artifacts

A provider returns one serializable result and no executable source:

```ts
interface ProviderResultV1 {
  contract: { major: 1; minor: number };
  schema: SchemaNodeV1;
  runtimeModule?: {
    specifier: string;
    exports: ReadonlyArray<
      | { name: string; type: SchemaNodeV1 }
      | {
          name: string;
          parameters: ReadonlyArray<{ name: string; type: SchemaNodeV1 }>;
          result: SchemaNodeV1;
        }
    >;
  };
  dependencies: ReadonlyArray<DependencyV1>;
  diagnostics: ReadonlyArray<ProviderDiagnosticV1>;
}
```

The compact discriminated shapes represented above are:

```ts
type SchemaNodeV1 =
  | { kind: "string" | "number" | "boolean" | "null" | "bytes" }
  | { kind: "array"; items: SchemaNodeV1 }
  | {
      kind: "object";
      properties: ReadonlyArray<{
        name: string;
        schema: SchemaNodeV1;
        description?: string;
      }>;
      required: ReadonlyArray<string>;
      additionalProperties: "allow" | "reject";
    }
  | { kind: "union"; alternatives: ReadonlyArray<SchemaNodeV1> };

type DependencyV1 =
  | { kind: "file"; path: string }
  | { kind: "external"; key: string; fingerprint: string };

interface ProviderDiagnosticV1 {
  code: string;
  severity: "error" | "warning";
  message: string;
  inputLocation?: { dependencyKey: string; start: number; end: number };
}
```

The provider's `provide` implementation consumes one request and returns one
result; it does not retain host objects between calls. The typed package API is
not a currently callable extension host. The host sends only
fields defined by the negotiated minor version. A minor release may add
optional fields or enum values only where older readers can safely ignore
them; otherwise it requires a major increment. The result must echo the exact
negotiated contract version. A mismatch is rejected.

The schema vocabulary is closed: `string`, `number`, `boolean`, `null`, and
`bytes`; `array` with one item schema; `object` with ordered named properties,
required property names, and an explicit additional-properties policy; and
`union` with at least two alternatives. Each property has a schema and may have
description metadata. Unknown node kinds, duplicate property/export names,
invalid required names, recursive references, and unsupported metadata are
rejected. Version 1 has no references or recursive schemas. The host maps this
schema tree to FunScript types and an Effect `Schema` decoder, so providers do
not import compiler internals or construct compiler AST nodes. Descriptions
do not affect type identity.

In contract 1.1, a callable export describes a function signature using named
parameters and a structured result schema. Export names and parameter names
must be valid identifiers and unique within their respective lists. Unknown
signature fields and malformed schemas are rejected. The provider supplies no
TypeScript text or executable snippets. The host treats callable values as
type declarations only; runtime implementations remain in the named package
module and are imported by generated consumer code. Provider execution during
build time remains a separate trusted operation and never imports a runtime
module to execute provider logic.

`runtimeModule.specifier` is a package/module specifier resolvable from the
consumer project, not an output path chosen by the provider. The host emits a
named TypeScript module declaration that imports those named exports and gives
each its declared type; it never evaluates provider-supplied module source.
Export names must be valid TypeScript identifiers, and declarations must not
collide with generated schema bindings. Providers document the runtime package
dependency and resource ownership of each API. Runtime resources belong to the
caller unless an API returns an explicit close handle or scoped resource.
Design-time discovery must close every file, database, socket, and child process
it opens before returning. A provider result can omit `runtimeModule` when it
only contributes a schema.

### Dependencies, invalidation, and lifecycle

The provider runs with a host-owned read-only context and can access only the
request's path arguments and dependencies declared in its manifest. Result
dependencies enumerate the complete inputs used for this result. Version 1
dependency kinds are:

- `file`: canonical local path; the host fingerprints file contents and
  watches it where the consumer supports file watching;
- `external`: stable source key plus a host-supplied refresh version or
  fingerprint. Refresh is performed only by an explicitly authorized host
  adapter; network access is not implicit.

For a `file` dependency, `path` must be an absolute canonical path within the
provider's declared input roots or the canonical path of a declared path
argument. The host supplies the current fingerprint in its invocation context
and verifies it has not changed before publishing the result. For an
`external` dependency, `fingerprint` is an opaque value from the authorized
adapter; the provider cannot fetch or choose it. Requesting
`external-refresh` does not grant that capability: the host must separately
authorize the provider and configure an adapter. Input
locations use UTF-16 offsets in the dependency's decoded text and are accepted
only for a declared text file dependency.

The host owns snapshots and generated output files. Providers own only their
implementation and must not write into the project, generated TypeView, or
host cache. The host discards temporary output on every failed or cancelled
invocation and publishes a result atomically only after validating all fields
and confirming input fingerprints are unchanged.

An undeclared read or dependency is a provider contract violation. SQLite WAL
and rollback-journal tracking in the current compiler is an example of local
file invalidation; it is not a separate protocol. The host combines dependency
fingerprints with the identity key, caches only validated snapshots, and
invalidates affected results when a fingerprint changes. Providers must not
assume the editor polls or refreshes an external source merely because a file
was opened.

Lifecycle: resolve the registered provider; check trust and contract
compatibility; validate literal arguments; collect declared inputs; invoke
within a bounded time/resource budget; validate the result and dependencies;
cache the complete snapshot; publish declarations, runtime module references,
dependency edges, and diagnostics. Cancellation, timeout, process failure, or
malformed output discards the whole result; no partial types are published.
Provider discovery releases its resources before the invocation ends.

Version 1 rejects non-literal arguments, recursive schemas, unknown schema
nodes, undeclared reads, arbitrary generated source, and provider callbacks
into compiler internals. Remote fetching, network access, database operations,
and lazy type/member expansion are not part of the contract. The host reports
unsupported behavior as a source-located diagnostic and publishes no partial
result. Generated TypeScript declarations and optional package modules are the
supported output model; consumers do not maintain TypeScript bridges.

### Trust and diagnostics

F# documentation notes that provider assemblies can execute while code is
merely browsed in an editor, and describes trust decisions before loading them.
FunScript adopts that security lesson with a distinct policy: a provider must
be explicitly registered and trusted by the host before generation code runs.
The exported `ProviderTrustV1` type represents this host-owned decision; a
provider cannot grant trust to itself. Trust does not promise an operating
system sandbox or permit arbitrary untrusted code execution.
Build, language server, and editor features do not execute an unregistered or
untrusted provider. The editor can still parse the declaration and report an
unresolved-provider diagnostic. Trust is scoped to package identity, provider
ID, and version; a changed version requires a new trust decision. Runtime
modules are ordinary application dependencies and execute only when the
application calls them. They are separate from design-time provider code.

A provider diagnostic has a stable code, severity, safe message, and optional
location in a declared input. The host attaches provider ID and the original
declaration span; input locations become related information. Providers cannot
choose arbitrary source locations or target unrelated files. Exceptions and
process output are converted to sanitized diagnostics. Messages and logs must
not contain credentials, environment values, or full input contents. A
provider failure must not crash the editor or leave stale successful output
visible as current.

### Build and editor responsibilities; unsupported behavior

The proposed build host resolves and authorizes providers, validates schemas and module
references, emits ordinary declarations, tracks dependency fingerprints, and
fails the build on an error diagnostic. The editor consumes a validated cached
snapshot when available, watches declared local files, refreshes dependent
TypeViews, and maps diagnostics to the declaration. Today `TypeView` discovers
provider input files with `providerDependencies`, hashes their contents, and
refreshes a source when a watched dependency changes; on refresh failure it
removes stale successful output. Vite registers these dependencies for watching
and invalidates dependent modules. The future host extends that file-based seam
with provider identity, typed runtime module declarations, and externally
refreshed dependency fingerprints. This future behavior does not imply that
source opening alone executes untrusted code or refreshes remote sources.

Version 1 does not support arbitrary code generation, provider-defined compiler
plugins, runtime-dependent schemas, dynamic arguments, recursive or lazy type
spaces, direct network access, credentials in source, automatic database
operations, CLR/.NET type emission or erasure, or arbitrary host filesystem
access. Runtime behavior must be exposed through named exports in a normal
runtime module; compile-time types must be described by the structural schema
result. These constraints define a portable contract rather than F# parity.
