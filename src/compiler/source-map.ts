import MagicString, { type SourceMap } from "magic-string";
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

  const headerLines: string[] = [];
  for (const line of typescript.split("\n")) {
    if (line.startsWith("import ")) headerLines.push(line);
    else if (line.trim() === "" && headerLines.length > 0) break;
  }
  const header = headerLines.length > 0 ? headerLines.join("\n") + "\n\n" : "";

  if (ast.body.length === 0) {
    if (source.length > 0) {
      s.overwrite(0, source.length, typescript);
    }
  } else {
    for (let i = 0; i < ast.body.length; i++) {
      const decl = ast.body[i];
      const nextDecl = ast.body[i + 1];
      const single = new Emitter(
        { kind: "Program", body: [decl], span: decl.span },
        ast,
        emitterOptions,
      );
      const singleOut = single.emit();
      const code = singleOut
        .split("\n")
        .filter((l) => !l.startsWith("import "))
        .join("\n")
        .trim();
      const startOffset = i === 0 ? 0 : decl.span.start.offset;
      const endOffset = nextDecl ? nextDecl.span.start.offset : source.length;
      const isLast = i === ast.body.length - 1;
      const replacement = code + (isLast ? "\n" : "\n\n");
      s.overwrite(startOffset, endOffset, replacement);
    }
  }

  if (header.length > 0) {
    s.prepend(header);
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
