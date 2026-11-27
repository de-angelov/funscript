import { readFile } from "node:fs/promises";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as EffectPackage from "effect";
import * as HttpPackage from "effect/http";
import { compileString } from "../src/compiler.js";
import { typeCheckSource } from "../src/compiler/check.js";
import {
  COMPANION_IMPORT_SOURCE,
  EFFECT_PIPELINE_CATALOG_VERSION,
  PIPELINE_COMPANION_CATALOG,
  pipelineCompanionCandidates,
} from "../src/emitter/pipeline-catalog.js";

describe("pipeline companion catalog", () => {
  it("is locked to, and valid for, the installed Effect declaration surface", async () => {
    const effectPackage = JSON.parse(
      await readFile("node_modules/effect/package.json", "utf8"),
    ) as { version: string };
    expect(effectPackage.version).toBe(EFFECT_PIPELINE_CATALOG_VERSION);

    for (const [module, operations] of Object.entries(
      PIPELINE_COMPANION_CATALOG,
    )) {
      const importSource = COMPANION_IMPORT_SOURCE[module] ?? "effect";
      const namespace = (
        importSource === "effect/http" ? HttpPackage : EffectPackage
      )[module as keyof typeof EffectPackage] as Record<string, unknown>;
      const declarationPath =
        importSource === "effect/http"
          ? `node_modules/effect/dist/http/${module}.d.ts`
          : `node_modules/effect/dist/${module}.d.ts`;
      const declarations = await readFile(declarationPath, "utf8");
      const declarationFile = ts.createSourceFile(
        declarationPath,
        declarations,
        ts.ScriptTarget.Latest,
        true,
      );
      const declared = new Map<
        string,
        ts.VariableDeclaration | ts.FunctionDeclaration
      >();
      const exported = new Map<
        string,
        ts.VariableDeclaration | ts.FunctionDeclaration
      >();
      const interfaces = new Map<string, ts.InterfaceDeclaration>();
      for (const statement of declarationFile.statements) {
        if (ts.isInterfaceDeclaration(statement))
          interfaces.set(statement.name.text, statement);
        if (ts.isFunctionDeclaration(statement) && statement.name) {
          declared.set(statement.name.text, statement);
          if (
            statement.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
            )
          )
            exported.set(statement.name.text, statement);
        }
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name)) continue;
            declared.set(declaration.name.text, declaration);
            if (
              statement.modifiers?.some(
                (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
              )
            )
              exported.set(declaration.name.text, declaration);
          }
        }
      }
      for (const statement of declarationFile.statements) {
        if (
          !ts.isExportDeclaration(statement) ||
          !statement.exportClause ||
          !ts.isNamedExports(statement.exportClause)
        )
          continue;
        for (const element of statement.exportClause.elements) {
          const local = (element.propertyName ?? element.name).text;
          const declaration = declared.get(local);
          if (declaration) exported.set(element.name.text, declaration);
        }
      }
      for (const operation of operations) {
        expect(
          namespace[operation],
          `${module}.${operation} must be a public Effect export`,
        ).toBeTypeOf("function");
        const declaration = exported.get(operation);
        expect(
          declaration,
          `${module}.${operation} must be declared`,
        ).toBeDefined();
        expect(
          hasPipelineSignature(
            declaration!,
            declarationFile,
            module,
            interfaces,
          ),
          `${module}.${operation} must retain a data-first or data-last pipeline signature`,
        ).toBe(true);
      }
    }
  });

  it("registers decode as an auto-resolving Schema pipeline companion", () => {
    expect(PIPELINE_COMPANION_CATALOG.Schema).toContain("decode");
    expect(pipelineCompanionCandidates("decode")).toEqual(["Schema"]);
  });

  it("resolves bare pipeline stages for Config and effect/http companions", async () => {
    const configSource = `import { Config } from "effect"
export host = Config.String("HOST") |> withDefault("127.0.0.1")
export port = Config.Port("PORT") |> withDefault(3000)`;
    const configCompiled = await Effect.runPromise(
      compileString(configSource, "config-pipe.fun"),
    );
    expect(configCompiled.typescript).toContain("Config.withDefault");
    const configChecked = await Effect.runPromise(
      typeCheckSource(configSource, "config-pipe.fun"),
    );
    expect(configChecked.success, configChecked.formattedOutput).toBe(true);

    const httpSource = `import { HttpClientRequest } from "effect/http"
export req = HttpClientRequest.get("/users") |> setHeader("accept", "application/json")`;
    const httpCompiled = await Effect.runPromise(
      compileString(httpSource, "http-pipe.fun"),
    );
    expect(httpCompiled.typescript).toContain("HttpClientRequest.setHeader");
    const httpChecked = await Effect.runPromise(
      typeCheckSource(httpSource, "http-pipe.fun"),
    );
    expect(httpChecked.success, httpChecked.formattedOutput).toBe(true);
  });
});

function hasPipelineSignature(
  declaration: ts.VariableDeclaration | ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  module: string,
  interfaces: ReadonlyMap<string, ts.InterfaceDeclaration>,
): boolean {
  const acceptsSelf = (signature: ts.SignatureDeclarationBase): boolean =>
    signature.parameters.some((parameter) =>
      ["self", "from", "schema"].includes(parameter.name.getText(sourceFile)),
    );
  const callableAcceptsSelf = (type: ts.TypeNode | undefined): boolean => {
    if (!type) return false;
    if (ts.isFunctionTypeNode(type))
      return acceptsSelf(type) || callableAcceptsSelf(type.type);
    if (ts.isParenthesizedTypeNode(type)) return callableAcceptsSelf(type.type);
    if (ts.isIntersectionTypeNode(type))
      return type.types.some(callableAcceptsSelf);
    if (ts.isTypeReferenceNode(type)) {
      const declaration = interfaces.get(type.typeName.getText(sourceFile));
      return Boolean(
        declaration?.members.some(
          (member) =>
            ts.isCallSignatureDeclaration(member) && acceptsSelf(member),
        ),
      );
    }
    return (
      ts.isTypeLiteralNode(type) &&
      type.members.some(
        (member) =>
          ts.isCallSignatureDeclaration(member) &&
          (acceptsSelf(member) || callableAcceptsSelf(member.type)),
      )
    );
  };
  if (ts.isFunctionDeclaration(declaration))
    return acceptsSelf(declaration) || callableAcceptsSelf(declaration.type);
  const type = declaration.type;
  if (!type) return false;
  if (callableAcceptsSelf(type)) return true;
  // Some APIs use a generic first argument constrained to their companion
  // container rather than naming it `self` (for example Stream.flatten).
  return new RegExp(`\\b${module}\\b`).test(type.getText(sourceFile));
}
