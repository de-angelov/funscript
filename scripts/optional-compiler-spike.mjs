// THROWAWAY: Can TypeScript resolve optional calls across FunScript modules and
// map ambiguous arguments back to the original source? Run after npm run build.
import ts from "typescript";
import path from "node:path";
import { Effect } from "effect";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { compileString } from "../dist/compiler.js";
import { Emitter } from "../dist/emitter/emitter.js";

const root = path.resolve(".");
const sources = {
  "__optional_spike_reader.fun": 'export read = (name?: String) => name\nexport inspect = (value?: Unknown) => value\nexport nested = (value?: Option<String>) => value\n',
  "__optional_spike_caller.fun": 'import { Option } from "effect"\nimport { read, inspect, nested } from "./__optional_spike_reader.js"\nlocal = (name?: String) => name\nexport forward = (name?: String) => local(name)\nexport imported = (name?: String) => read(name)\nexport ambiguous = (value: Option<String>) => inspect(value)\nexport nestedCall = (value: Option<String>) => nested(value)\n',
};
const virtualSources = new Map(Object.entries(sources).map(([name, source]) => [path.join(root, name), source]));
const files = new Map();
for (const [name, source] of Object.entries(sources)) {
  const sourcePath = path.join(root, name);
  const result = await Effect.runPromise(compileString(source, sourcePath, { virtualSources, sourcemap: true }));
  const marked = name.includes("caller")
    ? new Emitter(result.ast, undefined, { markCallArguments: true, allowAmbiguousPipeline: true }).emit() + '\nfunction __funscriptCallArgument<T>(_offset: number, value: T): T { return value; }\n'
    : result.typescript;
  files.set(sourcePath.replace(/\.fun$/, ".ts"), { text: marked, map: new TraceMap(result.map.toString()) });
}

const options = { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true, noEmit: true };
const host = ts.createCompilerHost(options);
const readFile = host.readFile.bind(host);
const fileExists = host.fileExists.bind(host);
const getSourceFile = host.getSourceFile.bind(host);
host.fileExists = file => files.has(path.resolve(file)) || fileExists(file);
host.readFile = file => files.get(path.resolve(file))?.text ?? readFile(file);
host.getSourceFile = (file, version, onError, shouldCreateNewSourceFile) => {
  const virtual = files.get(path.resolve(file));
  return virtual ? ts.createSourceFile(file, virtual.text, version, true) : getSourceFile(file, version, onError, shouldCreateNewSourceFile);
};
const program = ts.createProgram([...files.keys()], options, host);
const checker = program.getTypeChecker();
const source = program.getSourceFile(path.join(root, "__optional_spike_caller.ts"));
if (!source) throw new Error("virtual caller not found");

const findings = [];
function visit(node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["local", "read", "inspect", "nested"].includes(node.expression.text)) {
    const signature = checker.getResolvedSignature(node);
    const parameter = signature?.getParameters()[0];
    const argument = node.arguments[0];
    if (!parameter || !argument) throw new Error(`Unable to resolve ${node.expression.text}`);
    if (!ts.isCallExpression(argument) || !ts.isNumericLiteral(argument.arguments[0])) throw new Error("Missing source marker");
    const argType = checker.getTypeAtLocation(argument.arguments[1]);
    const paramType = checker.getTypeOfSymbolAtLocation(parameter, node);
    const generated = source.getLineAndCharacterOfPosition(argument.getStart(source));
    const mapped = originalPositionFor(files.get(path.join(root, "__optional_spike_caller.ts")).map, { line: generated.line + 1, column: generated.character });
    const expectedLine = { local: 4, read: 5, inspect: 6, nested: 7 }[node.expression.text];
    const sourceOffset = Number(argument.arguments[0].text);
    const markedLine = sources["__optional_spike_caller.fun"].slice(0, sourceOffset).split("\n").length;
    findings.push({ call: node.expression.text, parameter: parameter.name, argumentType: checker.typeToString(argType), parameterType: checker.typeToString(paramType), argumentAlsoFitsAsValue: checker.isTypeAssignableTo(argType, paramType), markerSourceLine: markedLine, expectedSourceLine: expectedLine, accurateSourceLine: markedLine === expectedLine, sourceMapLine: mapped.line });
  }
  ts.forEachChild(node, visit);
}
visit(source);
console.log(JSON.stringify({ findings, interpretation: "Source markers retain argument locations through the checker for these examples. Type assignability alone is not a complete forwarding algorithm." }, null, 2));
if (findings.length !== 4 || findings.some(f => !f.parameter.startsWith("$funscriptOptional") || !f.accurateSourceLine) || findings.slice(0, 2).some(f => f.argumentAlsoFitsAsValue) || findings.slice(2).some(f => !f.argumentAlsoFitsAsValue)) process.exitCode = 1;
