import { Console, Effect, Schema, pipe } from "effect";
import { match, P } from "ts-pattern";

import { createServer } from "node:http";

export const CreateItemRequest = Schema.Struct({
  title: Schema.String,
  priority: Schema.Number
});
export type CreateItemRequest = typeof CreateItemRequest.Type;

export const ItemResponse = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  priority: Schema.Number
});
export type ItemResponse = typeof ItemResponse.Type;

export const ApiError = Schema.Struct({
  error: Schema.String,
  message: Schema.String
});
export type ApiError = typeof ApiError.Type;

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  message: Schema.String
}) {}

export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  message: Schema.String
}) {}

export class ServerError extends Schema.TaggedError<ServerError>()("ServerError", {
  message: Schema.String
}) {}

const makeNotFoundError = (message: string) => new NotFoundError({ message });

const makeValidationError = (message: string) => new ValidationError({ message });

const makeServerError = (message: string) => new ServerError({ message });

let items: Array<ItemResponse> = [{ id: "item-1", title: "Setup Project", priority: 1 }, { id: "item-2", title: "Write FunScript REST API", priority: 2 }];

const readRequestBody = (req: any): Promise<string> => new Promise((resolve, reject) => { let body = ''; req.on('data', (chunk: any) => { body += chunk; }); req.on('end', () => resolve(body)); req.on('error', (err: any) => reject(err)); });


const sendJsonResponse = (res: any, statusCode: number, payload: any): Promise<boolean> => new Promise((resolve) => { const data = JSON.stringify(payload); res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }); res.end(data, () => resolve(true)); });


export const checkAuth = (authHeader: string): Effect.Effect<boolean, ValidationError, never> => {
  if ((authHeader === "")) return Effect.fail(makeValidationError("Missing Authorization header"));
  if ((authHeader !== "Bearer test-api-key")) return Effect.fail(makeValidationError("Invalid authorization token"));
  return (Effect.succeed(true));
};

export const validateTitle = (title: string): Effect.Effect<string, ValidationError, never> => {
  if ((title === "")) return Effect.fail(makeValidationError("Item title cannot be empty"));
  return (Effect.succeed(title));
};

export const parseJsonBody = (bodyText: string): Effect.Effect<any, ValidationError, never> => {
  if ((bodyText === "")) return Effect.fail(makeValidationError("Request body is empty"));
  const parsed = (() => { try { return { ok: true, value: JSON.parse(bodyText) }; } catch(e: any) { return { ok: false, message: e.message }; } })();
  if ((parsed.ok === false)) return Effect.fail(makeValidationError(("Invalid JSON: " + parsed.message)));
  return (Effect.succeed(parsed.value));
};

export const validateCreateItem = (rawJson: any): Effect.Effect<CreateItemRequest, ValidationError, never> => {
  const decoded = Schema.decodeUnknownEither(CreateItemRequest)(rawJson);
  const res = match(decoded)
  .with({ _tag: "Right" }, ($matched) => {
    const { _tag: _, ...__fields } = $matched as any;
    const [req] = Object.values(__fields) as any[];
    return Effect.succeed(req);
  })
  .with({ _tag: "Left" }, ($matched) => {
    const { _tag: _, ...__fields } = $matched as any;
    const [err] = Object.values(__fields) as any[];
    return Effect.fail(makeValidationError(("Schema validation failed: " + err.message)));
  })
  .exhaustive();
  return (res);
};

export const formatApiError = (errName: string, msg: string): ApiError => {
  return ({ error: errName, message: msg });
};

export const sendErrorResponse = (res: any, status: number, errName: string, message: string): Effect.Effect<boolean, any, never> => {
  return Effect.gen(function* () {
    const payload = formatApiError(errName, message);
    yield* Effect.tryPromise(() => sendJsonResponse(res, status, payload));
    return true;
  });
};

export const handleHealth = (res: any): Effect.Effect<boolean, any, never> => {
  return Effect.gen(function* () {
    const payload = { status: "ok", service: "FunScript REST API" };
    yield* Effect.tryPromise(() => sendJsonResponse(res, 200, payload));
    return true;
  });
};

export const handleGetItems = (res: any): Effect.Effect<boolean, any, never> => {
  return Effect.gen(function* () {
    yield* Effect.tryPromise(() => sendJsonResponse(res, 200, items));
    return true;
  });
};

