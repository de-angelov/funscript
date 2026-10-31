# BACKUP: Dogfooding Tasks (On Hold)

These tasks are placed on hold while the compiler and CLI are upgraded with strict type checking and runtime validation at edges.
Branches and work-in-progress remain preserved in `workspaces/repo-agent-1` and `workspaces/repo-agent-3`.

---

### SQLite Database & Repository Layer Application

Task ID: TASK-029
Category: AFK
Owner: Dev Agent 1
Branch: agent/1/task-029-sqlite-repository
Status: On Hold
Dependencies: none
Blocking tasks: none

Objective: Build a persistent repository layer application (`programs/09-sqlite-repository.fun`) using a lightweight embedded SQLite library (e.g. `sql.js`) or native `node:sqlite` via `js` interop.

Scope:
- In `programs/09-sqlite-repository.fun`:
  - Connect to an in-memory SQLite database (`:memory:`) via `js`.
  - Initialize tables for a domain entity (e.g., `Users` or `Events`).
  - Provide CRUD repository functions returning `Effect<Result, DatabaseError>`:
    - `createUser(name, email)`
    - `findUserById(id)`
    - `listUsers()`
  - Decode raw query rows into domain schemas with `Schema.struct`.
  - Use pipeline composition `|>` to transform query results.
  - Wrap synchronous database calls in `Effect.try` and transactions in Effect scoped resources.
- Add integration test in `tests/examples-sqlite.test.ts` executing repository operations.

Out of Scope:
- External ORMs (keep lean and functional).

Acceptance Criteria:
- Program compiles and type-checks cleanly.
- `tests/examples-sqlite.test.ts` passes with `npm test`.

Verification:
npm test

---

### Real-World HTTP Microservice & REST Server Application

Task ID: TASK-028
Category: AFK
Owner: Dev Agent 3
Branch: agent/3/task-028-rest-api-server
Status: On Hold
Dependencies: none
Blocking tasks: none

Objective: Build a fully functional HTTP microservice in FunScript (`programs/08-rest-api-server.fun`) showcasing schema-validated endpoints, typed effect routing, and pipeline middleware.

Scope:
- In `programs/08-rest-api-server.fun`:
  - Implement an HTTP REST API server using Node's native `node:http` via `js` interop (e.g. `<- js`, `export js`).
  - Define request/response payload schemas: `CreateItemRequest = { title: string, priority: number }`, `ItemResponse`, `ApiError`.
  - Validate incoming request JSON using `Schema.decodeUnknownEither`.
  - Use pattern matching on routes: `match (req.method, req.url)`.
  - Handle errors using Effect tagged errors: `NotFoundError`, `ValidationError`, `ServerError`.
  - Use `when` early returns for authentication/validation checks: `when (authHeader.isEmpty) => Error(...)`.
- Add integration test in `tests/examples-rest-server.test.ts` spinning up the server and exercising GET/POST endpoints with `fetch`.

Out of Scope:
- Installing heavy third-party web frameworks (use native `node:http` and Effect).

Acceptance Criteria:
- Server compiles cleanly with `funscript build` and type-checks with `funscript check`.
- `tests/examples-rest-server.test.ts` tests routes, validation errors, and success flows.
- `npm test` passes.

Verification:
npm test
