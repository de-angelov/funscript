import type { ExportFromDeclaration, ImportDeclaration } from "../ast/types.js";

/** Render an import while preserving the distinction between `import {}` and a bare import. */
export function renderImport(
  decl: ImportDeclaration,
  source = decl.source.raw,
): string {
  if (decl.isSideEffect) return `import ${source};`;
  const parts: string[] = [];
  if (decl.defaultBinding) parts.push(decl.defaultBinding.name);
  if (decl.namespaceBinding) {
    parts.push(`* as ${decl.namespaceBinding.name}`);
  } else if (!decl.defaultBinding || decl.specifiers.length > 0) {
    const specs = decl.specifiers
      .map((spec) => {
        const prefix = spec.isTypeOnly ? "type " : "";
        return `${prefix}${spec.imported.name}${spec.imported.name === spec.local.name ? "" : ` as ${spec.local.name}`}`;
      })
      .join(", ");
    parts.push(specs ? `{ ${specs} }` : "{}");
  }
  return `import ${decl.isTypeOnly ? "type " : ""}${parts.join(", ")} from ${source};`;
}

/** Render a named re-export without creating local bindings. */
export function renderExportFrom(
  decl: ExportFromDeclaration,
  source = decl.source.raw,
): string {
  const specifiers = decl.specifiers
    .map(
      (spec) =>
        `${spec.isTypeOnly ? "type " : ""}${spec.imported.name}${spec.imported.name === spec.local.name ? "" : ` as ${spec.local.name}`}`,
    )
    .join(", ");
  return `export ${decl.isTypeOnly ? "type " : ""}{ ${specifiers} } from ${source};`;
}
