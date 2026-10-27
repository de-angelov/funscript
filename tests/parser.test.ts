import { describe, it, expect } from "vitest";
import { Lexer } from "../src/lexer/lexer.js";
import { Parser, ParseError } from "../src/parser/parser.js";
import {
  Program,
  ImportDeclaration,
  ExportDeclaration,
  SchemaDeclaration,
  RecordSchema,
  TaggedUnionSchema,
  RefinementSchema,
  TypeSignatureSchema,
  ErrorDeclaration,
  ServiceDeclaration,
  BindingDeclaration,
  BinaryExpression,
  UnaryExpression,
  PipelineExpression,
  CallExpression,
  MemberExpression,
  IndexExpression,
  RecordExpression,
  ArrayExpression,
    FunctionExpression,
  FunctionTypeNode,
  EffectTypeNode,
  BlockStatement,
  MutBlockExpression,
  MatchExpression,
  EffectBlockExpression,
  EffectBindStatement,
  EffectDiscardStatement,
  TypedHole,
  ConstructorPattern,
  LiteralPattern,
  VariablePattern,
  WildcardPattern,
  OrPattern,
} from "../src/ast/types.js";

function parse(source: string, filename = "test.fun"): Program {
  const lexer = new Lexer(source, filename);
  const parser = new Parser(lexer.tokenize(), filename);
  return parser.parse();
}

