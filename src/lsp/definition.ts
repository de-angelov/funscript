import type {
  Program,
  TopLevelDeclaration,
  ExportDeclaration,
  ImportDeclaration,
  ImportSpecifier,
  BindingDeclaration,
  SchemaDeclaration,
  VariantDeclaration,
  RecordFieldSchema,
  ErrorDeclaration,
  ErrorField,
  ServiceDeclaration,
  ServiceMember,
  Expression,
  Literal,
  NumberLiteral,
  StringLiteral,
  BooleanLiteral,
  Identifier,
  UpperIdentifier,
  Placeholder,
  TypedHole,
  PipelineExpression,
  BinaryExpression,
  UnaryExpression,
  CallExpression,
  MemberExpression,
  IndexExpression,
  RecordExpression,
  ArrayExpression,
  FunctionExpression,
  FunctionBody,
  BlockStatement,
  Statement,
  AssignmentStatement,
  ExpressionStatement,
  MutBlockExpression,
  MatchExpression,
  MatchArm,
  Pattern,
  ConstructorPattern,
  RecordPattern,
  RecordPatternField,
  ArrayPattern,
  OrPattern,
  EffectBlockExpression,
  EffectStatement,
  EffectBindStatement,
  EffectDiscardStatement,
  EffectControlFlowStatement,
  TypeNode,
  TypeReferenceNode,
  TypeParameter,
  Parameter,
  FunctionTypeNode,
  EffectTypeNode,
  RecordTypeNode,
  RecordTypeField,
  ArrayTypeNode,
  UnionTypeNode,
  Span,
  NodeBase,
  JSXElement,
  JSXSelfClosingElement,
  JSXAttribute,
} from "../ast/types.js";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import type { Position, Range, Location, LocationLink } from "./protocol.js";

export function isPositionInSpan(
  posLine: number,
  posCol: number,
  span: Span
): boolean {
  if (posLine < span.start.line || posLine > span.end.line) {
    return false;
  }
  if (posLine === span.start.line && posCol < span.start.column) {
    return false;
  }
  if (posLine === span.end.line && posCol > span.end.column) {
    return false;
  }
  return true;
}

export function spanToRange(span: Span): Range {
  return {
    start: {
      line: Math.max(0, span.start.line - 1),
      character: Math.max(0, span.start.column - 1),
    },
    end: {
      line: Math.max(0, span.end.line - 1),
      character: Math.max(0, span.end.column - 1),
    },
  };
}

export interface SymbolDefinition {
  name: string;
  declarationNode: NodeBase;
  identifierNode: NodeBase;
  kind: "function" | "variable" | "type" | "parameter" | "field" | "import";
}

export class Scope {
  private symbols: Map<string, SymbolDefinition> = new Map();

  constructor(public parent: Scope | null = null) {}

  public define(
    name: string,
    declarationNode: NodeBase,
    identifierNode: NodeBase,
    kind: "function" | "variable" | "type" | "parameter" | "field" | "import"
  ): void {
    this.symbols.set(name, {
      name,
      declarationNode,
      identifierNode,
      kind,
    });
  }

  public lookup(name: string): SymbolDefinition | undefined {
    const found = this.symbols.get(name);
    if (found) return found;
    if (this.parent) return this.parent.lookup(name);
    return undefined;
  }
}

export interface DefinitionMatch {
  originNode: NodeBase;
  declarationNode: NodeBase;
  targetIdentifierNode: NodeBase;
}

export class DefinitionFinder {
  private found: DefinitionMatch | null = null;
  private members: Map<string, SymbolDefinition> = new Map();

  constructor(
    private posLine: number,
    private posCol: number
  ) {}

  public find(program: Program): DefinitionMatch | null {
    this.collectMembers(program);

    const rootScope = new Scope(null);
    this.populateTopLevelScope(program, rootScope);

    for (const decl of program.body) {
      this.visitTopLevelDeclaration(decl, rootScope);
      if (this.found) return this.found;
    }

    return this.found;
  }

