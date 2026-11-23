import {
  CodeActionKind,
  type CodeAction,
  type Range,
  type TextEdit,
} from "vscode-languageserver/node";
import type { ImportDeclaration, Program } from "../ast/types.js";
import { Lexer } from "../lexer/lexer.js";
import { TokenType, type Token } from "../lexer/tokens.js";
import { Parser } from "../parser/parser.js";

export const EFFECT_MODULE_EXPORTS = new Set([
  "Array",
  "BigDecimal",
  "BigInt",
  "Boolean",
  "Brand",
  "Cause",
  "Chunk",
  "Clock",
  "Config",
  "Console",
  "Context",
  "Data",
  "DateTime",
  "Deferred",
  "Duration",
  "Effect",
  "Either",
  "Equal",
  "Exit",
  "Fiber",
  "FiberSet",
  "Function",
  "HashMap",
  "HashSet",
  "Layer",
  "LogLevel",
  "Logger",
  "Match",
  "Number",
  "Option",
  "Order",
  "Pipeable",
  "PubSub",
  "Queue",
  "Random",
  "Record",
  "Redacted",
  "Ref",
  "Result",
  "Runtime",
  "Schedule",
  "Schema",
  "Scope",
  "Stream",
  "String",
  "Struct",
  "SubscriptionRef",
  "SynchronizedRef",
  "Tuple",
]);

