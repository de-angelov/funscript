import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { Program, Span } from "../ast/types.js";
import { walkAst } from "../ast/walk.js";
import { Emitter, type EmitterOptions } from "../emitter/emitter.js";
import { FunScriptError } from "../errors.js";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { type TypeScriptCompilationContext } from "./typescript-context.js";

/** Determine optional argument conversions from types, never from runtime shape. */
export function resolveOptionalArguments(
  ast: Program,
  context: TypeScriptCompilationContext,
  options: EmitterOptions,
  filename: string,
  virtualSources?: ReadonlyMap<string, string>,
): {
  arguments: ReadonlySet<number>;
  nullArguments: ReadonlySet<number>;
  properties: ReadonlySet<number>;
  nullProperties: ReadonlySet<number>;
} {
  const spans = new Map<number, Span>();
  walkAst(ast, (node) => {
    const span = node.span as Span | undefined;
    if (span?.start) spans.set(span.start.offset, span);
    if (node.kind === "CallExpression" && Array.isArray(node.args)) {
      for (const arg of node.args as Array<{ span: Span }>) {
        spans.set(arg.span.start.offset, arg.span);
      }
    }
  });
  if (!spans.size)
    return {
      arguments: new Set(),
      nullArguments: new Set(),
      properties: new Set(),
      nullProperties: new Set(),
    };
  const auxiliary = new Map<string, string>();
  const known = new Map(virtualSources ?? []);
  // Resolve transitive relative imports when compiling a single on-disk file.
  const queue = [filename];
  const visited = new Set<string>([path.resolve(filename)]);
  while (queue.length > 0) {
    const currentFile = queue.shift()!;
    let currentAst: Program;
    if (path.resolve(currentFile) === path.resolve(filename)) {
      currentAst = ast;
    } else {
      const src = known.get(currentFile);
      if (!src) continue;
      try {
        currentAst = new Parser(
          new Lexer(src, currentFile).tokenize(),
          currentFile,
          src,
        ).parse();
      } catch (error) {
        if (!(error instanceof FunScriptError)) throw error;
        continue;
      }
    }
    for (const item of currentAst.body) {
      if (
        item.kind !== "ImportDeclaration" ||
        item.source.parts.length !== 1 ||
        item.source.parts[0].kind !== "StringRawPart"
      )
        continue;
      const specifier = item.source.parts[0].value;
      if (!specifier.startsWith(".") || !specifier.endsWith(".js")) continue;
      const base = path.resolve(
        path.dirname(currentFile),
        specifier.slice(0, -3),
      );
      for (const ext of [".fun", ".funx"]) {
        const file = base + ext;
        const norm = path.resolve(file);
        if (!visited.has(norm) && fs.existsSync(file)) {
          visited.add(norm);
          known.set(file, fs.readFileSync(file, "utf8"));
          queue.push(file);
        }
      }
    }
  }
  for (const [file, source] of known) {
    if (path.resolve(file) === path.resolve(filename) || !/\.funx?$/.test(file))
      continue;
    try {
      const imported = new Parser(
        new Lexer(source, file).tokenize(),
        file,
        source,
      ).parse();
      auxiliary.set(
        file.replace(/\.funx?$/, file.endsWith(".funx") ? ".tsx" : ".ts"),
        new Emitter(imported, undefined, {
          allowAmbiguousPipeline: true,
          isJsx: file.endsWith(".funx"),
        }).emit(),
      );
    } catch (error) {
      /* Unresolvable imports are handled by the regular compiler diagnostics. */
      if (!(error instanceof FunScriptError)) throw error;
    }
  }
  const marked = new Emitter(ast, undefined, {
    ...options,
    markCallArguments: true,
    allowAmbiguousPipeline: true,
  }).emit();
  if (!marked.includes("__funscriptCallArgument("))
    return {
      arguments: new Set(),
      nullArguments: new Set(),
      properties: new Set(),
      nullProperties: new Set(),
    };
  context.setAuxiliarySources(auxiliary);
  try {
    const checked = context.check(
      marked +
        "\nfunction __funscriptCallArgument<T>(_offset: number, value: T): T { return value; }\n",
    );
    if (!checked)
      return {
        arguments: new Set(),
        nullArguments: new Set(),
        properties: new Set(),
        nullProperties: new Set(),
      };
    const { sourceFile, checker } = checked;
    const result = new Set<number>();
    const nullArguments = new Set<number>();
    const properties = new Set<number>();
    const nullProperties = new Set<number>();
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "__funscriptCallArgument" &&
        ts.isNumericLiteral(node.arguments[0]) &&
        (ts.isPropertyAssignment(node.parent) ||
          ts.isJsxExpression(node.parent))
      ) {
        let target = checker.getContextualType(node);
        let declaredOptional = false;
        // The call-argument marker is generic, so an object literal inside it
        // can otherwise acquire its own inferred type instead of the callee's.
        if (
          ts.isPropertyAssignment(node.parent) &&
          ts.isObjectLiteralExpression(node.parent.parent)
        ) {
          const object = node.parent.parent;
          const wrapper = object.parent;
          if (ts.isIdentifier(node.parent.name)) {
            const objectTarget =
              ts.isCallExpression(wrapper) &&
              ts.isIdentifier(wrapper.expression) &&
              wrapper.expression.text === "__funscriptCallArgument"
                ? checker.getContextualType(wrapper)
                : checker.getContextualType(object);
            const property =
              objectTarget &&
              checker.getPropertyOfType(objectTarget, node.parent.name.text);
            if (property) {
              target = checker.getTypeOfSymbolAtLocation(property, node.parent);
              declaredOptional = Boolean(
                property.flags & ts.SymbolFlags.Optional,
              );
            }
          }
        }
        if (
          ts.isJsxExpression(node.parent) &&
          ts.isJsxAttribute(node.parent.parent)
        ) {
          const attribute = node.parent.parent;
          const opening = attribute.parent.parent;
          if (
            (ts.isJsxOpeningElement(opening) ||
              ts.isJsxSelfClosingElement(opening)) &&
            ts.isIdentifier(attribute.name)
          ) {
            const props = checker
              .getResolvedSignature(opening)
              ?.getParameters()[0];
            const propsType =
              props && checker.getTypeOfSymbolAtLocation(props, opening);
            const property =
              propsType &&
              checker.getPropertyOfType(propsType, attribute.name.text);
            if (property) {
              target = checker.getTypeOfSymbolAtLocation(property, attribute);
              declaredOptional = Boolean(
                property.flags & ts.SymbolFlags.Optional,
              );
            }
          }
        }
        const value = node.arguments[1];
        const type = checker.getTypeAtLocation(value);
        const optional =
          declaredOptional ||
          (target?.isUnion()
            ? target.types.some((t) =>
                Boolean(t.flags & ts.TypeFlags.Undefined),
              )
            : Boolean(target && target.flags & ts.TypeFlags.Undefined));
        const includesNull = target?.isUnion()
          ? target.types.some((t) => Boolean(t.flags & ts.TypeFlags.Null))
          : Boolean(target && target.flags & ts.TypeFlags.Null);
        if (
          target &&
          (optional || includesNull) &&
          checker.getPropertyOfType(type, "~effect/Option")
        ) {
          const explicitSome =
            ts.isCallExpression(value) &&
            ts.isPropertyAccessExpression(value.expression) &&
            ts.isIdentifier(value.expression.expression) &&
            value.expression.expression.text === "Option" &&
            value.expression.name.text === "some";
          const offset = Number(node.arguments[0].text);
          if (checker.isTypeAssignableTo(type, target) && !explicitSome)
            throw new FunScriptError(
              "Ambiguous optional property: use Option.some(value) to pass the Option as a value, or an explicit boundary adapter to forward it",
              spans.get(offset),
            );
          if (includesNull && !optional) {
            nullProperties.add(offset);
          } else {
            properties.add(offset);
          }
        }
      }
      if (ts.isCallExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        node.arguments.forEach((argument, index) => {
          if (
            !ts.isCallExpression(argument) ||
            !ts.isIdentifier(argument.expression) ||
            argument.expression.text !== "__funscriptCallArgument" ||
            !ts.isNumericLiteral(argument.arguments[0])
          )
            return;
          const parameter = signature?.getParameters()[index];
          if (!parameter) return;
          const isFunscriptOptional =
            parameter.name.startsWith("$funscriptOptional");
          const declaredOptional =
            Boolean(parameter.flags & ts.SymbolFlags.Optional) ||
            Boolean(
              (
                parameter.valueDeclaration as
                  ts.ParameterDeclaration | undefined
              )?.questionToken,
            );
          const target = checker.getTypeOfSymbolAtLocation(parameter, node);
          const includesUndefined = target.isUnion()
            ? target.types.some((t) =>
                Boolean(t.flags & ts.TypeFlags.Undefined),
              )
            : Boolean(target.flags & ts.TypeFlags.Undefined);
          const includesNull = target.isUnion()
            ? target.types.some((t) => Boolean(t.flags & ts.TypeFlags.Null))
            : Boolean(target.flags & ts.TypeFlags.Null);
          const isOptional =
            isFunscriptOptional || declaredOptional || includesUndefined;
          if (!isOptional && !includesNull) return;
          const targetAcceptsOption = target.isUnion()
            ? target.types.some((t) =>
                Boolean(checker.getPropertyOfType(t, "~effect/Option")),
              )
            : Boolean(checker.getPropertyOfType(target, "~effect/Option"));
          if (targetAcceptsOption) return;
          const value = argument.arguments[1];
          const type = checker.getTypeAtLocation(value);
          if (!checker.getPropertyOfType(type, "~effect/Option")) return;
          const explicitSome =
            ts.isCallExpression(value) &&
            ts.isPropertyAccessExpression(value.expression) &&
            ts.isIdentifier(value.expression.expression) &&
            value.expression.expression.text === "Option" &&
            value.expression.name.text === "some";
          const offset = Number(argument.arguments[0].text);
          if (checker.isTypeAssignableTo(type, target) && !explicitSome) {
            throw new FunScriptError(
              "Ambiguous optional argument: use Option.getOrUndefined(value) to forward it, or Option.some(value) to pass it as a value",
              spans.get(offset),
            );
          }
          const payload = type.aliasTypeArguments?.[0];
          const mayContainUndefined = (t: ts.Type): boolean =>
            t.isUnion()
              ? t.types.some(mayContainUndefined)
              : Boolean(
                  t.flags &
                  (ts.TypeFlags.Undefined |
                    ts.TypeFlags.Any |
                    ts.TypeFlags.Unknown),
                );
          if (!payload || mayContainUndefined(payload)) {
            throw new FunScriptError(
              "Cannot automatically forward an Option that may contain undefined: normalize it explicitly or use a presence-preserving boundary",
              spans.get(offset),
            );
          }
          if (includesNull && !isOptional) {
            nullArguments.add(offset);
          } else {
            result.add(offset);
          }
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return { arguments: result, nullArguments, properties, nullProperties };
  } finally {
    context.setAuxiliarySources(new Map());
  }
}