  private collectMembers(program: Program): void {
    for (const topDecl of program.body) {
      const decl = topDecl.kind === "ExportDeclaration" ? topDecl.declaration : topDecl;

      if (decl.kind === "SchemaDeclaration") {
        if (decl.body.kind === "RecordSchema") {
          for (const field of decl.body.fields) {
            this.members.set(field.name.name, {
              name: field.name.name,
              declarationNode: field,
              identifierNode: field.name,
              kind: "field",
            });
          }
        } else if (decl.body.kind === "TaggedUnionSchema") {
          for (const variant of decl.body.variants) {
            for (const field of variant.fields) {
              this.members.set(field.name.name, {
                name: field.name.name,
                declarationNode: field,
                identifierNode: field.name,
                kind: "field",
              });
            }
          }
        }
      } else if (decl.kind === "ErrorDeclaration") {
        for (const field of decl.fields) {
          this.members.set(field.name.name, {
            name: field.name.name,
            declarationNode: field,
            identifierNode: field.name,
            kind: "field",
          });
        }
      } else if (decl.kind === "ServiceDeclaration") {
        for (const member of decl.members) {
          this.members.set(member.name.name, {
            name: member.name.name,
            declarationNode: member,
            identifierNode: member.name,
            kind: "field",
          });
        }
      }
    }
  }

  private populateTopLevelScope(program: Program, scope: Scope): void {
    for (const topDecl of program.body) {
      const decl = topDecl.kind === "ExportDeclaration" ? topDecl.declaration : topDecl;
      const declNode = topDecl;

      switch (decl.kind) {
        case "BindingDeclaration": {
          const kind = decl.init.kind === "FunctionExpression" ? "function" : "variable";
          scope.define(decl.id.name, declNode, decl.id, kind);
          break;
        }
        case "SchemaDeclaration": {
          scope.define(decl.id.name, declNode, decl.id, "type");
          if (decl.body.kind === "TaggedUnionSchema") {
            for (const variant of decl.body.variants) {
              scope.define(variant.name.name, variant, variant.name, "type");
            }
          }
          break;
        }
        case "ErrorDeclaration": {
          scope.define(decl.id.name, declNode, decl.id, "type");
          break;
        }
        case "ServiceDeclaration": {
          scope.define(decl.id.name, declNode, decl.id, "type");
          break;
        }
        case "ImportDeclaration": {
          for (const spec of decl.specifiers) {
            const idNode = spec.local ?? spec.imported;
            scope.define(idNode.name, spec, idNode, "import");
          }
          break;
        }
      }
    }
  }

  private isCursorIn(node: NodeBase): boolean {
    return isPositionInSpan(this.posLine, this.posCol, node.span);
  }

  private visitTopLevelDeclaration(topDecl: TopLevelDeclaration, scope: Scope): void {
    if (this.found) return;

    if (topDecl.kind === "ExportDeclaration") {
      this.visitDeclaration(topDecl.declaration, scope, topDecl);
    } else {
      this.visitDeclaration(topDecl, scope, topDecl);
    }
  }