describe("FunScript Parser", () => {
  describe("Import & Export Declarations", () => {
    it("parses standard and aliased imports", () => {
      const ast = parse(`import { User, Config as AppConfig } from "./config.js"`);
      expect(ast.body.length).toBe(1);

      const imp = ast.body[0] as ImportDeclaration;
      expect(imp.kind).toBe("ImportDeclaration");
      expect(imp.isTypeOnly).toBe(false);
      expect(imp.source.parts[0]).toEqual({ kind: "StringRawPart", value: "./config.js" });
      expect(imp.specifiers.length).toBe(2);

      expect(imp.specifiers[0].imported.name).toBe("User");
      expect(imp.specifiers[0].local.name).toBe("User");
      expect(imp.specifiers[0].isTypeOnly).toBe(false);

      expect(imp.specifiers[1].imported.name).toBe("Config");
      expect(imp.specifiers[1].local.name).toBe("AppConfig");
      expect(imp.specifiers[1].isTypeOnly).toBe(false);
    });

    it("parses multiple imports", () => {
      const ast = parse(`import { State } from "./state.js"\nimport { client, Config } from "./api.js"`);
      expect(ast.body.length).toBe(2);

      const imp1 = ast.body[0] as ImportDeclaration;
      expect(imp1.kind).toBe("ImportDeclaration");
      expect(imp1.specifiers[0].imported.name).toBe("State");

      const imp2 = ast.body[1] as ImportDeclaration;
      expect(imp2.kind).toBe("ImportDeclaration");
      expect(imp2.specifiers.length).toBe(2);
      expect(imp2.specifiers[0].imported.name).toBe("client");
      expect(imp2.specifiers[1].imported.name).toBe("Config");
    });

    it("parses exported declarations", () => {
      const ast = parse(`
export schema Item = { id: string }
export count = 10
`);
      expect(ast.body.length).toBe(2);
      expect(ast.body[0].kind).toBe("ExportDeclaration");
      expect((ast.body[0] as ExportDeclaration).declaration.kind).toBe("SchemaDeclaration");

      expect(ast.body[1].kind).toBe("ExportDeclaration");
      expect((ast.body[1] as ExportDeclaration).declaration.kind).toBe("BindingDeclaration");
    });
  });

  describe("Schema Declarations", () => {
    it("parses RecordSchema with required fields and default values", () => {
      const ast = parse(`
schema User = {
  id: string
  name: string
  role: string = "member"
  age: number
}
`);
      expect(ast.body.length).toBe(1);
      const decl = ast.body[0] as SchemaDeclaration;
      expect(decl.kind).toBe("SchemaDeclaration");
      expect(decl.id.name).toBe("User");

      const body = decl.body as RecordSchema;
      expect(body.kind).toBe("RecordSchema");
      expect(body.fields.length).toBe(4);

      expect(body.fields[0].name.name).toBe("id");
      expect(body.fields[0].typeAnnotation.kind).toBe("TypeReferenceNode");
      expect(body.fields[0].defaultValue).toBeUndefined();

      expect(body.fields[2].name.name).toBe("role");
      expect(body.fields[2].defaultValue?.kind).toBe("StringLiteral");
    });

    it("parses TaggedUnionSchema with variants, fields, and unit variants", () => {
      const ast = parse(`
schema Shape =
  | Circle(radius: number)
  | Rect(width: number, height: number)
  | Point
`);
      const decl = ast.body[0] as SchemaDeclaration;
      expect(decl.id.name).toBe("Shape");

      const body = decl.body as TaggedUnionSchema;
      expect(body.kind).toBe("TaggedUnionSchema");
      expect(body.variants.length).toBe(3);

      expect(body.variants[0].name.name).toBe("Circle");
      expect(body.variants[0].fields.length).toBe(1);
      expect(body.variants[0].fields[0].name.name).toBe("radius");

      expect(body.variants[1].name.name).toBe("Rect");
      expect(body.variants[1].fields.length).toBe(2);
      expect(body.variants[1].fields[0].name.name).toBe("width");
      expect(body.variants[1].fields[1].name.name).toBe("height");

      expect(body.variants[2].name.name).toBe("Point");
      expect(body.variants[2].fields.length).toBe(0);
    });

    it("parses schema with type parameters", () => {
      const ast = parse(`
schema Result<T, E> =
  | Ok(value: T)
  | Err(err: E)
`);
      const decl = ast.body[0] as SchemaDeclaration;
      expect(decl.id.name).toBe("Result");
      expect(decl.typeParams?.map((p) => p.name.name)).toEqual(["T", "E"]);

      const body = decl.body as TaggedUnionSchema;
      expect(body.variants.length).toBe(2);
      expect(body.variants[0].name.name).toBe("Ok");
      expect(body.variants[1].name.name).toBe("Err");
    });

    it("parses RefinementSchema", () => {
      const ast = parse(`schema Positive = number |> Number.greaterThan(0)`);
      const decl = ast.body[0] as SchemaDeclaration;
      expect(decl.id.name).toBe("Positive");

      const body = decl.body as RefinementSchema;
      expect(body.kind).toBe("RefinementSchema");
      expect(body.baseType.kind).toBe("TypeReferenceNode");
      expect(body.refinement.kind).toBe("CallExpression");
    });

    it("parses schema with nested record types and complex types", () => {
      const ast = parse(`
schema ServerConfig = {
  host: string
  port: number
  db: {
    url: string
    poolSize: number
  }
}
`);
      const decl = ast.body[0] as SchemaDeclaration;
      const body = decl.body as RecordSchema;
      expect(body.fields.length).toBe(3);
      expect(body.fields[2].name.name).toBe("db");
      expect(body.fields[2].typeAnnotation.kind).toBe("RecordTypeNode");
    });

    it("parses schema with Effect types including error and requirements channels", () => {
      const ast = parse(`
schema Action = (id: string) -> Effect<User, NotFound, Database>
`);
      const decl = ast.body[0] as SchemaDeclaration;
      const body = decl.body as TypeSignatureSchema;
      expect(body.kind).toBe("TypeSignatureSchema");
      const sig = body.signature as FunctionTypeNode;
      expect(sig.returnType.kind).toBe("EffectTypeNode");
      const eff = sig.returnType as EffectTypeNode;
      expect(eff.success.kind).toBe("TypeReferenceNode");
      expect(eff.error?.kind).toBe("TypeReferenceNode");
      expect(eff.requirements?.kind).toBe("TypeReferenceNode");
    });
  });

  describe("Error Declarations", () => {
    it("parses ErrorDeclaration with fields", () => {
      const ast = parse(`error NotFound(id: string, code: number)`);
      const err = ast.body[0] as ErrorDeclaration;

      expect(err.kind).toBe("ErrorDeclaration");
      expect(err.id.name).toBe("NotFound");
      expect(err.fields.length).toBe(2);
      expect(err.fields[0].name.name).toBe("id");
      expect(err.fields[1].name.name).toBe("code");
    });

    it("parses ErrorDeclaration without fields", () => {
      const ast = parse(`error Unauthorized`);
      const err = ast.body[0] as ErrorDeclaration;

      expect(err.kind).toBe("ErrorDeclaration");
      expect(err.id.name).toBe("Unauthorized");
      expect(err.fields.length).toBe(0);
    });
  });

  describe("Service Declarations", () => {
    it("parses ServiceDeclaration with members and default tag", () => {
      const ast = parse(`
service UserRepo
  find: (id: string) -> Effect<User, NotFound>
  save: (user: User) -> Effect<void>
`);
      const svc = ast.body[0] as ServiceDeclaration;

      expect(svc.kind).toBe("ServiceDeclaration");
      expect(svc.id.name).toBe("UserRepo");
      expect(svc.customTag).toBeUndefined();
      expect(svc.members.length).toBe(2);

      expect(svc.members[0].name.name).toBe("find");
      expect(svc.members[0].signature.kind).toBe("FunctionTypeNode");
      expect(svc.members[1].name.name).toBe("save");
    });

    it("parses ServiceDeclaration with custom tag string", () => {
      const ast = parse(`
service PaymentGateway "custom/payment/gateway"
  charge: (amount: number) -> Effect<Receipt, PaymentFailed>
`);
      const svc = ast.body[0] as ServiceDeclaration;

      expect(svc.kind).toBe("ServiceDeclaration");
      expect(svc.id.name).toBe("PaymentGateway");
      expect(svc.customTag?.parts[0]).toEqual({ kind: "StringRawPart", value: "custom/payment/gateway" });
      expect(svc.members.length).toBe(1);
      expect(svc.members[0].name.name).toBe("charge");
    });
  });

  describe("Binding Declarations", () => {
    it("parses immutable, typed, and mutable bindings", () => {
      const ast = parse(`
x = 10
count: number = 0
mut total = 100
mut flag: boolean = true
`);
      expect(ast.body.length).toBe(4);

      const b0 = ast.body[0] as BindingDeclaration;
      expect(b0.isMut).toBe(false);
      expect(b0.id.name).toBe("x");
      expect(b0.typeAnnotation).toBeUndefined();

      const b1 = ast.body[1] as BindingDeclaration;
      expect(b1.isMut).toBe(false);
      expect(b1.id.name).toBe("count");
      expect(b1.typeAnnotation?.kind).toBe("TypeReferenceNode");

      const b2 = ast.body[2] as BindingDeclaration;
      expect(b2.isMut).toBe(true);
      expect(b2.id.name).toBe("total");

      const b3 = ast.body[3] as BindingDeclaration;
      expect(b3.isMut).toBe(true);
      expect(b3.id.name).toBe("flag");
      expect(b3.typeAnnotation?.kind).toBe("TypeReferenceNode");
    });
  });

  describe("Expressions & Precedence", () => {
    it("respects operator precedence for arithmetic", () => {
      const ast = parse(`res = 1 + 2 * 3`);
      const binding = ast.body[0] as BindingDeclaration;
      const bin = binding.init as BinaryExpression;

      expect(bin.kind).toBe("BinaryExpression");
      expect(bin.operator).toBe("+");
      expect(bin.left.kind).toBe("NumberLiteral");

      const right = bin.right as BinaryExpression;
      expect(right.kind).toBe("BinaryExpression");
      expect(right.operator).toBe("*");
    });

    it("parses right-associative exponentiation", () => {
      const ast = parse(`res = 2 ** 3 ** 4`);
      const binding = ast.body[0] as BindingDeclaration;
      const bin = binding.init as BinaryExpression;

      expect(bin.operator).toBe("**");
      expect(bin.left.kind).toBe("NumberLiteral");
      // 2 ** (3 ** 4)
      expect(bin.right.kind).toBe("BinaryExpression");
      expect((bin.right as BinaryExpression).operator).toBe("**");
    });

    it("parses logical and equality expressions", () => {
      const ast = parse(`res = a and b or c == d != e ?? f`);
      const binding = ast.body[0] as BindingDeclaration;
      expect(binding.init.kind).toBe("BinaryExpression");
    });

    it("parses unary expressions (not, -)", () => {
      const ast = parse(`
a = not active
b = -42
`);
      const u1 = (ast.body[0] as BindingDeclaration).init as UnaryExpression;
      expect(u1.kind).toBe("UnaryExpression");
      expect(u1.operator).toBe("not");

      const u2 = (ast.body[1] as BindingDeclaration).init as UnaryExpression;
      expect(u2.kind).toBe("UnaryExpression");
      expect(u2.operator).toBe("-");
    });

    it("parses calls, member accesses, and indices", () => {
      const ast = parse(`res = users.get(id)[0].profile.name`);
      const binding = ast.body[0] as BindingDeclaration;
      expect(binding.init.kind).toBe("MemberExpression");

      const member = binding.init as MemberExpression;
      expect(member.property.name).toBe("name");
    });

    it("parses array literals", () => {
      const ast = parse(`empty = []\nfilled = [1, 2, 3]`);
      const e = (ast.body[0] as BindingDeclaration).init as ArrayExpression;
      expect(e.kind).toBe("ArrayExpression");
      expect(e.elements.length).toBe(0);

      const f = (ast.body[1] as BindingDeclaration).init as ArrayExpression;
      expect(f.kind).toBe("ArrayExpression");
      expect(f.elements.length).toBe(3);
    });

    it("parses record literals: entries, shorthands, spreads, dot-paths", () => {
      const ast = parse(`
user = {
  id: "123"
  name
  ...existing
  address.city: "Paris"
}
`);
      const rec = (ast.body[0] as BindingDeclaration).init as RecordExpression;
      expect(rec.kind).toBe("RecordExpression");
      expect(rec.entries.length).toBe(4);

      expect(rec.entries[0].kind).toBe("FieldEntry");
      expect(rec.entries[1].kind).toBe("ShorthandEntry");
      expect(rec.entries[2].kind).toBe("SpreadEntry");
      expect(rec.entries[3].kind).toBe("DotPathEntry");
      if (rec.entries[3].kind === "DotPathEntry") {
        expect(rec.entries[3].path.map((p) => p.name)).toEqual(["address", "city"]);
      }
    });

    it("parses pipeline expressions and placeholder", () => {
      const ast = parse(`res = items |> process |> save(config, _)`);
      const pipe = (ast.body[0] as BindingDeclaration).init as PipelineExpression;
      expect(pipe.kind).toBe("PipelineExpression");

      const call = pipe.right as CallExpression;
      expect(call.kind).toBe("CallExpression");
      expect(call.args.some((a) => a.kind === "Placeholder")).toBe(true);
    });

    it("parses typed holes", () => {
      const ast = parse(`a = ???\nb = ??? "implement after v1"`);
      const h1 = (ast.body[0] as BindingDeclaration).init as TypedHole;
      expect(h1.kind).toBe("TypedHole");
      expect(h1.label).toBeUndefined();

      const h2 = (ast.body[1] as BindingDeclaration).init as TypedHole;
      expect(h2.kind).toBe("TypedHole");
      expect(h2.label).toBe("implement after v1");
    });

    it("parses lambda expressions with single and multiple parameters", () => {
      const ast = parse(`
f1 = () -> 42
f2 = -> 100
f3 = (x) -> x + 1
f4 = (a: number, b: number): number -> a + b
`);
      const l1 = (ast.body[0] as BindingDeclaration).init as FunctionExpression;
      expect(l1.kind).toBe("FunctionExpression");
      expect(l1.params.length).toBe(0);

      const l2 = (ast.body[1] as BindingDeclaration).init as FunctionExpression;
      expect(l2.params.length).toBe(0);

      const l3 = (ast.body[2] as BindingDeclaration).init as FunctionExpression;
      expect(l3.params.length).toBe(1);
      expect(l3.params[0].name.name).toBe("x");

      const l4 = (ast.body[3] as BindingDeclaration).init as FunctionExpression;
      expect(l4.params.length).toBe(2);
      expect(l4.returnType?.kind).toBe("TypeReferenceNode");
    });

    it("parses multiline block function body with local statements", () => {
      const ast = parse(`
calculate = (x: number) ->
  multiplier = 2
  temp = x * multiplier
  temp + 1
`);
      const fn = (ast.body[0] as BindingDeclaration).init as FunctionExpression;
      expect(fn.body.kind).toBe("BlockStatement");
      const block = fn.body as BlockStatement;
      expect(block.statements.length).toBe(2);
      expect(block.statements[0].kind).toBe("BindingDeclaration");
      expect(block.finalExpression.kind).toBe("BinaryExpression");
    });
  });

  describe("Mut Block Expressions", () => {
    it("parses mut blocks in pipelines", () => {
      const ast = parse(`
updated = user |> mut(draft) ->
  draft.tags.push("active")
  draft
`);
      const pipe = (ast.body[0] as BindingDeclaration).init as PipelineExpression;
      const mutBlock = pipe.right as MutBlockExpression;

      expect(mutBlock.kind).toBe("MutBlockExpression");
      expect(mutBlock.draftParam.name).toBe("draft");
      expect(mutBlock.body.kind).toBe("BlockStatement");

      const block = mutBlock.body as BlockStatement;
      expect(block.statements.length).toBe(1);
      expect(block.finalExpression.kind).toBe("Identifier");
    });
  });

  describe("Match Expressions", () => {
    it("parses scrutinee match with constructor patterns, variables, and wildcards", () => {
      const ast = parse(`
res = match shape
  | Circle(r) -> r * 2
  | Rect(w, h) -> w * h
  | Point -> 0
  | other -> other
  | _ -> -1
`);
      const matchExpr = (ast.body[0] as BindingDeclaration).init as MatchExpression;
      expect(matchExpr.kind).toBe("MatchExpression");
      expect(matchExpr.scrutinee?.kind).toBe("Identifier");
      expect(matchExpr.arms.length).toBe(5);

      const a0 = matchExpr.arms[0];
      expect(a0.pattern.kind).toBe("ConstructorPattern");
      const cp0 = a0.pattern as ConstructorPattern;
      expect(cp0.constructorName.name).toBe("Circle");
      expect(cp0.args.length).toBe(1);

      const a1 = matchExpr.arms[1];
      const cp1 = a1.pattern as ConstructorPattern;
      expect(cp1.constructorName.name).toBe("Rect");
      expect(cp1.args.length).toBe(2);

      const a2 = matchExpr.arms[2];
      const cp2 = a2.pattern as ConstructorPattern;
      expect(cp2.constructorName.name).toBe("Point");
      expect(cp2.args.length).toBe(0);

      const a3 = matchExpr.arms[3];
      expect(a3.pattern.kind).toBe("VariablePattern");
      expect((a3.pattern as VariablePattern).name.name).toBe("other");

      const a4 = matchExpr.arms[4];
      expect(a4.pattern.kind).toBe("WildcardPattern");
    });

    it("parses match arm guards (when)", () => {
      const ast = parse(`
res = match shape
  | Circle(r) when r |> Number.greaterThan(0) -> r
  | _ -> 0
`);
      const matchExpr = (ast.body[0] as BindingDeclaration).init as MatchExpression;
      expect(matchExpr.arms[0].guard).toBeDefined();
      expect(matchExpr.arms[0].guard?.kind).toBe("PipelineExpression");
    });

    it("parses literal patterns (numbers, booleans) in match arms", () => {
      const ast = parse(`
res = match flag
  | true -> 1
  | false -> 0
`);
      const matchExpr = (ast.body[0] as BindingDeclaration).init as MatchExpression;
      expect(matchExpr.arms.length).toBe(2);
      expect(matchExpr.arms[0].pattern.kind).toBe("LiteralPattern");
      expect(matchExpr.arms[1].pattern.kind).toBe("LiteralPattern");
    });

    it("parses OrPattern in match arm", () => {
      const ast = parse(`
res = match code
  | 200 | 201 | 204 -> "ok"
  | _ -> "err"
`);
      const matchExpr = (ast.body[0] as BindingDeclaration).init as MatchExpression;
      const orPat = matchExpr.arms[0].pattern as OrPattern;
      expect(orPat.kind).toBe("OrPattern");
      expect(orPat.patterns.length).toBe(3);
    });

    it("parses subjectless boolean match expressions", () => {
      const ast = parse(`
grade = match
  | score |> Number.greaterThan(90) -> "A"
  | score |> Number.greaterThan(80) -> "B"
  | _ -> "C"
`);
      const matchExpr = (ast.body[0] as BindingDeclaration).init as MatchExpression;
      expect(matchExpr.scrutinee).toBeUndefined();
      expect(matchExpr.arms.length).toBe(3);

      expect(matchExpr.arms[0].pattern.kind).toBe("LiteralPattern");
      expect(matchExpr.arms[2].pattern.kind).toBe("WildcardPattern");
    });
  });

  describe("Effect Blocks", () => {
    it("parses effect block with binds, discards, local bindings, and final return", () => {
      const ast = parse(`
getUser = (id: string) -> effect
  user <- UserRepo.find(id)
  _ <- Console.log(user)
  prefix = "User: "
  user
`);
      const fn = (ast.body[0] as BindingDeclaration).init as FunctionExpression;
      const eff = fn.body as EffectBlockExpression;

      expect(eff.kind).toBe("EffectBlockExpression");
      expect(eff.body.length).toBe(3);

      expect(eff.body[0].kind).toBe("EffectBindStatement");
      const bind = eff.body[0] as EffectBindStatement;
      expect(bind.id.name).toBe("user");

      expect(eff.body[1].kind).toBe("EffectDiscardStatement");
      const discard = eff.body[1] as EffectDiscardStatement;
      expect(discard.effect.kind).toBe("CallExpression");

      expect(eff.body[2].kind).toBe("BindingDeclaration");
      const local = eff.body[2] as BindingDeclaration;
      expect(local.id.name).toBe("prefix");

      expect(eff.finalExpression.kind).toBe("Identifier");
    });

    it("throws ParseError when non-final bare expression is placed in effect block", () => {
      const code = `
run = () ->
  effect
    Console.log("not bound with <-")
    "done"
`;
      expect(() => parse(code)).toThrow(ParseError);
      expect(() => parse(code)).toThrow(/Non-final bare expression in effect block is not executed/);
    });

    it("throws ParseError when effect block does not end with an expression", () => {
      const code = `
run = () ->
  effect
    user <- UserRepo.find("1")
`;
      expect(() => parse(code)).toThrow(ParseError);
      expect(() => parse(code)).toThrow(/Effect block must end with a return expression/);
    });
  });

  describe("Parser Error Handling", () => {
    it("throws ParseError on empty parens not followed by arrow", () => {
      expect(() => parse(`x = () + 1`)).toThrow(ParseError);
      expect(() => parse(`x = () + 1`)).toThrow(/Empty parentheses '\(\)' must be followed by '->'/);
    });

    it("throws ParseError on missing required tokens", () => {
      expect(() => parse(`schema User`)).toThrow(ParseError);
      expect(() => parse(`import { foo }`)).toThrow(ParseError);
      expect(() => parse(`service MyService`)).toThrow(ParseError);
      expect(() => parse(`export schema MySchema = { id }`)).toThrow(ParseError);
    });
  });
});
