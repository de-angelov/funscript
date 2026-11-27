// Effect SQL with FunScript tagged templates -- no raw TypeScript bridge needed.
// `sql` is a tagged template: interpolations become safe SQL parameters.
// Rows come back as `ReadonlyArray<unknown>`; decode them with an Effect Schema.
// This example uses SQLite in memory; swap SqliteClient for @effect/sql-pg's
// PgClient.layerConfig to talk to PostgreSQL.
import { Console, Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { NodeRuntime } from "@effect/platform-node"

export error DbFailure(message: String)

schema Row = {
  id: Int
  name: String
}

toDbFailure = (cause: Unknown) => DbFailure({ message: "Database query failed." })

getUser = (name: String) =>
  effect {
    sql <- SqlClient.SqlClient
    create = sql`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      )
    `
    insert = sql`INSERT INTO users (name) VALUES (${name})`
    select = sql`SELECT id, name FROM users WHERE name = ${name} LIMIT 1`
    _ <- create |> Effect.mapError(toDbFailure)
    _ <- insert |> Effect.mapError(toDbFailure)
    rows <- select |> Effect.mapError(toDbFailure)
    row <- Option.match(rows[0], {
      onNone: () => Effect.fail(DbFailure({ message: "No user found." }))
      onSome: (raw) => Schema.decodeUnknownEffect(Row)(raw) |> mapError(toDbFailure)
    })
    => row
  }

export main =
  effect {
    row <- getUser("Ada")
    _ <- Console.log("id: {row.id}, name: {row.name}")
    => row.id
  }
  |> provide(SqliteClient.layer({ filename: ":memory:" }))
  |> NodeRuntime.runMain