  private visitDeclaration(decl: TopLevelDeclaration, scope: Scope, outerNode: NodeBase): void {
    if (this.found) return;

    switch (decl.kind) {
      case "BindingDeclaration": {
        if (this.isCursorIn(decl.id)) {
          this.found = {
            originNode: decl.id,
            declarationNode: outerNode,
            targetIdentifierNode: decl.id,
          };
          return;
        }
        if (decl.typeAnnotation) {
          this.visitTypeNode(decl.typeAnnotation, scope);
        }
        this.visitExpression(decl.init, scope);
        break;
      }

      case "SchemaDeclaration": {
        if (this.isCursorIn(decl.id)) {
          this.found = {
            originNode: decl.id,
            declarationNode: outerNode,
            targetIdentifierNode: decl.id,
          };
          return;
        }

        const schemaScope = new Scope(scope);
        if (decl.typeParams) {
          for (const tp of decl.typeParams) {
            if (this.isCursorIn(tp.name)) {
              this.found = {
                originNode: tp.name,
                declarationNode: tp,
                targetIdentifierNode: tp.name,
              };
              return;
            }
            schemaScope.define(tp.name.name, tp, tp.name, "type");
          }
        }

        if (decl.body.kind === "RecordSchema") {
          for (const field of decl.body.fields) {
            if (this.isCursorIn(field.name)) {
              this.found = {
                originNode: field.name,
                declarationNode: field,
                targetIdentifierNode: field.name,
              };
              return;
            }
            this.visitTypeNode(field.typeAnnotation, schemaScope);
            if (field.defaultValue) {
              this.visitExpression(field.defaultValue, schemaScope);
            }
          }
        } else if (decl.body.kind === "TaggedUnionSchema") {
          for (const variant of decl.body.variants) {
            if (this.isCursorIn(variant.name)) {
              this.found = {
                originNode: variant.name,
                declarationNode: variant,
                targetIdentifierNode: variant.name,
              };
              return;
            }
            for (const field of variant.fields) {
              if (this.isCursorIn(field.name)) {
                this.found = {
                  originNode: field.name,
                  declarationNode: field,
                  targetIdentifierNode: field.name,
                };
                return;
              }
              this.visitTypeNode(field.typeAnnotation, schemaScope);
            }
          }
        } else if (decl.body.kind === "RefinementSchema") {
          this.visitTypeNode(decl.body.baseType, schemaScope);
          this.visitExpression(decl.body.refinement, schemaScope);
        } else if (decl.body.kind === "TypeSignatureSchema") {
          this.visitTypeNode(decl.body.signature, schemaScope);
        }
        break;
      }

      case "ErrorDeclaration": {
        if (this.isCursorIn(decl.id)) {
          this.found = {
            originNode: decl.id,
            declarationNode: outerNode,
            targetIdentifierNode: decl.id,
          };
          return;
        }
        for (const field of decl.fields) {
          if (this.isCursorIn(field.name)) {
            this.found = {
              originNode: field.name,
              declarationNode: field,
              targetIdentifierNode: field.name,
            };
            return;
          }
          this.visitTypeNode(field.typeAnnotation, scope);
        }
        break;
      }

      case "ServiceDeclaration": {
        if (this.isCursorIn(decl.id)) {
          this.found = {
            originNode: decl.id,
            declarationNode: outerNode,
            targetIdentifierNode: decl.id,
          };
          return;
        }
        for (const member of decl.members) {
          if (this.isCursorIn(member.name)) {
            this.found = {
              originNode: member.name,
              declarationNode: member,
              targetIdentifierNode: member.name,
            };
            return;
          }
          this.visitTypeNode(member.signature, scope);
        }
        break;
      }

      case "ImportDeclaration": {
        for (const spec of decl.specifiers) {
          if (this.isCursorIn(spec.imported)) {
            this.found = {
              originNode: spec.imported,
              declarationNode: spec,
              targetIdentifierNode: spec.imported,
            };
            return;
          }
          if (spec.local && this.isCursorIn(spec.local)) {
            this.found = {
              originNode: spec.local,
              declarationNode: spec,
              targetIdentifierNode: spec.local,
            };
            return;
          }
        }
        break;
      }
    }
  }

