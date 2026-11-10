// Effect SQL repository backed by Node's built-in SQLite driver.
// @effect/sql-sqlite-node requires Node.js 22.16+ (the runtime requirement
// comes from its node:sqlite backup import, even when backup is not used).
// The TypeScript bridge is limited to Effect SQL's generic tagged-template API,
// driver layer, and schema decoder; repository operations remain Effects.

import { Effect } from "effect"

ts {
import * as Schema from "effect/Schema";
  import * as SqlClient from "effect/sql/SqlClient";
  import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";

  const UserRow = Schema.Struct({
    id: Schema.Number,
    name: Schema.String,
    email: Schema.String
  });
  type UserRow = typeof UserRow.Type;

  const decodeUser = (row: unknown) => Schema.decodeUnknownEffect(UserRow)(row);

  export const repositoryProgram = Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL
    )`;

    const createUser = (name: string, email: string) => Effect.gen(function*() {
      const inserted = yield* sql<{ id: number }>`INSERT INTO users (name, email) VALUES (${name}, ${email}) RETURNING id`;
      const rows = yield* sql<UserRow>`SELECT id, name, email FROM users WHERE id = ${inserted[0].id}`;
      return yield* decodeUser(rows[0]);
    });
    const getUser = (id: number) => Effect.gen(function*() {
      const rows = yield* sql<UserRow>`SELECT id, name, email FROM users WHERE id = ${id}`;
      return yield* decodeUser(rows[0]);
    });
    const updateUser = (id: number, name: string, email: string) => Effect.gen(function*() {
      yield* sql`UPDATE users SET name = ${name}, email = ${email} WHERE id = ${id}`;
      return yield* getUser(id);
    });
    const deleteUser = (id: number) => Effect.gen(function*() {
      const result = yield* sql<{ id: number }>`DELETE FROM users WHERE id = ${id} RETURNING id`;
      return result.length > 0;
    });

    const created = yield* createUser("Ada", "ada@example.com");
    const read = yield* getUser(created.id);
    const updated = yield* updateUser(read.id, "Ada Lovelace", "ada@example.com");
    const failed = yield* Effect.result(sql`INSERT INTO users (id, name, email) VALUES (${created.id}, ${"Duplicate"}, ${"duplicate@example.com"})`);
    const missingRead = yield* Effect.result(getUser(999));
    const deleted = yield* deleteUser(updated.id);
    return {
      created,
      read,
      updated,
      deleted,
      duplicateRejected: failed._tag === "Failure",
      missingUserRejected: missingRead._tag === "Failure"
    };
  });

  const sqliteLayer = SqliteClient.layer({ filename: ":memory:" });
  export const runRepository = Effect.runPromise(repositoryProgram.pipe(
    Effect.provide(sqliteLayer)
  ));
  const failureProgram = Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE failure_probe (id INTEGER PRIMARY KEY)`;
    yield* sql`INSERT INTO failure_probe (id) VALUES (${1})`;
    yield* sql`INSERT INTO failure_probe (id) VALUES (${1})`;
  }).pipe(Effect.provide(sqliteLayer));
  export const runFailureAndClose = Effect.runPromise(failureProgram).then(
    () => false,
    () => true
  );
}

export main =
  effect {
    result <- js runRepository
    failureClosed <- js runFailureAndClose
    _ <- Effect.sync(() => console.log(JSON.stringify({ ...result, failureClosed })))
    => true
  }
