import type { ExportFromDeclaration, ImportDeclaration } from "../ast/types.js";

/** Render an import while preserving the distinction between `import {}` and a bare import. */
export function renderImport(
  decl: ImportDeclaration,
  source = decl.source.raw,
  modularEffectImports = false,
): string {
  if (decl.isSideEffect) return `import ${source};`;
  if (
    modularEffectImports &&
    (source === '"effect"' || source === "'effect'") &&
    !decl.namespaceBinding &&
    !decl.defaultBinding
  ) {
    const lines: string[] = [];
    const functionSpecifiers: string[] = [];
    const effectFunctionNames = new Set([
      "pipe",
      "flow",
      "identity",
      "absurd",
      "dual",
      "constant",
      "constVoid",
      "constTrue",
      "constFalse",
      "constNull",
      "constUndefined",
    ]);

    for (const spec of decl.specifiers) {
      const imported = spec.imported.name;
      const local = spec.local.name;
      const isTypeOnly = decl.isTypeOnly || spec.isTypeOnly;
      const typePrefix = isTypeOnly ? "type " : "";

      if (effectFunctionNames.has(imported)) {
        const alias = imported === local ? imported : `${imported} as ${local}`;
        functionSpecifiers.push(`${typePrefix}${alias}`);
      } else if (isTypeOnly) {
        const alias = imported === local ? imported : `${imported} as ${local}`;
        lines.push(`import type { ${alias} } from "effect/${imported}";`);
      } else {
        lines.push(`import * as ${local} from "effect/${imported}";`);
      }
    }

    if (functionSpecifiers.length > 0) {
      lines.push(
        `import { ${functionSpecifiers.join(", ")} } from "effect/Function";`,
      );
    }

    if (lines.length > 0) {
      return lines.join("\n");
    }
  }

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