  private visitExpression(expr: Expression, scope: Scope): void {
    if (this.found) return;

    switch (expr.kind) {
      case "Identifier":
      case "UpperIdentifier": {
        if (this.isCursorIn(expr)) {
          const sym = scope.lookup(expr.name);
          if (sym) {
            this.found = {
              originNode: expr,
              declarationNode: sym.declarationNode,
              targetIdentifierNode: sym.identifierNode,
            };
          }
        }
        break;
      }

      case "PipelineExpression":
      case "BinaryExpression": {
        this.visitExpression(expr.left, scope);
        this.visitExpression(expr.right, scope);
        break;
      }

      case "UnaryExpression": {
        this.visitExpression(expr.argument, scope);
        break;
      }

      case "CallExpression": {
        this.visitExpression(expr.callee, scope);
        for (const arg of expr.args) {
          this.visitExpression(arg, scope);
        }
        break;
      }

      case "MemberExpression": {
        this.visitExpression(expr.object, scope);
        if (this.isCursorIn(expr.property)) {
          const mem = this.members.get(expr.property.name);
          if (mem) {
            this.found = {
              originNode: expr.property,
              declarationNode: mem.declarationNode,
              targetIdentifierNode: mem.identifierNode,
            };
            return;
          }
          const sym = scope.lookup(expr.property.name);
          if (sym) {
            this.found = {
              originNode: expr.property,
              declarationNode: sym.declarationNode,
              targetIdentifierNode: sym.identifierNode,
            };
            return;
          }
        }
        break;
      }

      case "IndexExpression": {
        this.visitExpression(expr.object, scope);
        this.visitExpression(expr.index, scope);
        break;
      }

      case "RecordExpression": {
        for (const entry of expr.entries) {
          switch (entry.kind) {
            case "SpreadEntry":
              this.visitExpression(entry.argument, scope);
              break;
            case "FieldEntry":
              if (this.isCursorIn(entry.key)) {
                const mem = this.members.get(entry.key.name);
                if (mem) {
                  this.found = {
                    originNode: entry.key,
                    declarationNode: mem.declarationNode,
                    targetIdentifierNode: mem.identifierNode,
                  };
                  return;
                }
              }
              this.visitExpression(entry.value, scope);
              break;
            case "DotPathEntry":
              for (const part of entry.path) {
                if (this.isCursorIn(part)) {
                  const mem = this.members.get(part.name);
                  if (mem) {
                    this.found = {
                      originNode: part,
                      declarationNode: mem.declarationNode,
                      targetIdentifierNode: mem.identifierNode,
                    };
                    return;
                  }
                }
              }
              this.visitExpression(entry.value, scope);
              break;
            case "ShorthandEntry": {
              if (this.isCursorIn(entry.key)) {
                const sym = scope.lookup(entry.key.name);
                if (sym) {
                  this.found = {
                    originNode: entry.key,
                    declarationNode: sym.declarationNode,
                    targetIdentifierNode: sym.identifierNode,
                  };
                  return;
                }
              }
              break;
            }
          }
        }
        break;
      }

      case "ArrayExpression": {
        for (const elem of expr.elements) {
          this.visitExpression(elem, scope);
        }
        break;
      }

      case "FunctionExpression": {
        const fnScope = new Scope(scope);
        if (expr.typeParams) {
          for (const tp of expr.typeParams) {
            if (this.isCursorIn(tp.name)) {
              this.found = {
                originNode: tp.name,
                declarationNode: tp,
                targetIdentifierNode: tp.name,
              };
              return;
            }
            fnScope.define(tp.name.name, tp, tp.name, "type");
          }
        }

        for (const param of expr.params) {
          if (this.isCursorIn(param.name)) {
            this.found = {
              originNode: param.name,
              declarationNode: param,
              targetIdentifierNode: param.name,
            };
            return;
          }
          fnScope.define(param.name.name, param, param.name, "parameter");
          if (param.typeAnnotation) {
            this.visitTypeNode(param.typeAnnotation, fnScope);
          }
        }

        if (expr.returnType) {
          this.visitTypeNode(expr.returnType, fnScope);
        }

        this.visitFunctionBody(expr.body, fnScope);
        break;
      }

      case "MutBlockExpression": {
        const mutScope = new Scope(scope);
        if (this.isCursorIn(expr.draftParam)) {
          this.found = {
            originNode: expr.draftParam,
            declarationNode: expr.draftParam,
            targetIdentifierNode: expr.draftParam,
          };
          return;
        }
        mutScope.define(expr.draftParam.name, expr.draftParam, expr.draftParam, "parameter");
        this.visitFunctionBody(expr.body, mutScope);
        break;
      }

      case "MatchExpression": {
        if (expr.scrutinee) {
          this.visitExpression(expr.scrutinee, scope);
        }
        for (const arm of expr.arms) {
          const armScope = new Scope(scope);
          this.collectAndVisitPattern(arm.pattern, armScope);
          if (this.found) return;
          if (arm.guard) {
            this.visitExpression(arm.guard, armScope);
          }
          this.visitFunctionBody(arm.body, armScope);
          if (this.found) return;
        }
        break;
      }

      case "EffectBlockExpression": {
        const effectScope = new Scope(scope);
        for (const stmt of expr.body) {
          if (stmt.kind === "EffectBindStatement") {
            this.visitExpression(stmt.effect, effectScope);
            if (this.isCursorIn(stmt.id)) {
              this.found = {
                originNode: stmt.id,
                declarationNode: stmt,
                targetIdentifierNode: stmt.id,
              };
              return;
            }
            effectScope.define(stmt.id.name, stmt, stmt.id, "variable");
          } else if (stmt.kind === "BindingDeclaration") {
            if (stmt.typeAnnotation) {
              this.visitTypeNode(stmt.typeAnnotation, effectScope);
            }
            this.visitExpression(stmt.init, effectScope);
            if (this.isCursorIn(stmt.id)) {
              this.found = {
                originNode: stmt.id,
                declarationNode: stmt,
                targetIdentifierNode: stmt.id,
              };
              return;
            }
            effectScope.define(stmt.id.name, stmt, stmt.id, "variable");
          } else if (stmt.kind === "AssignmentStatement") {
            if (stmt.target.kind === "Identifier") {
              if (this.isCursorIn(stmt.target)) {
                const sym = effectScope.lookup(stmt.target.name);
                if (sym) {
                  this.found = {
                    originNode: stmt.target,
                    declarationNode: sym.declarationNode,
                    targetIdentifierNode: sym.identifierNode,
                  };
                  return;
                }
              }
            } else if (stmt.target.kind === "DotPathExpression") {
              for (const part of stmt.target.path) {
                if (this.isCursorIn(part)) {
                  const mem = this.members.get(part.name);
                  if (mem) {
                    this.found = {
                      originNode: part,
                      declarationNode: mem.declarationNode,
                      targetIdentifierNode: mem.identifierNode,
                    };
                    return;
                  }
                }
              }
            }
            this.visitExpression(stmt.value, effectScope);
          } else if (stmt.kind === "EffectDiscardStatement") {
            this.visitExpression(stmt.effect, effectScope);
          } else if (stmt.kind === "EffectControlFlowStatement") {
            this.visitExpression(stmt.statement, effectScope);
          } else if (stmt.kind === "WhenStatement") {
            this.visitExpression(stmt.condition, effectScope);
            if (stmt.isEarlyReturn) {
              this.visitExpression(stmt.consequent as Expression, effectScope);
            } else {
              this.visitBlock(stmt.consequent as BlockStatement, effectScope);
            }
          }
          if (this.found) return;
        }
        this.visitExpression(expr.finalExpression, effectScope);
        break;
      }

      case "JSXElement": {
        if (expr.openingElement.name.kind === "MemberExpression") {
          this.visitExpression(expr.openingElement.name, scope);
        } else if (this.isCursorIn(expr.openingElement.name)) {
          const sym = scope.lookup(expr.openingElement.name.name);
          if (sym) {
            this.found = {
              originNode: expr.openingElement.name,
              declarationNode: sym.declarationNode,
              targetIdentifierNode: sym.identifierNode,
            };
            return;
          }
        }
        for (const attr of expr.openingElement.attributes) {
          if (attr.value) {
            if (attr.value.kind === "JSXExpressionContainer") {
              this.visitExpression(attr.value.expression, scope);
            } else if (
              attr.value.kind === "Identifier" ||
              attr.value.kind === "UpperIdentifier"
            ) {
              this.visitExpression(attr.value, scope);
            }
          }
        }
        for (const child of expr.children) {
          if (child.kind === "JSXElement" || child.kind === "JSXSelfClosingElement") {
            this.visitExpression(child, scope);
          } else if (child.kind === "JSXExpressionContainer") {
            this.visitExpression(child.expression, scope);
          }
        }
        break;
      }

      case "JSXSelfClosingElement": {
        if (expr.name.kind === "MemberExpression") {
          this.visitExpression(expr.name, scope);
        } else if (this.isCursorIn(expr.name)) {
          const sym = scope.lookup(expr.name.name);
          if (sym) {
            this.found = {
              originNode: expr.name,
              declarationNode: sym.declarationNode,
              targetIdentifierNode: sym.identifierNode,
            };
            return;
          }
        }
        for (const attr of expr.attributes) {
          if (attr.value) {
            if (attr.value.kind === "JSXExpressionContainer") {
              this.visitExpression(attr.value.expression, scope);
            } else if (
              attr.value.kind === "Identifier" ||
              attr.value.kind === "UpperIdentifier"
            ) {
              this.visitExpression(attr.value, scope);
            }
          }
        }
        break;
      }

      case "StringLiteral": {
        for (const part of expr.parts) {
          if (part.kind === "StringInterpolationPart") {
            this.visitExpression(part.expression, scope);
          }
        }
        break;
      }

      default:
        break;
    }
  }

