import { Effect, Console } from "effect";
import {
  DOC_CATALOG,
  getDocItem,
  getAllDocKeywords,
  type DocItem,
} from "../lsp/docs.js";

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = [];
  for (let i = 0; i <= m; i++) d[i] = [i];
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
    }
  }
  return d[m][n];
}

export const explainCommand = (args: string[]) =>
  Effect.gen(function* () {
    const isJson = args.includes("--json");
    const isList = args.includes("--list");
    const positional = args.filter((arg) => !arg.startsWith("-"));

    if (isList || positional.length === 0) {
      if (isJson) {
        yield* Console.log(JSON.stringify(DOC_CATALOG, null, 2));
        return;
      }
      const categories: Record<string, DocItem[]> = {
        keyword: [],
        schema: [],
        effect: [],
        primitive: [],
        operator: [],
      };
      for (const item of Object.values(DOC_CATALOG)) {
        if (!categories[item.category]) {
          categories[item.category] = [];
        }
        categories[item.category].push(item);
      }

      const categoryTitles: Record<string, string> = {
        keyword: "Keywords & Control Flow",
        schema: "Schemas & Types",
        effect: "Effect Ecosystem",
        primitive: "Primitives",
        operator: "Operators",
      };

      const lines: string[] = [
        "FunScript Language Reference",
        "Run 'funscript explain <topic>' to view detailed syntax and examples for any item.\n",
      ];

      for (const [cat, title] of Object.entries(categoryTitles)) {
        const items = categories[cat];
        if (!items || items.length === 0) continue;
        lines.push(`${title}:`);
        items.sort((a, b) => a.name.localeCompare(b.name));
        for (const it of items) {
          const nameCol = `  ${it.name.padEnd(16)}`;
          lines.push(`${nameCol} ${it.summary}`);
        }
        lines.push("");
      }

      yield* Console.log(lines.join("\n").trimEnd());
      return;
    }

    const topic = positional[0];
    const item = getDocItem(topic);

    if (!item) {
      process.exitCode = 1;
      const allKeywords = getAllDocKeywords();
      const lower = topic.toLowerCase();
      const matches = allKeywords.filter(
        (kw) =>
          kw.toLowerCase().includes(lower) ||
          lower.includes(kw.toLowerCase()) ||
          levenshteinDistance(lower, kw.toLowerCase()) <= 2,
      );

      let msg = `error: Unknown topic '${topic}'.`;
      if (matches.length > 0) {
        msg += `\n\nDid you mean: ${matches.join(", ")}?`;
      }
      msg += `\nRun 'funscript explain --list' to see all available topics.`;
      yield* Console.error(msg);
      return;
    }

    if (isJson) {
      yield* Console.log(JSON.stringify(item, null, 2));
      return;
    }

    const lines: string[] = [];
    lines.push(`${item.name} (${item.category}) — ${item.summary}\n`);
    lines.push(`Signature:\n  ${item.signature.split("\n").join("\n  ")}\n`);
    if (item.description) {
      lines.push(
        `Description:\n  ${item.description.split("\n").join("\n  ")}\n`,
      );
    }
    if (item.snippet) {
      lines.push(`Example:\n  ${item.snippet.split("\n").join("\n  ")}\n`);
    }
    if (item.seeAlso && item.seeAlso.length > 0) {
      lines.push(`See also: ${item.seeAlso.join(", ")}\n`);
    }

    yield* Console.log(lines.join("\n").trimEnd());
  });
