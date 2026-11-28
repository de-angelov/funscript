# Changelog

## Unreleased

- Generated code that uses the `js` interop operator now imports the shared
  `funscript/js` adapter. Applications must make the FunScript package available
  at runtime or bundle the adapter with their application. `JsInteropError` is
  exported from `funscript/js` and shares its class identity across modules that
  use the same installed package instance.
