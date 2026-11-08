// A persistent repository API backed by native Node SQLite.

import { Effect } from "effect"
import { createRequire } from "node:module"

ts {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL)");
  const dbTry = <A>(work: () => A) => Effect.try({
    try: work,
    catch: (cause: unknown) => new DatabaseError({ message: String(cause) })
  });
  export const createUser = (name: string, email: string) => dbTry(() => {
    const result = database.prepare("INSERT INTO users (name, email) VALUES (?, ?)").run(name, email);
    return UserFromUnknown(database.prepare("SELECT id, name, email FROM users WHERE id = ?").get(result.lastInsertRowid));
  });
  export const getUser = (id: number) => dbTry(() =>
    UserFromUnknown(database.prepare("SELECT id, name, email FROM users WHERE id = ?").get(id))
  );
  export const updateUser = (id: number, name: string, email: string) => dbTry(() => {
    database.prepare("UPDATE users SET name = ?, email = ? WHERE id = ?").run(name, email, id);
    return UserFromUnknown(database.prepare("SELECT id, name, email FROM users WHERE id = ?").get(id));
  });
  export const deleteUser = (id: number) => dbTry(() =>
    database.prepare("DELETE FROM users WHERE id = ?").run(id).changes > 0
  );
  export const closeDatabase = () => database.close();
}

export schema User = {
  id: Number
  name: String
  email: String
}

export error DatabaseError(message: String)

export main = effect {
    created <- createUser("Ada", "ada@example.com")
    updated <- updateUser(created.id, "Ada Lovelace", "ada@example.com")
    deleted <- deleteUser(updated.id)
    _ <- Effect.sync(closeDatabase)
    _ <- Effect.sync(() => console.log(JSON.stringify({ created, updated, deleted })))
    => true
}
