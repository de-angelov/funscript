export type CliCommand = {
  name: string;
  aliases?: readonly string[];
  usage: string;
  description: string;
  examples: readonly string[];
};

const commandOptions: Record<string, ReadonlySet<string>> = {
  build: new Set(["--target", "--out", "--outDir", "--sourcemap", "--no-check", "--no-ts", "--no-global-this", "--no-optional", "--bare-pipelines", "--bin", "--watch"]),
  emit: new Set(["--out", "--sourcemap", "--no-ts", "--no-global-this", "--no-optional", "--bare-pipelines", "--bin"]),
  check: new Set(["--idiomatic", "--json", "--sarif", "--warnings-as-errors", "--no-ts", "--no-global-this", "--no-optional", "--bare-pipelines"]),
  run: new Set(["--no-check", "--no-ts", "--no-global-this", "--no-optional", "--bare-pipelines"]),
  fmt: new Set(["--check", "--diff", "--stdin", "--stdin-filepath"]),
  lsp: new Set(["--stdio"]),
};

const valueOptions: Record<string, ReadonlySet<string>> = {
  build: new Set(["--target", "--out", "--outDir"]),
  emit: new Set(["--out"]),
  fmt: new Set(["--stdin-filepath"]),
};

export function validateCliArgs(command: string, args: string[]): string | undefined {
  if (command === "tsc") return undefined;
  const allowed = commandOptions[command] ?? new Set<string>();
  const values = valueOptions[command] ?? new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (command === "run" && arg === "--") return undefined;
    if (!arg.startsWith("-") || arg === "-") continue;
    if (!allowed.has(arg)) return `Unknown option '${arg}' for '${command}'. Run 'funscript ${command} --help' for usage.`;
    if (values.has(arg) && (!args[index + 1] || args[index + 1]!.startsWith("-"))) return `Option '${arg}' requires a value.`;
    if (values.has(arg)) index++;
  }
  return undefined;
}

/** Canonical public CLI contract: both help output and reference docs use this data. */
export const CLI_COMMANDS: readonly CliCommand[] = [
  { name: "build", usage: "build <file.fun|file.funx...> [--target bun] [--out <file>] [--outDir <dir>] [--sourcemap] [--no-check] [--no-ts] [--no-global-this] [--no-optional] [--bare-pipelines] [--bin] [--watch]", description: "Build FunScript files to TypeScript or TSX, or bundle one entry and its local modules as a Bun executable.", examples: ["funscript build src/Button.funx --sourcemap", "funscript build src/cli/bin.fun --target bun --out dist/cli/bin.js"] },
  { name: "emit", usage: "emit <file.fun|file.funx> [--out <file.ts|file.tsx>] [--sourcemap] [--no-ts] [--no-global-this] [--no-optional] [--bare-pipelines] [--bin]", description: "Compile one FunScript file to TypeScript or TSX.", examples: ["funscript emit src/main.fun --out src/main.ts --sourcemap"] },
  { name: "check", usage: "check [file.fun|file.funx...] [--idiomatic] [--json|--sarif] [--warnings-as-errors] [--no-ts] [--no-global-this] [--no-optional] [--bare-pipelines]", description: "Statically type-check files with the TypeScript API and optionally emit machine-readable diagnostics.", examples: ["funscript check examples/shapes.fun", "funscript check src --sarif --warnings-as-errors"] },
  { name: "tsc", usage: "tsc [TypeScript options]", description: "Run the project's TypeScript compiler and map type-view diagnostics to FunScript sources.", examples: ["funscript tsc --noEmit"] },
  { name: "run", usage: "run <file.fun|file.funx> [--no-check] [--no-ts] [--no-global-this] [--no-optional] [--bare-pipelines] [-- arg... ]", description: "Bundle and run a FunScript program and its local imports with Node.js.", examples: ["funscript run examples/hello.fun", "funscript run src/main.fun -- --verbose"] },
  { name: "repl", usage: "repl", description: "Start the interactive REPL.", examples: ["funscript repl"] },
  { name: "lsp", usage: "lsp [--stdio]", description: "Start the Language Server Protocol server.", examples: ["funscript lsp --stdio"] },
  { name: "fmt", usage: "fmt <file|directory|glob...> [--check|--diff] | fmt --stdin [--check|--diff] [--stdin-filepath <path>]", description: "Format FunScript files, directories or globs; check formatting, show a unified diff, or format source from standard input.", examples: ["funscript fmt 'src/**/*.fun' --diff", "funscript fmt --stdin --stdin-filepath src/main.fun"] },
  { name: "pipeline-style", usage: "pipeline-style <bare|qualified> <file or directory...>", description: "Convert pipeline stages while preserving compiler output.", examples: ["funscript pipeline-style bare src/"] },
  { name: "version", aliases: ["-v", "--version"], usage: "version", description: "Display the FunScript version.", examples: ["funscript version"] },
];

const commandLines = () =>
  CLI_COMMANDS.map((command) => `  funscript ${command.usage}`.padEnd(104) + command.description).join("\n");

export const renderCliHelp = (version: string, commandName?: string) => {
  if (commandName) {
    const command = CLI_COMMANDS.find(item => item.name === commandName || item.aliases?.includes(commandName));
    if (!command) return `Unknown command '${commandName}'. Run 'funscript --help' to see available commands.`;
    return `FunScript ${version}\n\nUsage:\n  funscript ${command.usage}\n\n${command.description}\n\nExamples:\n${command.examples.map(example => `  ${example}`).join("\n")}\n`;
  }
  return `
FunScript ${version} — A functional notation for TypeScript and Effect

Usage:
${commandLines()}

Examples:
${CLI_COMMANDS.flatMap((command) => command.examples).map((example) => `  ${example}`).join("\n")}

Project scaffolding and dev/preview/test/add/doctor wrappers are not currently available.
Use standard project tools such as Vite, Vitest, and npm/pnpm/Bun directly.
`;
};

export const renderCliReference = (version: string) => `<!-- Generated by scripts/generate-reference-docs.mjs. Do not edit directly. -->

# CLI reference

FunScript ${version}. This page is generated from [the CLI command catalogue](../../src/cli/commands.ts).

## Commands

${CLI_COMMANDS.map((command) => {
  const aliases = command.aliases?.length ? `\n\nAliases: ${command.aliases.map((alias) => `\`${alias}\``).join(", ")}.` : "";
  const examples = command.examples.map((example) => `\n\n\`\`\`sh\n${example}\n\`\`\``).join("");
  return `### \`funscript ${command.name}\`\n\n\`\`\`text\nfunscript ${command.usage}\n\`\`\`\n\n${command.description}${aliases}${examples}`;
}).join("\n\n")}
`;
