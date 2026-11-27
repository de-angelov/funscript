import {
  CompletionItemKind,
  type CompletionItem,
  type Position,
  type Range,
} from "vscode-languageserver/node";
import {
  PIPELINE_COMPANION_CATALOG,
  pipelineCompanionCandidates,
} from "../emitter/pipeline-catalog.js";
import { DOC_CATALOG, getAllDocKeywords } from "./docs.js";

export interface IndexedDocument {
  uri: string;
  text: string;
}

const PRIMARY_DISAMBIGUATION_MODULES = new Set([
  "Array",
  "Config",
  "DateTime",
  "Duration",
  "Effect",
  "HttpClientRequest",
  "HttpServerResponse",
  "Layer",
  "Option",
  "Record",
  "Result",
  "Schedule",
  "Schema",
  "Stream",
  "String",
]);

const DEFERRED_PIPELINE_CONSTRUCTORS: ReadonlyArray<{
  readonly name: string;
  readonly detail: string;
  readonly documentation: string;
}> = [
  {
    name: "sync",
    detail: "Deferred Effect.sync(() => expr)",
    documentation:
      "Wraps a synchronous expression in a lazy Effect thunk (`Effect<A>`).",
  },
  {
    name: "try",
    detail: "Deferred Effect.try(() => expr)",
    documentation:
      "Wraps a throwing synchronous expression in a lazy Effect (`Effect<A, UnknownException>`).",
  },
  {
    name: "promise",
    detail: "Deferred Effect.promise(() => expr)",
    documentation:
      "Wraps an infallible Promise-returning expression in a lazy Effect (`Effect<A>`).",
  },
  {
    name: "tryPromise",
    detail: "Deferred Effect.tryPromise(() => expr)",
    documentation:
      "Wraps a Promise-returning expression in a lazy Effect (`Effect<A, UnknownException>`).",
  },
  {
    name: "suspend",
    detail: "Deferred Effect.suspend(() => expr)",
    documentation:
      "Lazily evaluates and flattens an Effect-returning expression (`Effect<A, E, R>`).",
  },
  {
    name: "failSync",
    detail: "Deferred Effect.failSync(() => expr)",
    documentation:
      "Lazily computes an error value and fails on the Effect error channel (`Effect<never, E>`).",
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds completion candidates from the current open workspace snapshot. */
export function complete(
  source: string,
  uri: string,
  position: Position,
  documents: IndexedDocument[],
  pipelineAnalysis?: { source: string; inputs: Array<[number, string]> },
): CompletionItem[] {
  const lines = source.split("\n");
  const line = lines[position.line] ?? "";
  const before = line.slice(0, position.character);
  const priorSource =
    lines.slice(0, position.line).join("\n") +
    (position.line > 0 ? "\n" : "") +
    before;
  const match = before.match(/[\w$.-]*$/);
  const typedPrefix = match?.[0] ?? "";
  const member = /([A-Za-z_$][\w$]*)\.$/.exec(before)?.[1];
  const prefix = member ? "" : typedPrefix;
  const start = position.character - (member ? 0 : prefix.length);
  const range: Range = {
    start: { line: position.line, character: start },
    end: position,
  };
  const items = new Map<string, CompletionItem>();
  const add = (
    label: string,
    kind: CompletionItemKind,
    detail: string,
    documentation?: string,
  ) => {
    if (prefix && !label.toLowerCase().startsWith(prefix.toLowerCase())) return;
    if (label === member) return;
    items.set(label, {
      label,
      kind,
      detail,
      ...(documentation ? { documentation } : {}),
      textEdit: { range, newText: label },
      sortText: label.toLowerCase(),
    });
  };

  if (member) {
    const escapedMember = escapeRegExp(member);
    const schema = new RegExp(
      `(?:schema\\s+)?${escapedMember}\\s*=\\s*\\{([\\s\\S]*?)\\n\\}`,
      "m",
    ).exec(source);
    if (schema)
      for (const field of schema[1].matchAll(
        /^\s*([A-Za-z_$][\w$]*)\s*:\s*([^,\n}]+)/gm,
      ))
        add(field[1], CompletionItemKind.Field, field[2].trim());
    const variants = new RegExp(
      `schema\\s+${escapedMember}\\s*=([\\s\\S]*?)(?:\\n\\S|$)`,
      "m",
    ).exec(source);
    if (variants)
      for (const variant of variants[1].matchAll(/\|\s*([A-Z][A-Za-z0-9_$]*)/g))
        add(variant[1], CompletionItemKind.EnumMember, `${member} variant`);
    if (member === "Effect")
      for (const key of getAllDocKeywords().filter((key) =>
        key.startsWith("Effect."),
      )) {
        const doc = DOC_CATALOG[key];
        add(
          key.slice(7),
          CompletionItemKind.Function,
          doc.signature,
          doc.summary,
        );
      }
  } else {
    const visible = new Set<string>();
    for (const doc of documents) {
      if (doc.uri === uri) {
        for (const found of priorSource.matchAll(
          /^\s*(?!export\s)(?:mut\s+)?([a-z_$][\w$]*)\s*(?:=|:)/gm,
        ))
          visible.add(found[1]);
        for (const found of doc.text.matchAll(
          /^\s*export\s+(?:(?:schema|error|service)\s+)?([A-Za-z_$][\w$]*)\s*(?:=|\(|:)/gm,
        ))
          visible.add(found[1]);
        for (const found of doc.text.matchAll(
          /\b(?:export\s+)?(?:schema|error|service)\s+([A-Z][\w$]*)/g,
        ))
          visible.add(found[1]);
      } else {
        const base = doc.uri
          .replace(/\.(funx?|tsx?)$/, "")
          .split(/[\\/]/)
          .pop();
        if (
          base &&
          new RegExp(
            `from\\s+["'][^"']*${escapeRegExp(base)}(?:\\.(?:funx?|tsx?))?["']`,
          ).test(source)
        ) {
          for (const found of doc.text.matchAll(
            /^\s*export\s+(?:(?:schema|error|service)\s+)?([A-Za-z_$][\w$]*)/gm,
          ))
            visible.add(found[1]);
        }
      }
    }
    const deferredPipelineContext = /\|>>\s*(?:[\w.]*)$/.test(before);
    const pipelineContext =
      !deferredPipelineContext && /\|>\s*(?:[\w.]*)$/.test(before);
    const jsxContext = /<\s*[A-Za-z_$\w]*$/.test(before);
    if (!deferredPipelineContext) {
      for (const name of visible)
        add(name, CompletionItemKind.Variable, "Workspace symbol");
      add("Effect", CompletionItemKind.Module, "Effect API namespace");
      for (const [name, doc] of Object.entries(DOC_CATALOG)) {
        if (doc.category === "effect" && !pipelineContext) continue;
        add(
          name,
          doc.category === "keyword"
            ? CompletionItemKind.Keyword
            : doc.category === "effect"
              ? CompletionItemKind.Function
              : CompletionItemKind.Class,
          doc.signature,
          doc.summary,
        );
      }
    }
    if (deferredPipelineContext) {
      for (const ctor of DEFERRED_PIPELINE_CONSTRUCTORS) {
        const label = typedPrefix.startsWith("Effect.")
          ? `Effect.${ctor.name}`
          : ctor.name;
        if (
          typedPrefix &&
          !label.toLowerCase().startsWith(typedPrefix.toLowerCase())
        )
          continue;
        items.set(label, {
          label,
          kind: CompletionItemKind.Function,
          detail: ctor.detail,
          documentation: ctor.documentation,
          textEdit: { range, newText: label },
          sortText: `0-${label.toLowerCase()}`,
        });
      }
    }
    if (pipelineContext) {
      const pipeOffset = priorSource.lastIndexOf("|>");
      const cachedPrefixMatches =
        pipelineAnalysis &&
        pipeOffset >= 0 &&
        pipelineAnalysis.source.slice(0, pipeOffset).trimEnd() ===
          priorSource.slice(0, pipeOffset).trimEnd();
      let inputCompanion: string | undefined;
      if (cachedPrefixMatches) {
        const cachedPipe = pipelineAnalysis.source.indexOf("|>", pipeOffset);
        let stageOffset = cachedPipe + 2;
        while (/\s/.test(pipelineAnalysis.source[stageOffset] ?? ""))
          stageOffset++;
        inputCompanion = pipelineAnalysis.inputs.find(
          ([offset]) => offset === stageOffset,
        )?.[1];
      }
      if (inputCompanion && inputCompanion in PIPELINE_COMPANION_CATALOG) {
        for (const operation of PIPELINE_COMPANION_CATALOG[
          inputCompanion as keyof typeof PIPELINE_COMPANION_CATALOG
        ]) {
          if (
            typedPrefix &&
            !operation.toLowerCase().startsWith(typedPrefix.toLowerCase())
          )
            continue;
          const doc = DOC_CATALOG[`${inputCompanion}.${operation}`];
          items.set(operation, {
            label: operation,
            kind: CompletionItemKind.Function,
            detail: doc
              ? `${inputCompanion} pipeline operation — ${doc.signature}`
              : `${inputCompanion} pipeline operation`,
            documentation: doc
              ? `${doc.summary}\n\nSelected from pipeline input type (${inputCompanion}); compiles to \`${inputCompanion}.${operation}\`.`
              : `Selected from the pipeline input type (${inputCompanion}); compiles to \`${inputCompanion}.${operation}\`.`,
            textEdit: { range, newText: operation },
            sortText: `0-${operation.toLowerCase()}`,
          });
        }
      } else {
        const operations = new Set(
          Object.values(PIPELINE_COMPANION_CATALOG).flat(),
        );
        for (const operation of operations) {
          if (
            typedPrefix &&
            !operation.toLowerCase().startsWith(typedPrefix.toLowerCase())
          )
            continue;
          const candidates = pipelineCompanionCandidates(operation);
          if (candidates.length === 1) {
            const module = candidates[0];
            items.set(operation, {
              label: operation,
              kind: CompletionItemKind.Function,
              detail: `${module} pipeline operation`,
              documentation: `Unambiguous bare pipeline stage; compiles to \`${module}.${operation}\`.`,
              textEdit: { range, newText: operation },
              sortText: `0-${operation.toLowerCase()}`,
            });
            continue;
          }
          if (candidates.length < 2) continue;
          for (const module of candidates) {
            const label = `${module}.${operation}`;
            if (!typedPrefix && !PRIMARY_DISAMBIGUATION_MODULES.has(module))
              continue;
            if (
              typedPrefix &&
              !label.toLowerCase().startsWith(typedPrefix.toLowerCase()) &&
              !operation.toLowerCase().startsWith(typedPrefix.toLowerCase())
            )
              continue;
            items.set(label, {
              label,
              kind: CompletionItemKind.Function,
              detail: `Explicit pipeline stage — ${operation} is shared by ${candidates.join(", ")}`,
              documentation: `Use \`${label}(...)\` to avoid an ambiguous bare pipeline stage.`,
              textEdit: { range, newText: label },
              sortText: `0-${label.toLowerCase()}`,
            });
          }
        }
      }
    }
    if (/\.funx?$/.test(uri) && jsxContext)
      for (const tag of [
        "div",
        "span",
        "button",
        "input",
        "form",
        "main",
        "section",
        "header",
        "footer",
        "ul",
        "li",
        "a",
        "p",
        "h1",
        "h2",
      ])
        add(tag, CompletionItemKind.Property, "JSX element");
  }
  return [...items.values()].sort(
    (a, b) =>
      String(a.sortText).localeCompare(String(b.sortText)) ||
      a.label.localeCompare(b.label),
  );
}
