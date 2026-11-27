import {
  type CodeAction,
  CodeActionKind,
  type Diagnostic,
  type Range,
} from "vscode-languageserver/node";

export function findErrorChannelCodeActions(
  source: string,
  uri: string,
  range: Range,
  diagnostics: Diagnostic[] = [],
): CodeAction[] {
  const actions: CodeAction[] = [];
  const lines = source.split("\n");
  for (const diagnostic of diagnostics) {
    const message =
      typeof diagnostic.message === "string" ? diagnostic.message : "";
    const match = message.match(
      /Effect error channel mismatch: expected (.+), got (.+)\./,
    );
    if (!match) continue;
    const expected = match[1].trim();
    const actual = match[2].trim();
    const diagRange = diagnostic.range ?? range;
    const lineIndex = diagRange.start.line;
    const line = lines[lineIndex];
    if (!line) continue;

    const patterns = [
      new RegExp(
        `(Effect(?:\\.Effect)?<[^,]*,\\s*)${escapeRegExp(expected)}(\\s*,[^>]*>)`,
      ),
    ];
    let newLine: string | null = null;
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        newLine = line.replace(pattern, `$1${actual}$2`);
        break;
      }
    }
    if (!newLine || newLine === line) continue;

    const fullRange: Range = {
      start: { line: lineIndex, character: 0 },
      end: { line: lineIndex, character: line.length },
    };
    actions.push({
      title: `Widen declared error type to ${actual}`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      isPreferred: true,
      edit: {
        changes: { [uri]: [{ range: fullRange, newText: newLine }] },
      },
    });
  }
  return actions;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