export const handleCreateItem = (req: any, res: any): Effect.Effect<boolean, any, never> => {
  return Effect.gen(function* () {
    const authHeader = String(req.headers['authorization'] || '');
    yield* checkAuth(authHeader);
    const bodyText = yield* Effect.tryPromise(() => readRequestBody(req));
    const rawJson = yield* parseJsonBody(bodyText);
    const validReq = yield* validateCreateItem(rawJson);
    yield* validateTitle(validReq.title);
    const newId = ("item-" + (items.length + 1));
    const newItem: ItemResponse = { id: newId, title: validReq.title, priority: validReq.priority };
    items.push(newItem);
    yield* Effect.tryPromise(() => sendJsonResponse(res, 201, newItem));
    return true;
  });
};

export const handleSimulatedError = (): Effect.Effect<boolean, ServerError, never> => {
  return Effect.fail(makeServerError("Simulated internal database connection failure"));
};

export const handleNotFound = (method: string, url: string): Effect.Effect<boolean, NotFoundError, never> => {
  return Effect.fail(makeNotFoundError(((("Route not found: " + method) + " ") + url)));
};

export const routeRequest = (method: string, url: string, req: any, res: any): Effect.Effect<boolean, any, never> => {
  return match([method, url])
  .with(["GET", "/api/health"], () => handleHealth(res))
  .with(["GET", "/api/items"], () => handleGetItems(res))
  .with(["POST", "/api/items"], () => handleCreateItem(req, res))
  .with(["GET", "/api/error"], () => handleSimulatedError())
  .otherwise(() => handleNotFound(method, url));
};

export const dispatchHttp = (req: any, res: any): Effect.Effect<boolean, any, never> => {
  return Effect.gen(function* () {
    const method = String(req.method || 'GET');
    const url = String(req.url || '/');
    yield* Console.log(((("[HttpServer] " + method) + " ") + url));
    const eff = routeRequest(method, url, req, res);
    const handled = pipe(
  eff,
  Effect.catchTag("ValidationError", (err) => {
  return sendErrorResponse(res, 400, "ValidationError", err.message);
}),
  Effect.catchTag("NotFoundError", (err) => {
  return sendErrorResponse(res, 404, "NotFoundError", err.message);
}),
  Effect.catchTag("ServerError", (err) => {
  return sendErrorResponse(res, 500, "ServerError", err.message);
}),
  Effect.catchAll((err: any) => {
  return sendErrorResponse(res, 500, "ServerError", String(err));
})
);
    yield* handled;
    return true;
  });
};

let activeServer: any = 0;

export const startServer = (port: number) => Effect.runPromise(Effect.gen(function* () {
    yield* Console.log(("[HttpServer] Starting REST server on port " + port));
    const serverInstance = yield* Effect.tryPromise(() => new Promise((resolve) => { const s = createServer((req, res) => { Effect.runPromise(dispatchHttp(req, res)); }); s.listen(port, () => resolve(s)); }));

    yield* Console.log("[HttpServer] Server listening");
    return serverInstance;
  }));

export const stopServer = () => Effect.runPromise(Effect.gen(function* () {
    if ((activeServer === 0)) return true;
    yield* Effect.tryPromise(() => new Promise((resolve, reject) => { try { (activeServer as any)?.closeAllConnections?.(); activeServer.close((err?: Error) => err ? reject(err) : resolve(true)); } catch(e) { resolve(true); } }));

    yield* Console.log("[HttpServer] Server stopped successfully.");
    return true;
  }));

export const getItemsCount = (): number => {
  return (items.length);
};

export const resetItemsStore = () => Effect.runPromise(Effect.gen(function* () {
    items.splice(0, items.length);
    items.push({ id: "item-1", title: "Setup Project", priority: 1 });
    items.push({ id: "item-2", title: "Write FunScript REST API", priority: 2 });
    return true;
  }));

export const main = () => {
  return Effect.gen(function* () {
    yield* Console.log("=== FunScript REST API Server Demo ===");
    const srv = yield* Effect.tryPromise(() => startServer(8080));
    yield* Console.log("[HttpServer] Server ready on http://localhost:8080");
    return 0;
  });
};