  private visitFunctionBody(body: FunctionBody, scope: Scope): void {
    if (this.found) return;
    if (body.kind === "BlockStatement") {
      this.visitBlockStatement(body, scope);
    } else {
      this.visitExpression(body, scope);
    }
  }

  private visitBlockStatement(block: BlockStatement, scope: Scope): void {
    if (this.found) return;
    const blockScope = new Scope(scope);

    for (const stmt of block.statements) {
      if (stmt.kind === "BindingDeclaration") {
        if (stmt.typeAnnotation) {
          this.visitTypeNode(stmt.typeAnnotation, blockScope);
        }
        this.visitExpression(stmt.init, blockScope);
        if (this.isCursorIn(stmt.id)) {
          this.found = {
            originNode: stmt.id,
            declarationNode: stmt,
            targetIdentifierNode: stmt.id,
          };
          return;
        }
        blockScope.define(stmt.id.name, stmt, stmt.id, "variable");
      } else if (stmt.kind === "AssignmentStatement") {
        if (stmt.target.kind === "Identifier") {
          if (this.isCursorIn(stmt.target)) {
            const sym = blockScope.lookup(stmt.target.name);
            if (sym) {
              this.found = {
                originNode: stmt.target,
                declarationNode: sym.declarationNode,
                targetIdentifierNode: sym.identifierNode,
              };
              return;
            }
          }
        } else if (stmt.target.kind === "DotPathExpression") {
          for (const part of stmt.target.path) {
            if (this.isCursorIn(part)) {
              const mem = this.members.get(part.name);
              if (mem) {
                this.found = {
                  originNode: part,
                  declarationNode: mem.declarationNode,
                  targetIdentifierNode: mem.identifierNode,
                };
                return;
              }
            }
          }
        }
        this.visitExpression(stmt.value, blockScope);
      } else if (stmt.kind === "ExpressionStatement") {
        this.visitExpression(stmt.expression, blockScope);
      } else if (stmt.kind === "ReturnStatement") {
        this.visitExpression(stmt.argument, blockScope);
      } else if (stmt.kind === "WhenStatement") {
        this.visitExpression(stmt.condition, blockScope);
        if (stmt.isEarlyReturn) {
          this.visitExpression(stmt.consequent as Expression, blockScope);
        } else {
          this.visitBlock(stmt.consequent as BlockStatement, blockScope);
        }
      }
      if (this.found) return;
    }

    if (block.finalExpression) {
      this.visitExpression(block.finalExpression, blockScope);
    }
  }

