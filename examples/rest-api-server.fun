// Effect HTTP REST example. The Node adapter requires Node 22.19+; the project
// itself continues to support Node 20 for compiler and non-HTTP examples.
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { createServer } from "node:http"
import process from "node:process"

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

getItems = HttpRouter.add("GET", "/items", HttpServerResponse.json([]))

createItem = HttpRouter.schemaJson(Schema.Struct({ body: Schema.Struct({ name: Schema.String }) }))

createItemResponse = Effect.flatMap(createItem, (request) => HttpServerResponse.json({ id: 1, name: request.body.name }, { status: 201 }))

postItems = HttpRouter.add("POST", "/items", Effect.catchCause(createItemResponse, (_) => HttpServerResponse.json({ error: "ValidationError", message: "Request body must contain a string name" }, { status: 400 })))

notFound = HttpRouter.add("*", "/*", HttpServerResponse.json({ error: "NotFoundError", message: "No route for this path" }, { status: 404 }))

export routes = Layer.mergeAll(getItems, postItems, notFound)

export serverLayer = (port: Number) => HttpRouter.serve(routes).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port })))

port = Number(process.env.PORT) or 3000

export main = Layer.launch(serverLayer(port)) |> NodeRuntime.runMain
