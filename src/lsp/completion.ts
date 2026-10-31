import {
  CompletionItemKind,
  type CompletionItem,
  type Position,
  type Range,
} from "vscode-languageserver/node";
import { DOC_CATALOG, getAllDocKeywords } from "./docs.js";

export interface IndexedDocument {
  uri: string;
  text: string;
}

/** Builds completion candidates from the current open workspace snapshot. */
export function complete(
  source: string,
  uri: string,
  position: Position,
  documents: IndexedDocument[],
): CompletionItem[] {
  const lines = source.split("\n");
  const line = lines[position.line] ?? "";
  const before = line.slice(0, position.character);
  const priorSource = lines.slice(0, position.line).join("\n") + before;
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
    const schema = new RegExp(
      `(?:schema\\s+)?${member}\\s*=\\s*\\{([\\s\\S]*?)\\n\\}`,
      "m",
    ).exec(source);
    if (schema)
      for (const field of schema[1].matchAll(
        /^\s*([A-Za-z_$][\w$]*)\s*:\s*([^,\n}]+)/gm,
      ))
        add(field[1], CompletionItemKind.Field, field[2].trim());
    const variants = new RegExp(
      `schema\\s+${member}\\s*=([\\s\\S]*?)(?:\\n\\S|$)`,
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
        )) visible.add(found[1]);
        for (const found of doc.text.matchAll(
          /^\s*export\s+(?:(?:schema|error|service)\s+)?([A-Za-z_$][\w$]*)\s*(?:=|\(|:)/gm,
        )) visible.add(found[1]);
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
            `from\\s+["'][^"']*${base}(?:\\.(?:funx?|tsx?))?["']`,
          ).test(source)
        ) {
          for (const found of doc.text.matchAll(
            /^\s*export\s+(?:(?:schema|error|service)\s+)?([A-Za-z_$][\w$]*)/gm,
          ))
            visible.add(found[1]);
        }
      }
    }
    for (const name of visible)
      add(name, CompletionItemKind.Variable, "Workspace symbol");
    const pipelineContext = /\|>\s*(?:[\w.]*)$/.test(before);
    const jsxContext = /<\s*[A-Za-z_$\w]*$/.test(before);
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