  private collectAndVisitPattern(pattern: Pattern, scope: Scope): void {
    if (this.found) return;

    switch (pattern.kind) {
      case "VariablePattern": {
        if (this.isCursorIn(pattern.name)) {
          this.found = {
            originNode: pattern.name,
            declarationNode: pattern,
            targetIdentifierNode: pattern.name,
          };
          return;
        }
        scope.define(pattern.name.name, pattern, pattern.name, "variable");
        break;
      }
      case "ConstructorPattern": {
        if (this.isCursorIn(pattern.constructorName)) {
          const sym = scope.lookup(pattern.constructorName.name);
          if (sym) {
            this.found = {
              originNode: pattern.constructorName,
              declarationNode: sym.declarationNode,
              targetIdentifierNode: sym.identifierNode,
            };
            return;
          }
        }
        for (const arg of pattern.args) {
          this.collectAndVisitPattern(arg, scope);
        }
        break;
      }
      case "RecordPattern": {
        for (const field of pattern.fields) {
          if (field.pattern) {
            this.collectAndVisitPattern(field.pattern, scope);
          } else {
            if (this.isCursorIn(field.key)) {
              this.found = {
                originNode: field.key,
                declarationNode: field,
                targetIdentifierNode: field.key,
              };
              return;
            }
            scope.define(field.key.name, field, field.key, "variable");
          }
        }
        break;
      }
      case "ArrayPattern": {
        for (const elem of pattern.elements) {
          this.collectAndVisitPattern(elem, scope);
        }
        break;
      }
      case "OrPattern": {
        if (pattern.patterns.length > 0) {
          this.collectAndVisitPattern(pattern.patterns[0], scope);
        }
        break;
      }
      default:
        break;
    }
  }

