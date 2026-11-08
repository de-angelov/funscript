// A small native Node HTTP service with schema checked request bodies.

import { Schema } from "effect"
import { createServer } from "node:http"

ts { type Incoming = import('node:http').IncomingMessage; type Outgoing = import('node:http').ServerResponse; type HttpServer = import('node:http').Server; type Chunks = Buffer[]; }

export schema CreateItemRequest = {
  name: String
}

export schema ItemResponse = {
  id: Number
  name: String
}

export schema ApiError = {
  error: String
  message: String
}

export error NotFoundError(path: String)
export error ValidationError(message: String)
export error ServerError(message: String)

sendJson = (res: Outgoing, status: Number, body: Unknown) =>
  => res.writeHead(status).end(JSON.stringify(body))

handleRoute = (req: Incoming, res: Outgoing, body: String) => {
  route = req.method + " " + req.url
  match route
    | "GET /items" => sendJson(res, 200, [])
    | "POST /items" => {
      decoded = Schema.decodeUnknownExit(CreateItemRequest)(JSON.parse(body))
      match decoded
        | { _tag: "Success", value: request } => sendJson(res, 201, { id: 1, name: request.name })
        | { _tag: "Failure" } => sendJson(res, 400, { error: "ValidationError", message: "Request body must contain a string name" })
    }
    | _ => sendJson(res, 404, { error: "NotFoundError", message: "No route for " + req.url })
}

export createApiServer = () => createServer((req, res) => {
  chunks: Chunks = []
  req.on("data", (chunk) => chunks.push(chunk))
  => req.on("end", () => handleRoute(req, res, Buffer.concat(chunks).toString("utf8")))
})

export server = createApiServer()
ts { server.listen(3000); }

