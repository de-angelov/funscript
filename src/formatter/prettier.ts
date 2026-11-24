import type { Parser, Plugin, Printer, SupportLanguage } from "prettier";
import { Lexer } from "../lexer/lexer.js";
import { Parser as FunScriptParser } from "../parser/parser.js";
import { format, type FormatOptions } from "./index.js";

export const languages: SupportLanguage[] = [
  {
    name: "FunScript",
    parsers: ["funscript"],
    extensions: [".fun", ".funx"],
    vscodeLanguageIds: ["funscript", "funscriptx"],
  },
];

export const parsers: Record<string, Parser> = {
  funscript: {
    parse: (text: string, options: { filepath?: string } = {}) => {
      const filename = options?.filepath ?? "<anonymous>";
      const lexer = new Lexer(text, filename);
      const tokens = lexer.tokenize();
      const parser = new FunScriptParser(tokens, filename);
      const ast = parser.parse();
      return {
        kind: "Program",
        text,
        ast,
      };
    },
    astFormat: "funscript-ast",
    locStart: (node: { span?: { start?: { offset?: number } } }) =>
      node.span?.start?.offset ?? 0,
    locEnd: (node: { span?: { end?: { offset?: number } } }) =>
      node.span?.end?.offset ?? 0,
  },
};

export const printers: Record<string, Printer> = {
  "funscript-ast": {
    print: (
      path: { node: { text: string } },
      options: { tabWidth?: number; filepath?: string } = {},
    ) => {
      const node = path.node;
      const formatOptions: FormatOptions = {
        indentSize: options?.tabWidth ?? 2,
      };
      return format(node.text, {
        ...formatOptions,
        filename: options?.filepath,
      });
    },
  },
};

const plugin: Plugin = {
  languages,
  parsers,
  printers,
};

export default plugin;
