import ts from "typescript";
import path from "node:path";
import fs from "node:fs";
import type { Program, Span } from "../ast/types.js";
import { Emitter, type EmitterOptions } from "../emitter/emitter.js";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { FunScriptError } from "../errors.js";
import { TypeScriptCompilationContext } from "./typescript-context.js";

/** Determine optional argument conversions from types, never from runtime shape. */
export function resolveOptionalArguments(ast: Program, context: TypeScriptCompilationContext, options: EmitterOptions, filename: string, virtualSources?: ReadonlyMap<string, string>): { arguments: ReadonlySet<number>; properties: ReadonlySet<number> } {
  const spans = new Map<number, Span>();
  const collect = (value: any): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (value.span?.start) spans.set(value.span.start.offset, value.span);
    if (value.kind === "CallExpression") for (const arg of value.args) spans.set(arg.span.start.offset, arg.span);
    for (const [key, child] of Object.entries(value)) if (key !== "span") collect(child);
  };
  collect(ast);
  if (!spans.size) return { arguments: new Set(), properties: new Set() };
  const auxiliary = new Map<string, string>();
  const known = new Map(virtualSources ?? []);
  // Resolve direct relative imports when compiling a single on-disk file.
  for (const item of ast.body) {
    if (item.kind !== "ImportDeclaration" || item.source.parts.length !== 1 || item.source.parts[0].kind !== "StringRawPart") continue;
    const specifier = item.source.parts[0].value;
    if (!specifier.startsWith(".") || !specifier.endsWith(".js")) continue;
    const base = path.resolve(path.dirname(filename), specifier.slice(0, -3));
    for (const ext of [".fun", ".funx"]) {
      const file = base + ext;
      if (!known.has(file) && fs.existsSync(file)) known.set(file, fs.readFileSync(file, "utf8"));
    }
  }
  for (const [file, source] of known) {
    if (path.resolve(file) === path.resolve(filename) || !/\.funx?$/.test(file)) continue;
    try {
      const imported = new Parser(new Lexer(source, file).tokenize(), file, source).parse();
      auxiliary.set(file.replace(/\.funx?$/, file.endsWith(".funx") ? ".tsx" : ".ts"), new Emitter(imported, undefined, { allowAmbiguousPipeline: true, isJsx: file.endsWith(".funx") }).emit());
    } catch { /* Unresolvable imports are handled by the regular compiler diagnostics. */ }
  }
  const marked = new Emitter(ast, undefined, { ...options, markCallArguments: true, allowAmbiguousPipeline: true }).emit();
  if (!marked.includes("__funscriptCallArgument(")) return { arguments: new Set(), properties: new Set() };
  context.setAuxiliarySources(auxiliary);
  try {
    const checked = context.check(marked + "\nfunction __funscriptCallArgument<T>(_offset: number, value: T): T { return value; }\n");
    if (!checked) return { arguments: new Set(), properties: new Set() };
    const { sourceFile, checker } = checked;
    const result = new Set<number>();
    const properties = new Set<number>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "__funscriptCallArgument" && ts.isNumericLiteral(node.arguments[0]) && (ts.isPropertyAssignment(node.parent) || ts.isJsxExpression(node.parent))) {
        let target = checker.getContextualType(node);
        let declaredOptional = false;
        // The call-argument marker is generic, so an object literal inside it
        // can otherwise acquire its own inferred type instead of the callee's.
        if (ts.isPropertyAssignment(node.parent) && ts.isObjectLiteralExpression(node.parent.parent)) {
          const object = node.parent.parent;
          const wrapper = object.parent;
          if (ts.isIdentifier(node.parent.name)) {
            const objectTarget = ts.isCallExpression(wrapper) && ts.isIdentifier(wrapper.expression) && wrapper.expression.text === "__funscriptCallArgument" ? checker.getContextualType(wrapper) : checker.getContextualType(object);
            const property = objectTarget && checker.getPropertyOfType(objectTarget, node.parent.name.text);
            if (property) {
              target = checker.getTypeOfSymbolAtLocation(property, node.parent);
              declaredOptional = Boolean(property.flags & ts.SymbolFlags.Optional);
            }
          }
        }
        if (ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent)) {
          const attribute = node.parent.parent;
          const opening = attribute.parent.parent;
          if ((ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) && ts.isIdentifier(attribute.name)) {
            const props = checker.getResolvedSignature(opening)?.getParameters()[0];
            const propsType = props && checker.getTypeOfSymbolAtLocation(props, opening);
            const property = propsType && checker.getPropertyOfType(propsType, attribute.name.text);
            if (property) {
              target = checker.getTypeOfSymbolAtLocation(property, attribute);
              declaredOptional = Boolean(property.flags & ts.SymbolFlags.Optional);
            }
          }
        }
        const value = node.arguments[1];
        const type = checker.getTypeAtLocation(value);
        const optional = declaredOptional || (target?.isUnion() && target.types.some(t => Boolean(t.flags & ts.TypeFlags.Undefined)));
        if (target && optional && checker.getPropertyOfType(type, "~effect/Option")) {
          const explicitSome = ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) && ts.isIdentifier(value.expression.expression) && value.expression.expression.text === "Option" && value.expression.name.text === "some";
          const offset = Number(node.arguments[0].text);
          if (checker.isTypeAssignableTo(type, target) && !explicitSome) throw new FunScriptError("Ambiguous optional property: use Option.some(value) to pass the Option as a value, or an explicit boundary adapter to forward it", spans.get(offset));
          properties.add(offset);
        }
      }
      if (ts.isCallExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        node.arguments.forEach((argument, index) => {
          if (!ts.isCallExpression(argument) || !ts.isIdentifier(argument.expression) || argument.expression.text !== "__funscriptCallArgument" || !ts.isNumericLiteral(argument.arguments[0])) return;
          const parameter = signature?.getParameters()[index];
          if (!parameter?.name.startsWith("$funscriptOptional")) return;
          const value = argument.arguments[1];
          const type = checker.getTypeAtLocation(value);
          if (!checker.getPropertyOfType(type, "~effect/Option")) return;
          const target = checker.getTypeOfSymbolAtLocation(parameter, node);
          const explicitSome = ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) && ts.isIdentifier(value.expression.expression) && value.expression.expression.text === "Option" && value.expression.name.text === "some";
          const offset = Number(argument.arguments[0].text);
          if (checker.isTypeAssignableTo(type, target) && !explicitSome) {
            throw new FunScriptError("Ambiguous optional argument: use Option.getOrUndefined(value) to forward it, or Option.some(value) to pass it as a value", spans.get(offset));
          }
          const payload = type.aliasTypeArguments?.[0];
          const mayContainUndefined = (t: ts.Type): boolean => t.isUnion() ? t.types.some(mayContainUndefined) : Boolean(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Any | ts.TypeFlags.Unknown));
          if (!payload || mayContainUndefined(payload)) {
            throw new FunScriptError("Cannot automatically forward an Option that may contain undefined: normalize it explicitly or use a presence-preserving boundary", spans.get(offset));
          }
          result.add(offset);
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return { arguments: result, properties };
  } finally { context.setAuxiliarySources(new Map()); }
}
