import { Position, Span } from "../ast/types.js";

export enum TokenType {
  // Layout
  INDENT = "INDENT",
  DEDENT = "DEDENT",
  NEWLINE = "NEWLINE",
  EOF = "EOF",

  // Literals
  NUMBER = "NUMBER",
  STRING = "STRING",
  STRING_PART = "STRING_PART",
  INTERPOLATION_START = "INTERPOLATION_START",
  INTERPOLATION_END = "INTERPOLATION_END",

  // Identifiers
  IDENTIFIER = "IDENTIFIER",
  UPPER_IDENTIFIER = "UPPER_IDENTIFIER",

  // The 15 FunScript Keywords
  AND = "and",
  EFFECT = "effect",
  ERROR = "error",
  EXPORT = "export",
  FALSE = "false",
  FROM = "from",
  IMPORT = "import",
  MATCH = "match",
  MUT = "mut",
  NOT = "not",
  OR = "or",
  SCHEMA = "schema",
  SERVICE = "service",
  TRUE = "true",
  WHEN = "when",

  // Operators & Delimiters
  ARROW = "->",
  LARROW = "<-",
  PIPE = "|>",
  BAR = "|",
  UNDERSCORE = "_",
  TYPED_HOLE = "???",
  EQ = "=",
  EQEQ = "==",
  NEQ = "!=",
  PLUS = "+",
  MINUS = "-",
  STAR = "*",
  SLASH = "/",
  PERCENT = "%",
  STARSTAR = "**",
  COLON = ":",
  COMMA = ",",
  DOT = ".",
  DOTDOTDOT = "...",
  QUESTIONQUESTION = "??",
  LPAREN = "(",
  RPAREN = ")",
  LBRACE = "{",
  RBRACE = "}",
  LBRACKET = "[",
  RBRACKET = "]",
  LT = "<",
  GT = ">",
}

export interface Token {
  type: TokenType;
  value: string;
  span: Span;
}

export const KEYWORDS: Record<string, TokenType> = {
  and: TokenType.AND,
  effect: TokenType.EFFECT,
  error: TokenType.ERROR,
  export: TokenType.EXPORT,
  false: TokenType.FALSE,
  from: TokenType.FROM,
  import: TokenType.IMPORT,
  match: TokenType.MATCH,
  mut: TokenType.MUT,
  not: TokenType.NOT,
  or: TokenType.OR,
  schema: TokenType.SCHEMA,
  service: TokenType.SERVICE,
  true: TokenType.TRUE,
  when: TokenType.WHEN,
};

export const BANNED_KEYWORDS: Record<string, string> = {
  let: "FunScript has no 'let'; use 'name = value' for immutable bindings, or 'mut name = value' for local mutable drafts.",
  var: "FunScript has no 'var'; use 'name = value' for immutable bindings, or 'mut name = value' for local mutable drafts.",
  const: "FunScript bindings are const by default; write 'name = value'.",
  function: "FunScript functions use the arrow syntax: '(args) -> body'.",
  class: "FunScript has no classes; use 'schema' for data, 'error' for errors, and 'service' for services.",
  return: "FunScript is expression-oriented; every block automatically evaluates to its final line.",
  throw: "FunScript has no 'throw'; recoverable failures use Effect typed errors, and defects use 'Effect.die' or '|> orDie'.",
  try: "FunScript has no 'try/catch'; use typed errors in the E channel or 'Effect.tryPromise'.",
  catch: "FunScript has no 'try/catch'; handle errors with 'Effect.catchTag' or 'match'.",
  finally: "Use 'Effect.ensuring' or 'Effect.acquireRelease' for deterministic finalizers.",
  async: "FunScript has no 'async/await'; use 'effect' blocks with '<-'.",
  await: "FunScript has no 'await'; execute effects inside 'effect' blocks using '<-'.",
  null: "FunScript has no 'null'; use Option.none() or Option<T> for optional values.",
  undefined: "FunScript has no 'undefined'; use Option<T> or explicit types.",
  if: "FunScript has no 'if'; use 'match' for both pattern matching and boolean branching.",
  else: "FunScript has no 'else'; use '| _ ->' in 'match'.",
  switch: "FunScript has no 'switch'; use 'match'.",
  for: "FunScript has no 'for' loops; use Array pipelines (map, filter) or Effect.forEach.",
  while: "FunScript has no 'while' loops; use Effect.repeat, Schedule, or recursion.",
  type: "FunScript replaces 'type' with 'schema' (export schema Name = ...).",
  data: "FunScript uses 'schema' for all data modeling and tagged unions.",
  interface: "FunScript has no 'interface'; use 'schema' or 'service'.",
};

export const BANNED_SYMBOLS: Record<string, string> = {
  "===": "FunScript strict equality is '=='.",
  "!==": "FunScript strict inequality is '!='.",
  "&&": "FunScript logical AND is 'and'.",
  "||": "FunScript logical OR is 'or'.",
  "!": "FunScript logical NOT is 'not'.",
  "=>": "FunScript function arrow is '->'.",
};
