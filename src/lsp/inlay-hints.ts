import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  type InlayHint,
  InlayHintKind,
  type Position,
  type Range,
} from "vscode-languageserver/node";
import type {
  BindingDeclaration,
  EffectBindStatement,
  Program,
} from "../ast/types.js";
import { compileString } from "../compiler.js";
import { isExpectedSyntaxError } from "../errors.js";
import { TypeScriptCompilationContext } from "../compiler/typescript-context.js";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";

function offsetToPosition(source: string, offset: number): Position {
  let line = 0;
  let character = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
      character = 0;
    } else {
      character++;
    }
  }
  return { line, character };
}

function isInsideRange(pos: Position, range?: Range): boolean {
  if (!range) return true;
  if (pos.line < range.start.line || pos.line > range.end.line) return false;
  if (pos.line === range.start.line && pos.character < range.start.character)
    return false;
  if (pos.line === range.end.line && pos.character > range.end.character)
    return false;
  return true;
}

function cleanTypeString(typeStr: string): string {
  // Collapse whitespace and long newlines
  return typeStr.replace(/\s+/g, " ").trim();
}

function shouldSkipType(typeStr: string): boolean {
  return (
    !typeStr ||
    typeStr === "unknown" ||
    typeStr === "any" ||
    typeStr === "never" ||
    typeStr === "void"
  );
}

export function findInlayHints(
  source: string,
  uri: string,
  range?: Range,
): InlayHint[] {
  if (!source || source.trim().length === 0) return [];

  let program: Program;
  try {
    const lexer = new Lexer(source, uri);
    const tokens = lexer.tokenize();
    program = new Parser(tokens, uri, source).parse();
  } catch (error) {
    if (!isExpectedSyntaxError(error)) throw error;
    return [];
  }

  const filename = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
  const context = new TypeScriptCompilationContext(filename);
  let checked:
    { checker: ts.TypeChecker; sourceFile: ts.SourceFile } | undefined =
    undefined;
  try {
    const result = Effect.runSync(
      compileString(source, filename, { context, sourcemap: false }),
    );
    checked = context.check(result.typescript);
  } catch (error) {
    if (!isExpectedSyntaxError(error)) throw error;
    return [];
  }

  if (!checked) return [];

  const tsVars = new Map<string, ts.VariableDeclaration[]>();
  const visitTs = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const list = tsVars.get(node.name.text) ?? [];
      list.push(node);
      tsVars.set(node.name.text, list);
    }
    ts.forEachChild(node, visitTs);
  };
  visitTs(checked.sourceFile);

  const hints: InlayHint[] = [];

  const visitAst = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visitAst(item);
      return;
    }
    const n = node as Record<string, unknown>;

    // 1. Top-level and local binding declarations
    if (n.kind === "BindingDeclaration") {
      const decl = node as BindingDeclaration;
      if (decl.id.kind === "Identifier" && !decl.typeAnnotation) {
        const name = decl.id.name;
        const matches = tsVars.get(name);
        if (matches && matches.length === 1) {
          const tsDecl = matches[0];
          if (decl.init.kind === "FunctionExpression") {
            const func = decl.init;
            if (!func.returnType && tsDecl.initializer) {
              const sig = checked.checker.getSignatureFromDeclaration(
                tsDecl.initializer as ts.FunctionLikeDeclaration,
              );
              if (sig) {
                const retType = checked.checker.getReturnTypeOfSignature(sig);
                const retTypeStr = cleanTypeString(
                  checked.checker.typeToString(
                    retType,
                    tsDecl.initializer,
                    ts.TypeFormatFlags.NoTruncation,
                  ),
                );
                if (!shouldSkipType(retTypeStr)) {
                  let parenOffset = -1;
                  if (func.params.length > 0) {
                    const lastParam = func.params[func.params.length - 1];
                    const slice = source.slice(lastParam.span.end.offset);
                    const rel = slice.indexOf(")");
                    if (rel !== -1) {
                      parenOffset = lastParam.span.end.offset + rel + 1;
                    }
                  } else {
                    const slice = source.slice(func.span.start.offset);
                    const rel = slice.indexOf(")");
                    if (rel !== -1) {
                      parenOffset = func.span.start.offset + rel + 1;
                    }
                  }

                  if (parenOffset !== -1) {
                    const pos = offsetToPosition(source, parenOffset);
                    if (isInsideRange(pos, range)) {
                      hints.push({
                        position: pos,
                        label: `: ${retTypeStr}`,
                        kind: InlayHintKind.Type,
                        paddingLeft: false,
                        paddingRight: false,
                      });
                    }
                  }
                }
              }
            }
          } else {
            const sym = checked.checker.getSymbolAtLocation(tsDecl.name);
            if (sym) {
              const type = checked.checker.getTypeOfSymbolAtLocation(
                sym,
                tsDecl.name,
              );
              const typeStr = cleanTypeString(
                checked.checker.typeToString(
                  type,
                  tsDecl.name,
                  ts.TypeFormatFlags.NoTruncation,
                ),
              );
              if (!shouldSkipType(typeStr)) {
                const pos: Position = {
                  line: decl.id.span.end.line - 1,
                  character: decl.id.span.end.column - 1,
                };
                if (isInsideRange(pos, range)) {
                  hints.push({
                    position: pos,
                    label: `: ${typeStr}`,
                    kind: InlayHintKind.Type,
                    paddingLeft: false,
                    paddingRight: false,
                  });
                }
              }
            }
          }
        }
      }
    }

    // 2. EffectBindStatement (user <- Effect.succeed(...))
    if (n.kind === "EffectBindStatement") {
      const bind = node as EffectBindStatement;
      if (bind.id.kind === "Identifier") {
        const name = bind.id.name;
        const matches = tsVars.get(name);
        if (matches && matches.length === 1) {
          const tsDecl = matches[0];
          const sym = checked.checker.getSymbolAtLocation(tsDecl.name);
          if (sym) {
            const type = checked.checker.getTypeOfSymbolAtLocation(
              sym,
              tsDecl.name,
            );
            const typeStr = cleanTypeString(
              checked.checker.typeToString(
                type,
                tsDecl.name,
                ts.TypeFormatFlags.NoTruncation,
              ),
            );
            if (!shouldSkipType(typeStr)) {
              const pos: Position = {
                line: bind.id.span.end.line - 1,
                character: bind.id.span.end.column - 1,
              };
              if (isInsideRange(pos, range)) {
                hints.push({
                  position: pos,
                  label: `: ${typeStr}`,
                  kind: InlayHintKind.Type,
                  paddingLeft: false,
                  paddingRight: false,
                });
              }
            }
          }
        }
      }
    }

    for (const key of Object.keys(n)) {
      if (key === "span") continue;
      visitAst(n[key]);
    }
  };

  visitAst(program);
  return hints;
}
