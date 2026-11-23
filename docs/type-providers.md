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
