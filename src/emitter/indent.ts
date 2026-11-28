import ts from "typescript";

/** Indent continuation lines without changing the contents of template literals. */
export function indentContinuation(code: string, spaces: number): string {
  if (!code.includes("\n")) return code;
  const prefix = "function __indent() {\n";
  const source = ts.createSourceFile(
    "indent.tsx",
    `${prefix}${code}\n}`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const protectedRanges: Array<[number, number]> = [];
  const visit = (node: ts.Node): void => {
    if (
      node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      node.kind === ts.SyntaxKind.StringLiteral ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail ||
      node.kind === ts.SyntaxKind.JsxText ||
      node.kind === ts.SyntaxKind.JsxTextAllWhiteSpaces
    ) {
      protectedRanges.push([
        node.getStart(source) - prefix.length,
        node.end - prefix.length,
      ]);
      return;
    }
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return code.replace(/\n/g, (newline, offset: number) =>
    protectedRanges.some(([start, end]) => offset >= start && offset < end)
      ? newline
      : newline + " ".repeat(spaces),
  );
}
