# Program 08: Real-World HTTP REST API Server
# Demonstrates schema-validated endpoints, typed effect routing, and pipeline middleware in FunScript.

import { createServer } from "node:http"

# --- Request / Response Payload Schemas ---

export schema CreateItemRequest = {
  title: string
  priority: number
}

export schema ItemResponse = {
  id: string
  title: string
  priority: number
}

export schema ApiError = {
  error: string
  message: string
}

# --- Domain Tagged Errors ---

export error NotFoundError(message: string)
export error ValidationError(message: string)
export error ServerError(message: string)

makeNotFoundError = (message: string) => ts "new NotFoundError({ message })"
makeValidationError = (message: string) => ts "new ValidationError({ message })"
makeServerError = (message: string) => ts "new ServerError({ message })"

# --- In-Memory State Store ---

mut items: Array<ItemResponse> = [
  { id: "item-1", title: "Setup Project", priority: 1 },
  { id: "item-2", title: "Write FunScript REST API", priority: 2 }
]

# --- Native Node.js HTTP Interop Helpers ---

ts "const readRequestBody = (req: any): Promise<string> => new Promise((resolve, reject) => { let body = ''; req.on('data', (chunk: any) => { body += chunk; }); req.on('end', () => resolve(body)); req.on('error', (err: any) => reject(err)); });"
ts "const sendJsonResponse = (res: any, statusCode: number, payload: any): Promise<boolean> => new Promise((resolve) => { const data = JSON.stringify(payload); res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }); res.end(data, () => resolve(true)); });"

# --- Early Return Validation Checks (when) ---

export fn checkAuth(authHeader: string) => Effect<boolean, ValidationError> {
  when (authHeader == "") => Effect.fail(makeValidationError("Missing Authorization header"))
  when (authHeader != "Bearer test-api-key") => Effect.fail(makeValidationError("Invalid authorization token"))
  => Effect.succeed(true)
}

export fn validateTitle(title: string) => Effect<string, ValidationError> {
  when (title == "") => Effect.fail(makeValidationError("Item title cannot be empty"))
  => Effect.succeed(title)
}

# --- Schema Decoding & JSON Parsing ---

export fn parseJsonBody(bodyText: string) => Effect<any, ValidationError> {
  when (bodyText == "") => Effect.fail(makeValidationError("Request body is empty"))
  parsed = ts "(() => { try { return { ok: true, value: JSON.parse(bodyText) }; } catch(e: any) { return { ok: false, message: e.message }; } })()"
  when (parsed.ok == false) => Effect.fail(makeValidationError("Invalid JSON: " + parsed.message))
  => Effect.succeed(parsed.value)
}

export fn validateCreateItem(rawJson: any) => Effect<CreateItemRequest, ValidationError> {
  decoded = Schema.decodeUnknownEither(CreateItemRequest)(rawJson)
  res = match decoded
    | Right(req) => Effect.succeed(req)
    | Left(err) => Effect.fail(makeValidationError("Schema validation failed: " + err.message))
  => res
}

# --- Route Handlers ---

export fn formatApiError(errName: string, msg: string) => ApiError {
  => { error: errName, message: msg }
}

export fn sendErrorResponse(res: any, status: number, errName: string, message: string) => Effect<boolean, any> {
  effect
    payload = formatApiError(errName, message)
    _ <- js ts "sendJsonResponse(res, status, payload)"
    true
}

export fn handleHealth(res: any) => Effect<boolean, any> {
  effect
    payload = { status: "ok", service: "FunScript REST API" }
    _ <- js ts "sendJsonResponse(res, 200, payload)"
    true
}

export fn handleGetItems(res: any) => Effect<boolean, any> {
  effect
    _ <- js ts "sendJsonResponse(res, 200, items)"
    true
}

export fn handleCreateItem(req: any, res: any) => Effect<boolean, any> {
  effect
    authHeader = ts "String(req.headers['authorization'] || '')"
    _ <- checkAuth(authHeader)

    bodyText <- js ts "readRequestBody(req)"
    rawJson <- parseJsonBody(bodyText)
    validReq <- validateCreateItem(rawJson)
    _ <- validateTitle(validReq.title)

    newId = "item-" + (items.length + 1)
    newItem: ItemResponse = {
      id: newId
      title: validReq.title
      priority: validReq.priority
    }
    _ = items.push(newItem)

    _ <- js ts "sendJsonResponse(res, 201, newItem)"
    true
}

export fn handleSimulatedError() => Effect<boolean, ServerError> {
  Effect.fail(makeServerError("Simulated internal database connection failure"))
}

export fn handleNotFound(method: string, url: string) => Effect<boolean, NotFoundError> {
  Effect.fail(makeNotFoundError("Route not found: " + method + " " + url))
}

# --- Pattern-Matched Route Dispatcher ---

export fn routeRequest(method: string, url: string, req: any, res: any) => Effect<boolean, any> {
  match (method, url)
    | ("GET", "/api/health") => handleHealth(res)
    | ("GET", "/api/items") => handleGetItems(res)
    | ("POST", "/api/items") => handleCreateItem(req, res)
    | ("GET", "/api/error") => handleSimulatedError()
    | _ => handleNotFound(method, url)
}

export fn dispatchHttp(req: any, res: any) => Effect<boolean, any> {
  effect
    method = ts "String(req.method || 'GET')"
    url = ts "String(req.url || '/')"
    _ <- Console.log("[HttpServer] " + method + " " + url)

    eff = routeRequest(method, url, req, res)
    handled =
      eff
      |> Effect.catchTag("ValidationError", (err) =>
        sendErrorResponse(res, 400, "ValidationError", err.message)
      )
      |> Effect.catchTag("NotFoundError", (err) =>
        sendErrorResponse(res, 404, "NotFoundError", err.message)
      )
      |> Effect.catchTag("ServerError", (err) =>
        sendErrorResponse(res, 500, "ServerError", err.message)
      )
      |> Effect.catchAll((err: any) =>
        sendErrorResponse(res, 500, "ServerError", String(err))
      )
    _ <- handled
    true
}

# --- Server Lifecycle & Interop ---

mut activeServer: any = 0

export js startServer = (port: number) ->
  effect
    _ <- Console.log("[HttpServer] Starting REST server on port " + port)
    serverInstance <- js ts "new Promise((resolve) => { const s = createServer((req, res) => { Effect.runPromise(dispatchHttp(req, res)); }); s.listen(port, () => resolve(s)); })"
    activeServer = serverInstance
    _ <- Console.log("[HttpServer] Server listening")
    serverInstance

export js stopServer = () ->
  effect
    when (activeServer == 0) => true
    _ <- js ts "new Promise((resolve, reject) => { try { (activeServer as any)?.closeAllConnections?.(); activeServer.close((err?: Error) => err ? reject(err) : resolve(true)); } catch(e) { resolve(true); } })"
    activeServer = 0
    _ <- Console.log("[HttpServer] Server stopped successfully.")
    true

export fn getItemsCount() => number {
  => items.length
}

export js resetItemsStore = () ->
  effect
    _ = items.splice(0, items.length)
    _ = items.push({ id: "item-1", title: "Setup Project", priority: 1 })
    _ = items.push({ id: "item-2", title: "Write FunScript REST API", priority: 2 })
    true

export main = () ->
  effect
    _ <- Console.log("=== FunScript REST API Server Demo ===")
    srv <- js startServer(8080)
    _ <- Console.log("[HttpServer] Server ready on http://localhost:8080")
    0