function getImportSource(decl: ImportDeclaration): string {
  return decl.source.raw.replace(/^["']|["']$/g, "");
}

export function findAutoImportCodeActions(
  source: string,
  uri: string,
  range: Range,
): CodeAction[] {
  if (!source || !source.trim()) return [];

  let tokens: Token[];
  let program: Program;
  try {
    tokens = new Lexer(source, uri).tokenize();
    program = new Parser(tokens, uri, source).parse();
  } catch {
    return [];
  }

  // Find identifier token under cursor/range
  const targetToken = tokens.find((t) => {
    if (
      t.type !== TokenType.IDENTIFIER &&
      t.type !== TokenType.UPPER_IDENTIFIER
    ) {
      return false;
    }
    const line = t.span.start.line - 1;
    const col = t.span.start.column - 1;
    const endCol = t.span.end.column - 1;
    return (
      range.start.line === line &&
      range.start.character >= col &&
      range.start.character <= endCol
    );
  });

  if (!targetToken) return [];
  const symbolName = targetToken.value;

  // Check if it's a known Effect export
  if (!EFFECT_MODULE_EXPORTS.has(symbolName)) return [];

  // Check if already imported
  const importedSymbols = new Set<string>();
  let existingEffectImport: ImportDeclaration | undefined;

  for (const entry of program.body) {
    if (entry.kind === "ImportDeclaration") {
      const decl = entry;
      if (getImportSource(decl) === "effect") {
        existingEffectImport = decl;
      }
      for (const spec of decl.specifiers) {
        importedSymbols.add(spec.local.name);
      }
    }
  }

  if (importedSymbols.has(symbolName)) return [];

  // Check if locally declared in the file
  for (const entry of program.body) {
    const decl = entry.kind === "ExportDeclaration" ? entry.declaration : entry;
    if (
      decl.kind === "SchemaDeclaration" ||
      decl.kind === "ServiceDeclaration" ||
      decl.kind === "ErrorDeclaration"
    ) {
      if ((decl as any).id?.name === symbolName) return [];
    } else if (decl.kind === "BindingDeclaration") {
      if (
        (decl as any).id?.kind === "Identifier" &&
        (decl as any).id.name === symbolName
      ) {
        return [];
      }
    }
  }

  const actions: CodeAction[] = [];

  if (existingEffectImport && existingEffectImport.specifiers.length > 0) {
    // Add to existing import { ... } from "effect"
    const currentSpecs = existingEffectImport.specifiers.map(
      (s) => s.imported.name,
    );
    const updatedSpecs = [...new Set([...currentSpecs, symbolName])].sort();
    const newText = `import { ${updatedSpecs.join(", ")} } from "effect"`;

    actions.push({
      title: `Add import { ${symbolName} } from "effect"`,
      kind: CodeActionKind.QuickFix,
      isPreferred: true,
      edit: {
        changes: {
          [uri]: [
            {
              range: {
                start: {
                  line: existingEffectImport.span.start.line - 1,
                  character: existingEffectImport.span.start.column - 1,
                },
                end: {
                  line: existingEffectImport.span.end.line - 1,
                  character: existingEffectImport.span.end.column - 1,
                },
              },
              newText,
            },
          ],
        },
      },
    });
  } else {
    // Insert new import line at top
    let insertLine = 0;
    const lines = source.split("\n");

    // If other imports exist, insert after the last import
    let lastImportLine = -1;
    for (const entry of program.body) {
      if (entry.kind === "ImportDeclaration") {
        lastImportLine = Math.max(lastImportLine, entry.span.end.line - 1);
      }
    }

    if (lastImportLine !== -1) {
      insertLine = lastImportLine + 1;
    }

    const newText = `import { ${symbolName} } from "effect"\n`;

    actions.push({
      title: `Add import { ${symbolName} } from "effect"`,
      kind: CodeActionKind.QuickFix,
      isPreferred: true,
      edit: {
        changes: {
          [uri]: [
            {
              range: {
                start: { line: insertLine, character: 0 },
                end: { line: insertLine, character: 0 },
              },
              newText:
                lastImportLine === -1 && lines[0]?.startsWith("//")
                  ? "\n" + newText
                  : newText,
            },
          ],
        },
      },
    });
  }

  return actions;
}

export function findRemoveUnusedImportsCodeActions(
  source: string,
  uri: string,
  range: Range,
): CodeAction[] {
  if (!source || !source.trim()) return [];

  let tokens: Token[];
  let program: Program;
  try {
    tokens = new Lexer(source, uri).tokenize();
    program = new Parser(tokens, uri, source).parse();
  } catch {
    return [];
  }

  const importDecls: ImportDeclaration[] = [];
  for (const entry of program.body) {
    if (entry.kind === "ImportDeclaration") {
      importDecls.push(entry);
    }
  }

  if (importDecls.length === 0) return [];

  // Collect all usage tokens outside import statements
  const usages = new Set<string>();
  const isInsideAnyImport = (offset: number) =>
    importDecls.some(
      (decl) =>
        offset >= decl.span.start.offset && offset <= decl.span.end.offset,
    );

  for (const t of tokens) {
    if (
      (t.type === TokenType.IDENTIFIER ||
        t.type === TokenType.UPPER_IDENTIFIER) &&
      !isInsideAnyImport(t.span.start.offset)
    ) {
      usages.add(t.value);
    }
  }

  const lines = source.split("\n");
  const actions: CodeAction[] = [];
  const organizeEdits: TextEdit[] = [];

  for (const decl of importDecls) {
    if (decl.isSideEffect || decl.defaultBinding || decl.namespaceBinding) {
      continue;
    }

    const unusedSpecs = decl.specifiers.filter(
      (s) => !usages.has(s.local.name),
    );
    const usedSpecs = decl.specifiers.filter((s) => usages.has(s.local.name));

    if (unusedSpecs.length === 0) continue;

    const declStartLine = decl.span.start.line - 1;
    const declEndLine = decl.span.end.line - 1;
    const isTargeted =
      range.start.line >= declStartLine && range.end.line <= declEndLine;

    if (usedSpecs.length === 0) {
      // Entire import declaration is unused: delete the whole line
      const lineEndChar = lines[declEndLine]?.length || 0;
      const deleteRange = {
        start: { line: declStartLine, character: 0 },
        end: {
          line: declEndLine + 1 < lines.length ? declEndLine + 1 : declEndLine,
          character: declEndLine + 1 < lines.length ? 0 : lineEndChar,
        },
      };

      organizeEdits.push({ range: deleteRange, newText: "" });

      if (isTargeted) {
        actions.push({
          title: `Remove unused import from "${getImportSource(decl)}"`,
          kind: CodeActionKind.QuickFix,
          isPreferred: true,
          edit: {
            changes: { [uri]: [{ range: deleteRange, newText: "" }] },
          },
        });
      }
    } else {
      // Partially unused: rewrite specifier list
      const updatedSpecs = usedSpecs.map((s) =>
        s.imported.name === s.local.name
          ? s.imported.name
          : `${s.imported.name} as ${s.local.name}`,
      );
      const newText = `import { ${updatedSpecs.join(", ")} } from ${decl.source.raw}`;
      const editRange = {
        start: {
          line: declStartLine,
          character: decl.span.start.column - 1,
        },
        end: {
          line: declEndLine,
          character: decl.span.end.column - 1,
        },
      };

      organizeEdits.push({ range: editRange, newText });

      if (isTargeted) {
        const unusedNames = unusedSpecs.map((s) => s.local.name).join(", ");
        actions.push({
          title: `Remove unused import '${unusedNames}'`,
          kind: CodeActionKind.QuickFix,
          isPreferred: true,
          edit: {
            changes: { [uri]: [{ range: editRange, newText }] },
          },
        });
      }
    }
  }

  if (organizeEdits.length > 0) {
    actions.push({
      title: "Remove all unused imports",
      kind: CodeActionKind.SourceOrganizeImports,
      edit: {
        changes: { [uri]: organizeEdits },
      },
    });
  }

  return actions;
}
