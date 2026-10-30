import type { Plugin, SupportLanguage, Parser, Printer } from "prettier";
import { Lexer } from "../lexer/lexer.js";
import { Parser as FunScriptParser } from "../parser/parser.js";
import { format, FormatOptions } from "./index.js";

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
    parse: (text: string, options: any) => {
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
    locStart: (node: any) => node.span?.start?.offset ?? 0,
    locEnd: (node: any) => node.span?.end?.offset ?? 0,
  },
};

export const printers: Record<string, Printer> = {
  "funscript-ast": {
    print: (path: any, options: any) => {
      const node = path.node;
      const formatOptions: FormatOptions = {
        indentSize: options?.tabWidth ?? 2,
      };
      return format(node.text, { ...formatOptions, filename: options?.filepath });
    },
  },
};

const plugin: Plugin = {
  languages,
  parsers,
  printers,
};

export default plugin;
