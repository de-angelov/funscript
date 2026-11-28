import MagicString, { Bundle, type SourceMap } from "magic-string";
import ts from "typescript";
import type { Program } from "../ast/types.js";
import { Emitter, type EmitterOptions } from "../emitter/emitter.js";

/** Map generated TypeScript back to declarations in the original source. */
export function generateSourceMap(
  source: string,
  filename: string,
  typescript: string,
  ast: Program,
  emitterOptions: EmitterOptions,
  outputFile?: string,
): SourceMap {
  const outTarget = outputFile
    ? outputFile
    : filename.endsWith(".funx")
      ? `${filename.slice(0, -5)}.tsx`
      : filename.endsWith(".fun")
        ? `${filename.slice(0, -4)}.ts`
        : `${filename}.ts`;

  const s = new MagicString(source);
  const movedImports: Array<{
    start: number;
    end: number;
    declStart: number;
    declEnd: number;
  }> = [];

  if (ast.body.length === 0) {
    if (source.length > 0) s.overwrite(0, source.length, typescript);
  } else {
    const output = ts.createSourceFile(
      "output.tsx",
      typescript,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const imports = output.statements.filter(ts.isImportDeclaration);
    const parts = ast.body.map((decl) => {
      const single = new Emitter(
        { kind: "Program", body: [decl], span: decl.span },
        ast,
        emitterOptions,
      );
      const singleOut = single.emit();
      const code =
        decl.kind === "ImportDeclaration"
          ? singleOut.trim()
          : singleOut
              .split("\n")
              .filter((line) => !line.startsWith("import "))
              .join("\n")
              .trim();
      if (
        decl.kind !== "ImportDeclaration" ||
        typescript.includes(code) ||
        decl.isSideEffect ||
        decl.isTypeOnly ||
        decl.defaultBinding ||
        decl.namespaceBinding ||
        !decl.specifiers.length
      )
        return code;
      const merged = imports.find((item) => {
        if (
          !ts.isStringLiteral(item.moduleSpecifier) ||
          (decl.source.raw !== JSON.stringify(item.moduleSpecifier.text) &&
            decl.source.raw !== `'${item.moduleSpecifier.text}'`)
        )
          return false;
        const bindings = item.importClause?.namedBindings;
        return (
          bindings &&
          ts.isNamedImports(bindings) &&
          decl.specifiers.every((spec) =>
            bindings.elements.some(
              (element) =>
                element.name.text === spec.local.name &&
                (element.propertyName?.text ?? element.name.text) ===
                  spec.imported.name &&
                element.isTypeOnly === spec.isTypeOnly,
            ),
          )
        );
      });
      if (!merged) return code;
      movedImports.push({
        start: merged.getStart(output),
        end: merged.end,
        declStart: decl.span.start.offset,
        declEnd: decl.span.end.offset,
      });
      return "";
    });
    const first = parts.findIndex((part) => part.length > 0);
    let last = parts.length - 1;
    while (last >= 0 && parts[last].length === 0) last--;
    let totalBody = "";
    for (let i = 0; i < ast.body.length; i++) {
      const decl = ast.body[i];
      const startOffset = i === 0 ? 0 : decl.span.start.offset;
      const endOffset = ast.body[i + 1]?.span.start.offset ?? source.length;
      let replacement =
        i < first || i > last ? "" : parts[i] + (i === last ? "\n" : "\n\n");
      if (first < 0) replacement = "";
      totalBody += replacement;
      s.overwrite(startOffset, endOffset, replacement);
    }
    if (typescript.endsWith(totalBody)) {
      const header = typescript.slice(0, typescript.length - totalBody.length);
      if (movedImports.length === 0) {
        if (header) s.prepend(header);
      } else if (movedImports.every((item) => item.end <= header.length)) {
        const bundle = new Bundle({ separator: "" });
        let offset = 0;
        for (const item of movedImports.sort((a, b) => a.start - b.start)) {
          bundle.append(header.slice(offset, item.start));
          const mapped = new MagicString(source).snip(
            item.declStart,
            item.declEnd,
          );
          mapped.overwrite(
            item.declStart,
            item.declEnd,
            header.slice(item.start, item.end),
          );
          bundle.addSource({ filename, content: mapped });
          offset = item.end;
        }
        bundle.append(header.slice(offset));
        bundle.addSource({ filename, content: s });
        if (bundle.toString() === typescript) {
          return bundle.generateMap({
            file: outTarget,
            hires: true,
            includeContent: true,
          });
        }
      }
    }
  }

  if (s.toString() !== typescript) {
    const fallback = new MagicString(source);
    if (source.length > 0) {
      fallback.overwrite(0, source.length, typescript);
    }
    return fallback.generateMap({
      source: filename,
      file: outTarget,
      hires: true,
      includeContent: true,
    });
  } else {
    return s.generateMap({
      source: filename,
      file: outTarget,
      hires: true,
      includeContent: true,
    });
  }
}
