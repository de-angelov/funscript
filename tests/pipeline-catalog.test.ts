import { readFile } from "node:fs/promises";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as EffectPackage from "effect";
import {
  EFFECT_PIPELINE_CATALOG_VERSION,
  EFFECT_PIPELINE_COMPATIBILITY_ALIASES,
  PIPELINE_COMPANION_CATALOG,
} from "../src/emitter/pipeline-catalog.js";

describe("pipeline companion catalog", () => {
  it("is locked to, and valid for, the installed Effect declaration surface", async () => {
    const effectPackage = JSON.parse(await readFile("node_modules/effect/package.json", "utf8")) as { version: string };
    expect(effectPackage.version).toBe(EFFECT_PIPELINE_CATALOG_VERSION);

    for (const [module, operations] of Object.entries(PIPELINE_COMPANION_CATALOG)) {
      const namespace = EffectPackage[module as keyof typeof EffectPackage] as Record<string, unknown>;
      const declarationPath = `node_modules/effect/dist/${module}.d.ts`;
      const declarations = await readFile(declarationPath, "utf8");
      const declarationFile = ts.createSourceFile(declarationPath, declarations, ts.ScriptTarget.Latest, true);
      const declared = new Map<string, ts.VariableDeclaration | ts.FunctionDeclaration>();
      const exported = new Map<string, ts.VariableDeclaration | ts.FunctionDeclaration>();
      const interfaces = new Map<string, ts.InterfaceDeclaration>();
      for (const statement of declarationFile.statements) {
        if (ts.isInterfaceDeclaration(statement)) interfaces.set(statement.name.text, statement);
        if (ts.isFunctionDeclaration(statement) && statement.name) {
          declared.set(statement.name.text, statement);
          if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) exported.set(statement.name.text, statement);
        }
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name)) continue;
            declared.set(declaration.name.text, declaration);
            if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) exported.set(declaration.name.text, declaration);
          }
        }
      }
      for (const statement of declarationFile.statements) {
        if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
        for (const element of statement.exportClause.elements) {
          const local = (element.propertyName ?? element.name).text;
          const declaration = declared.get(local);
          if (declaration) exported.set(element.name.text, declaration);
        }
      }
      for (const operation of operations) {
        expect(namespace[operation], `${module}.${operation} must be a public Effect export`).toBeTypeOf("function");
        const declaration = exported.get(operation);
        expect(declaration, `${module}.${operation} must be declared`).toBeDefined();
        expect(hasPipelineSignature(declaration!, declarationFile, module, interfaces), `${module}.${operation} must retain a data-first or data-last pipeline signature`).toBe(true);
      }
    }
  });

  it("keeps compatibility aliases mapped to public Effect exports", () => {
    for (const [alias, target] of Object.entries(EFFECT_PIPELINE_COMPATIBILITY_ALIASES)) {
      expect(alias).not.toBe(target);
      expect(EffectPackage.Effect[target as keyof typeof EffectPackage.Effect]).toBeTypeOf("function");
    }
  });
});

function hasPipelineSignature(declaration: ts.VariableDeclaration | ts.FunctionDeclaration, sourceFile: ts.SourceFile, module: string, interfaces: ReadonlyMap<string, ts.InterfaceDeclaration>): boolean {
  const acceptsSelf = (signature: ts.SignatureDeclarationBase): boolean =>
    signature.parameters.some((parameter) => ["self", "from", "schema"].includes(parameter.name.getText(sourceFile)));
  const callableAcceptsSelf = (type: ts.TypeNode | undefined): boolean => {
    if (!type) return false;
    if (ts.isFunctionTypeNode(type)) return acceptsSelf(type) || callableAcceptsSelf(type.type);
    if (ts.isParenthesizedTypeNode(type)) return callableAcceptsSelf(type.type);
    if (ts.isIntersectionTypeNode(type)) return type.types.some(callableAcceptsSelf);
    if (ts.isTypeReferenceNode(type)) {
      const declaration = interfaces.get(type.typeName.getText(sourceFile));
      return Boolean(declaration?.members.some((member) => ts.isCallSignatureDeclaration(member) && acceptsSelf(member)));
    }
    return ts.isTypeLiteralNode(type) && type.members.some((member) =>
      ts.isCallSignatureDeclaration(member) && (acceptsSelf(member) || callableAcceptsSelf(member.type)),
    );
  };
  if (ts.isFunctionDeclaration(declaration)) return acceptsSelf(declaration) || callableAcceptsSelf(declaration.type);
  const type = declaration.type;
  if (!type) return false;
  if (callableAcceptsSelf(type)) return true;
  // Some APIs use a generic first argument constrained to their companion
  // container rather than naming it `self` (for example Stream.flatten).
  return new RegExp(`\\b${module}\\b`).test(type.getText(sourceFile));
}
