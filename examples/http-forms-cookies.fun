// The HTTP bits that the JSON-only rest-api-server example does not cover:
// url-encoded form decoding, Schema validation, session cookies, redirects,
// and mapping typed errors to HTML responses.
import { Config, Effect, Layer, Option, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { createServer } from "node:http"

export error ValidationError(message: String)

schema Credentials = {
  username: String |> Schema.check(Schema.isMinLength(1))
  password: String |> Schema.check(Schema.isMinLength(1))
}

toValidationError = (cause: Unknown) => ValidationError({ message: "Invalid form submission." })

page = (body: String) =>
  "<!DOCTYPE html><html><head><title>Form login</title></head><body>{body}</body></html>"

html = (body: String) => HttpServerResponse.text(body, { contentType: "text/html; charset=utf-8" })

formFields = HttpServerRequest.schemaBodyUrlParams(Schema.Struct({
  username: Schema.optional(Schema.String)
  password: Schema.optional(Schema.String)
}))

readCredentials =
  effect {
    fields <- formFields |> Effect.mapError(toValidationError)
    credentials <- Schema.decodeUnknownEffect(Credentials)({
      username: fields.username or ""
      password: fields.password or ""
    })
    |> Effect.mapError(toValidationError)
    => credentials
  }

loginForm = html(page(`
  <h1>Log in</h1>
  <form method='post' action='/login'>
    <input name='username' required>
    <input name='password' type='password' required>
    <button type='submit'>Log in</button>
  </form>
`))

loginHandler =
  effect {
    credentials <- readCredentials
    response <- Effect.orDie(HttpServerResponse.setCookie(HttpServerResponse.redirect("/protected", { status: 303 }), "session", credentials.username, {
      httpOnly: true
      sameSite: "lax"
      path: "/"
      maxAge: "7 days"
    }))
    => response
  }
  |> Effect.catchTag("ValidationError", (cause) =>
    Effect.sync(() => HttpServerResponse.setStatus(html(page("Error: {cause.message}")), 400))
  )

protectedHandler =
  effect {
    request <- HttpServerRequest.HttpServerRequest
    session = Schema.decodeUnknownOption(Schema.String)(request.cookies.session)
    => Option.match(session, {
      onNone: () => HttpServerResponse.redirect("/login", { status: 303 })
      onSome: (name) => html(page("Welcome, {name}! <form method='post' action='/logout'><button>Log off</button></form>"))
    })
  }

logoutHandler =
  effect {
    response <- Effect.orDie(HttpServerResponse.expireCookie(HttpServerResponse.redirect("/login", { status: 303 }), "session", { path: "/" }))
    => response
  }

routes = Layer.mergeAll(HttpRouter.add("GET", "/login", loginForm), HttpRouter.add("POST", "/login", loginHandler), HttpRouter.add("GET", "/protected", protectedHandler), HttpRouter.add("POST", "/logout", logoutHandler))

serverConfig = Config.all({
  host: Config.String("HOST") |> Config.withDefault("127.0.0.1")
  port: Config.Port("PORT") |> Config.withDefault(3100)
})

export main =
  Layer.launch(HttpRouter.serve(routes)
  |> Layer.provide(NodeHttpServer.layerConfig(createServer, serverConfig)))
  |> NodeRuntime.runMain
