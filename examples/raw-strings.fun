// Raw strings: backtick blocks are emitted verbatim into the generated TypeScript.
// `{name}` is FunScript interpolation; `\{` and `\}` emit literal braces, which is
// what you want for CSS, JSON, templates, and other text with curly braces.
import { Console } from "effect"

name = "Ada"

greeting = `Hello, ${name}!`

css = `
  body \{
    color: #1f2933;
    margin: 3rem auto;
  \}
  .error \{ color: #b00020; \}
`

json = `\{ "ok": true, "user": "${name}" \}`

export main =
  effect {
    _ <- Console.log(greeting)
    _ <- Console.log(css)
    _ <- Console.log(json)
    => 0
  }
