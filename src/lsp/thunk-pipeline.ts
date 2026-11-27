import {
  CodeActionKind,
  type CodeAction,
  type Range,
} from "vscode-languageserver/node";
import type { CallExpression, FunctionExpression } from "../ast/types.js";
import { walkAst } from "../ast/walk.js";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { isExpectedSyntaxError } from "../errors.js";

const THUNK_CONSTRUCTORS = new Set([
  "sync",
  "try",
  "tryPromise",
  "promise",
  "suspend",
  "failSync",
]);

/** Offer a semantics-preserving refactor for single-expression Effect thunks. */
export function findThunkPipelineCodeActions(
  source: string,
  uri: string,
  range: Range,
): CodeAction[] {
  if (!/\(\s*\)/.test(source)) return [];
  let program;
  try {
    program = new Parser(
      new Lexer(source, uri).tokenize(),
      uri,
      source,
    ).parse();
  } catch (error) {
    if (!isExpectedSyntaxError(error)) throw error;
    return [];
  }
  const lines = source.split("\n");
  const offset = (position: Range["start"]) =>
    lines.slice(0, position.line).reduce((n, line) => n + line.length + 1, 0) +
    position.character;
  const start = offset(range.start);
  const end = offset(range.end);
  const candidates: CallExpression[] = [];
  walkAst(program, (node) => {
    if (node.kind !== "CallExpression") return;
    const call = node as unknown as CallExpression;
    if (call.span.start.offset > end || call.span.end.offset < start) return;
    const simpleFunction = call.callee.kind === "Identifier";
    const effectConstructor =
      call.callee.kind === "MemberExpression" &&
      call.callee.object.kind === "UpperIdentifier" &&
      call.callee.object.name === "Effect" &&
      THUNK_CONSTRUCTORS.has(call.callee.property.name);
    if (!simpleFunction && !effectConstructor) return;
    if (call.args.length !== 1 || call.args[0].kind !== "FunctionExpression")
      return;
    const fn = call.args[0];
    if (
      fn.params.length ||
      fn.typeParams?.length ||
      fn.returnType ||
      fn.body.kind === "BlockStatement"
    )
      return;
    const beforeBody = source.slice(
      call.callee.span.end.offset,
      fn.body.span.start.offset,
    );
    const afterBody = source.slice(
      fn.body.span.end.offset,
      call.span.end.offset,
    );
    if (/\/\/|\/\*/.test(beforeBody + afterBody)) return;
    candidates.push(call);
  });
  candidates.sort(
    (a, b) =>
      a.span.end.offset -
      a.span.start.offset -
      (b.span.end.offset - b.span.start.offset),
  );
  const call = candidates[0];
  if (!call) return [];
  const fn = call.args[0] as FunctionExpression;
  const body = source.slice(fn.body.span.start.offset, fn.body.span.end.offset);
  const callee = source.slice(
    call.callee.span.start.offset,
    call.callee.span.end.offset,
  );
  return [
    {
      title: "Convert to deferred pipeline (|>>)",
      kind: CodeActionKind.RefactorRewrite,
      edit: {
        changes: {
          [uri]: [
            {
              range: {
                start: {
                  line: call.span.start.line - 1,
                  character: call.span.start.column - 1,
                },
                end: {
                  line: call.span.end.line - 1,
                  character: call.span.end.column - 1,
                },
              },
              newText: `((${body}) |>> ${callee})`,
            },
          ],
        },
      },
    },
  ];
}
