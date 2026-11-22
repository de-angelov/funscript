import { Effect } from "effect";
import { compileString } from "../compiler.js";
import { inferPipelineCompanions } from "../compiler/pipeline-companions.js";
import { TypeScriptCompilationContext } from "../compiler/typescript-context.js";
import { PIPELINE_COMPANION_CATALOG } from "../emitter/pipeline-catalog.js";

export type PipelineStyle = "bare" | "qualified";
type Edit = { start: number; end: number; text: string };

/** Convert only pipeline stages whose generated TypeScript is unchanged. */
export function convertPipelineStyle(source: string, filename: string, style: PipelineStyle, range?: { start: number; end: number }): { text: string; changed: number; skipped: number } {
  if (!source.includes("|>")) return { text: source, changed: 0, skipped: 0 };
  const context = new TypeScriptCompilationContext(filename);
  const compile = (text: string) => Effect.runSync(compileString(text, filename, { context, sourcePath: filename, sourcemap: false }));
  const original = compile(source);
  let resolutions: ReturnType<typeof inferPipelineCompanions>["stageResolutions"] | undefined;
  if (style === "qualified") {
    resolutions = inferPipelineCompanions(original.ast, new TypeScriptCompilationContext(filename)).stageResolutions;
  }
  const edits: Edit[] = [];
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (node.kind === "PipelineExpression") {
      const stage = node.right;
      const target = stage.kind === "CallExpression" ? stage.callee : stage;
      const start = target.span.start.offset;
      const end = target.span.end.offset;
      const stageEnd = stage.span.end.offset;
      const selected = !range || (range.start === range.end ? start <= range.start && range.start <= stageEnd : start < range.end && stageEnd > range.start);
      if (selected && style === "bare" && target.kind === "MemberExpression" && target.object.kind === "UpperIdentifier") {
        const module = target.object.name as keyof typeof PIPELINE_COMPANION_CATALOG;
        const method = target.property.name;
        if (PIPELINE_COMPANION_CATALOG[module]?.includes(method)) {
          edits.push({ start, end: target.property.span.start.offset, text: "" });
        }
      } else if (selected && style === "qualified" && target.kind === "Identifier") {
        const resolution = resolutions?.get(stage.span.start.offset);
        if (resolution && resolution.method === target.name && PIPELINE_COMPANION_CATALOG[resolution.module as keyof typeof PIPELINE_COMPANION_CATALOG]?.includes(target.name)) {
          edits.push({ start, end: start, text: `${resolution.module}.` });
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "span") continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(original.ast);
  const apply = (changes: Edit[]) => {
    let result = source;
    for (const edit of [...changes].sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    return result;
  };
  const accepted: Edit[] = [];
  const tryGroup = (group: Edit[]): void => {
    if (!group.length) return;
    try {
      if (compile(apply([...accepted, ...group])).typescript === original.typescript) {
        accepted.push(...group);
        return;
      }
    } catch { /* A stage may be ambiguous or shadowed. */ }
    if (group.length > 1) {
      const middle = Math.floor(group.length / 2);
      tryGroup(group.slice(0, middle));
      tryGroup(group.slice(middle));
    }
  };
  tryGroup(edits);
  return { text: apply(accepted), changed: accepted.length, skipped: edits.length - accepted.length };
}