  private visitTypeNode(typeNode: TypeNode, scope: Scope): void {
    if (this.found) return;

    switch (typeNode.kind) {
      case "TypeReferenceNode": {
        if (this.isCursorIn(typeNode.name)) {
          const sym = scope.lookup(typeNode.name.name);
          if (sym) {
            this.found = {
              originNode: typeNode.name,
              declarationNode: sym.declarationNode,
              targetIdentifierNode: sym.identifierNode,
            };
            return;
          }
        }
        if (typeNode.typeArgs) {
          for (const arg of typeNode.typeArgs) {
            this.visitTypeNode(arg, scope);
          }
        }
        break;
      }

      case "FunctionTypeNode": {
        const fnTypeScope = new Scope(scope);
        if (typeNode.typeParams) {
          for (const tp of typeNode.typeParams) {
            if (this.isCursorIn(tp.name)) {
              this.found = {
                originNode: tp.name,
                declarationNode: tp,
                targetIdentifierNode: tp.name,
              };
              return;
            }
            fnTypeScope.define(tp.name.name, tp, tp.name, "type");
          }
        }
        for (const param of typeNode.params) {
          this.visitTypeNode(param.typeAnnotation, fnTypeScope);
        }
        this.visitTypeNode(typeNode.returnType, fnTypeScope);
        break;
      }

      case "EffectTypeNode": {
        this.visitTypeNode(typeNode.success, scope);
        if (typeNode.error) {
          this.visitTypeNode(typeNode.error, scope);
        }
        if (typeNode.requirements) {
          this.visitTypeNode(typeNode.requirements, scope);
        }
        break;
      }

      case "RecordTypeNode": {
        for (const field of typeNode.fields) {
          this.visitTypeNode(field.typeAnnotation, scope);
        }
        break;
      }

      case "ArrayTypeNode": {
        this.visitTypeNode(typeNode.elementType, scope);
        break;
      }

      case "UnionTypeNode": {
        for (const t of typeNode.types) {
          this.visitTypeNode(t, scope);
        }
        break;
      }
    }
  }
}

export function findDefinition(
  source: string,
  uri: string,
  position: Position,
  linkSupport: boolean = false
): Location | LocationLink[] | null {
  if (source.trim().length === 0) {
    return null;
  }

  let program: Program;
  try {
    const lexer = new Lexer(source, uri);
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens, uri);
    program = parser.parse();
  } catch {
    return null;
  }

  const posLine = position.line + 1;
  const posCol = position.character + 1;

  const finder = new DefinitionFinder(posLine, posCol);
  const match = finder.find(program);

  if (!match) {
    return null;
  }

  const targetRange = spanToRange(match.declarationNode.span);
  const targetSelectionRange = spanToRange(match.targetIdentifierNode.span);
  const originSelectionRange = spanToRange(match.originNode.span);

  if (linkSupport) {
    const link: LocationLink = {
      originSelectionRange,
      targetUri: uri,
      targetRange,
      targetSelectionRange,
    };
    return [link];
  }

  const location: Location = {
    uri,
    range: targetRange,
  };
  return location;
}
