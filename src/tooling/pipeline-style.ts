import * as Effect from "effect/Effect";
import { compileString } from "../compiler.js";
import { TypeScriptCompilationContext } from "../compiler/typescript-context.js";
import {
  PIPELINE_COMPANION_CATALOG,
  pipelineCompanionCandidates,
} from "../emitter/pipeline-catalog.js";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";

export type PipelineStyle = "bare" | "qualified";
type Edit = {
  start: number;
  end: number;
  text: string;
  module: string;
  method: string;
};

/** Convert only pipeline stages whose generated TypeScript is unchanged. */
export function convertPipelineStyle(
  source: string,
  filename: string,
  style: PipelineStyle,
  range?: { start: number; end: number },
  compilationContext?: TypeScriptCompilationContext,
): { text: string; changed: number; skipped: number } {
  if (!source.includes("|>")) return { text: source, changed: 0, skipped: 0 };
  // Most editor requests target a single stage. Avoid type checking the
  // document for the opposite style, or for a selection without a stage.
  const parsed = new Parser(
    new Lexer(source, filename).tokenize(),
    filename,
    source,
  ).parse();
  let hasCandidate = false;
  const scan = (node: any): void => {
    if (!node || typeof node !== "object" || hasCandidate) return;
    if (node.kind === "PipelineExpression") {
      const stage = node.right;
      const target = stage.kind === "CallExpression" ? stage.callee : stage;
      const start = target.span.start.offset;
      const end = stage.span.end.offset;
      const selected =
        !range ||
        (range.start === range.end
          ? start <= range.start && range.start <= end
          : start < range.end && end > range.start);
      if (
        selected &&
        (style === "qualified"
          ? target.kind === "Identifier"
          : target.kind === "MemberExpression" &&
            target.object.kind === "UpperIdentifier" &&
            PIPELINE_COMPANION_CATALOG[
              target.object.name as keyof typeof PIPELINE_COMPANION_CATALOG
            ]?.includes(target.property.name))
      ) {
        hasCandidate = true;
        return;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "span") continue;
      if (Array.isArray(value)) value.forEach(scan);
      else if (value && typeof value === "object") scan(value);
    }
  };
  scan(parsed);
  if (!hasCandidate) return { text: source, changed: 0, skipped: 0 };
  const context =
    compilationContext ?? new TypeScriptCompilationContext(filename);
  context.setFilename(filename, true);
  const compiled = Effect.runSync(
    compileString(source, filename, {
      context,
      sourcePath: filename,
      sourcemap: false,
      pipelineAnalysisOnly: true,
    }),
  );
  const resolutions =
    style === "bare"
      ? compiled.barePipelineStageResolutions
      : compiled.pipelineStageResolutions;
  const edits: Edit[] = [];
  let candidateCount = 0;
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (node.kind === "PipelineExpression") {
      const stage = node.right;
      const target = stage.kind === "CallExpression" ? stage.callee : stage;
      const start = target.span.start.offset;
      const _end = target.span.end.offset;
      const stageEnd = stage.span.end.offset;
      const selected =
        !range ||
        (range.start === range.end
          ? start <= range.start && range.start <= stageEnd
          : start < range.end && stageEnd > range.start);
      if (
        selected &&
        style === "bare" &&
        target.kind === "MemberExpression" &&
        target.object.kind === "UpperIdentifier"
      ) {
        const module = target.object
          .name as keyof typeof PIPELINE_COMPANION_CATALOG;
        const method = target.property.name;
        if (PIPELINE_COMPANION_CATALOG[module]?.includes(method))
          candidateCount++;
        const resolution = resolutions.get(stage.span.start.offset);
        if (
          PIPELINE_COMPANION_CATALOG[module]?.includes(method) &&
          resolution?.module === module &&
          resolution.method === method
        ) {
          edits.push({
            start,
            end: target.property.span.start.offset,
            text: "",
            module,
            method,
          });
        }
      } else if (
        selected &&
        style === "qualified" &&
        target.kind === "Identifier"
      ) {
        const possibleModules = pipelineCompanionCandidates(target.name);
        if (possibleModules.length > 0) candidateCount++;
        const resolution = resolutions.get(stage.span.start.offset);
        if (
          resolution &&
          resolution.method === target.name &&
          PIPELINE_COMPANION_CATALOG[
            resolution.module as keyof typeof PIPELINE_COMPANION_CATALOG
          ]?.includes(target.name)
        ) {
          edits.push({
            start,
            end: start,
            text: `${resolution.module}.`,
            module: resolution.module,
            method: target.name,
          });
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "span") continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(parsed);
  let result = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return {
    text: result,
    changed: edits.length,
    skipped: candidateCount - edits.length,
  };
}
