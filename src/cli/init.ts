import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { toErrorMessage } from "../errors.js";

export type TemplateType =
  "effect-cli" | "bun-server" | "vite-react" | "vite-solid";

export const SUPPORTED_TEMPLATES: Record<string, TemplateType> = {
  default: "effect-cli",
  "effect-cli": "effect-cli",
  effect: "effect-cli",
  cli: "effect-cli",
  "bun-server": "bun-server",
  bun: "bun-server",
  server: "bun-server",
  "vite-react": "vite-react",
  react: "vite-react",
  "vite-solid": "vite-solid",
  solid: "vite-solid",
};

export interface InitOptions {
  cwd?: string;
  template?: string;
  force?: boolean;
}

export function resolveTemplate(
  rawTemplate?: string,
): TemplateType | undefined {
  if (!rawTemplate) return "effect-cli";
  return SUPPORTED_TEMPLATES[rawTemplate.toLowerCase().trim()];
}

interface TemplateFiles {
  [filePath: string]: string;
}

function getTemplateFiles(
  projectName: string,
  template: TemplateType,
): TemplateFiles {
  const gitignore = `node_modules/
dist/
.funscript-cache/
.funscript/
.DS_Store
`;

  switch (template) {
    case "bun-server":
      return {
        "package.json": JSON.stringify(
          {
            name: projectName,
            version: "0.1.0",
            type: "module",
            scripts: {
              dev: "bun --watch src/index.fun",
              start: "funscript run --fast src/index.fun",
              test: "funscript test --engine bun",
              build: "funscript build --target bun src/index.fun",
              fmt: "funscript fmt src tests",
              check: "funscript check",
            },
            dependencies: {
              effect: "^3.10.0",
            },
            devDependencies: {
              "@types/bun": "latest",
              funscript: "^0.2.3",
            },
          },
          null,
          2,
        ),
        "bunfig.toml": `preload = ["funscript/bun"]\n`,
        "tsconfig.json": JSON.stringify(
          {
            compilerOptions: {
              target: "ESNext",
              module: "ESNext",
              moduleResolution: "bundler",
              types: ["bun-types"],
              strict: true,
              skipLibCheck: true,
            },
            include: ["src", "tests", ".funscript/types"],
          },
          null,
          2,
        ),
        ".gitignore": gitignore,
        "src/index.fun": `import { Console } from "effect"

export handleRequest = (req: Any): Any =>
  new Response("Hello from FunScript on Bun!", {
    headers: { "content-type": "text/plain" }
  })

export main = Console.log("FunScript Bun server ready on http://localhost:3000")
`,
        "tests/server.test.fun": `import { describe, it, expect } from "funscript/test"
import { handleRequest } from "../src/index.fun"

suite = describe("HTTP Server", () =>
  it("returns 200 OK greeting", () =>
    req = new Request("http://localhost:3000/")
    res = handleRequest(req)
    => expect(res.status).toBe(200)
  )
)
`,
        "README.md": `# ${projectName}

FunScript application running on the Bun runtime with native \`bunfig.toml\` preload.

## Getting Started
\`\`\`bash
bun install
bun run dev      # run live in watch mode with Bun
bun run test     # run tests with native bun test
bun run build    # bundle standalone executable with fast native Bun
\`\`\`
`,
      };

    case "vite-react":
      return {
        "package.json": JSON.stringify(
          {
            name: projectName,
            version: "0.1.0",
            type: "module",
            scripts: {
              dev: "vite",
              build: "vite build",
              test: "funscript test",
              fmt: "funscript fmt src",
            },
            dependencies: {
              react: "^19.0.0",
              "react-dom": "^19.0.0",
            },
            devDependencies: {
              "@types/react": "^19.0.0",
              "@types/react-dom": "^19.0.0",
              "@vitejs/plugin-react": "^4.3.4",
              funscript: "^0.2.3",
              typescript: "^5.6.3",
              vite: "^5.4.11",
              vitest: "^2.1.8",
            },
          },
          null,
          2,
        ),
        "vite.config.ts": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { funscriptPlugin } from "funscript/vite";

export default defineConfig({
  plugins: [funscriptPlugin(), react()],
});
`,
        "index.html": `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${projectName}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
        "tsconfig.json": JSON.stringify(
          {
            compilerOptions: {
              target: "ESNext",
              module: "ESNext",
              moduleResolution: "bundler",
              jsx: "react-jsx",
              strict: true,
              skipLibCheck: true,
            },
            include: ["src", ".funscript/types"],
          },
          null,
          2,
        ),
        ".gitignore": gitignore,
        "src/App.funx": `import React, { useState } from "react"

export App = () =>
  [count, setCount] = useState(0)

  => <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
    <h1>FunScript + React</h1>
    <p>Indentation-based functional notation in JSX.</p>
    <button onClick={() => setCount(count + 1)}>
      Count: {count}
    </button>
  </div>
`,
        "src/main.tsx": `import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.funx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`,
        "README.md": `# ${projectName}

React + Vite web application built with FunScript JSX (\`.funx\`).

## Getting Started
\`\`\`bash
npm install
npm run dev     # start Vite development server
npm run build   # build production bundle
\`\`\`
`,
      };

    case "vite-solid":
      return {
        "package.json": JSON.stringify(
          {
            name: projectName,
            version: "0.1.0",
            type: "module",
            scripts: {
              dev: "vite",
              build: "vite build",
              test: "funscript test",
              fmt: "funscript fmt src",
            },
            dependencies: {
              "solid-js": "^1.9.3",
            },
            devDependencies: {
              funscript: "^0.2.3",
              typescript: "^5.6.3",
              vite: "^5.4.11",
              "vite-plugin-solid": "^2.11.0",
              vitest: "^2.1.8",
            },
          },
          null,
          2,
        ),
        "vite.config.ts": `import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { funscriptPlugin } from "funscript/vite";

export default defineConfig({
  plugins: [funscriptPlugin(), solid()],
});
`,
        "index.html": `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${projectName}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
        "tsconfig.json": JSON.stringify(
          {
            compilerOptions: {
              target: "ESNext",
              module: "ESNext",
              moduleResolution: "bundler",
              jsx: "preserve",
              jsxImportSource: "solid-js",
              strict: true,
              skipLibCheck: true,
            },
            include: ["src", ".funscript/types"],
          },
          null,
          2,
        ),
        ".gitignore": gitignore,
        "src/App.funx": `import { createSignal } from "solid-js"

export App = () =>
  [count, setCount] = createSignal(0)

  => <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
    <h1>FunScript + Solid</h1>
    <p>Fine-grained reactive UI built with FunScript JSX.</p>
    <button onClick={() => setCount(count() + 1)}>
      Count: {count()}
    </button>
  </div>
`,
        "src/main.tsx": `import { render } from "solid-js/web";
import { App } from "./App.funx";

render(() => <App />, document.getElementById("root")!);
`,
        "README.md": `# ${projectName}

Solid.js + Vite application built with FunScript JSX (\`.funx\`).

## Getting Started
\`\`\`bash
npm install
npm run dev     # start Vite development server
npm run build   # build production bundle
\`\`\`
`,
      };

    case "effect-cli":
    default:
      return {
        "package.json": JSON.stringify(
          {
            name: projectName,
            version: "0.1.0",
            type: "module",
            scripts: {
              run: "funscript run src/main.fun",
              test: "funscript test",
              build: "funscript build",
              fmt: "funscript fmt src tests",
              check: "funscript check",
            },
            dependencies: {
              effect: "^3.10.0",
            },
            devDependencies: {
              funscript: "^0.2.3",
              typescript: "^5.6.3",
              vitest: "^2.1.8",
            },
          },
          null,
          2,
        ),
        "tsconfig.json": JSON.stringify(
          {
            compilerOptions: {
              target: "ESNext",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true,
              esModuleInterop: true,
              skipLibCheck: true,
            },
            include: ["src", "tests", ".funscript/types"],
          },
          null,
          2,
        ),
        ".gitignore": gitignore,
        "src/main.fun": `import { Console, pipe, Array } from "effect"

export greet = (name: String): String => \`Hello, \${name}!\`

export main = pipe(
  ["World", "FunScript", "Effect"],
  Array.map(greet),
  Array.join(", "),
  Console.log
)
`,
        "tests/main.test.fun": `import { describe, it, expect } from "funscript/test"
import { greet } from "../src/main.fun"

suite = describe("main module", () =>
  it("formats greetings correctly", () =>
    expect(greet("Developer")).toBe("Hello, Developer!")
  )
)
`,
        "README.md": `# ${projectName}

A modern functional application built with FunScript.

## Getting Started
\`\`\`bash
npm install
npm run run     # run the entry file with FunScript
npm run test    # run native FunScript tests
npm run check   # type-check the project
npm run fmt     # format .fun source files
npm run build   # compile to TypeScript
\`\`\`
`,
      };
  }
}

export function initProject(targetDir: string, options: InitOptions = {}) {
  return Effect.gen(function* () {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const destDir = path.resolve(cwd, targetDir);
    const projectName = path.basename(destDir) || "my-funscript-app";

    const resolvedTemplate = resolveTemplate(options.template);
    if (!resolvedTemplate) {
      return yield* Effect.fail(
        new Error(
          `Unknown template '${options.template}'. Supported templates: ${Object.keys(
            SUPPORTED_TEMPLATES,
          )
            .filter((t, i, arr) => arr.indexOf(t) === i)
            .join(", ")}`,
        ),
      );
    }

    // Check directory emptiness
    const exists = yield* Effect.tryPromise({
      try: () =>
        fs
          .stat(destDir)
          .then((s) => s.isDirectory())
          .catch(() => false),
      catch: () => false,
    });

    if (exists && !options.force) {
      const entries = yield* Effect.tryPromise({
        try: () => fs.readdir(destDir),
        catch: () => [] as string[],
      });
      const nonIgnored = entries.filter(
        (e) => e !== ".git" && e !== ".DS_Store",
      );
      if (nonIgnored.length > 0) {
        return yield* Effect.fail(
          new Error(
            `Directory is not empty: '${targetDir}'. Use --force to initialize anyway.`,
          ),
        );
      }
    }

    const files = getTemplateFiles(projectName, resolvedTemplate);

    yield* Effect.tryPromise({
      try: async () => {
        await fs.mkdir(destDir, { recursive: true });
        for (const [relPath, content] of Object.entries(files)) {
          const fullPath = path.join(destDir, relPath);
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, content, "utf8");
        }
      },
      catch: (error: unknown) =>
        new Error(`Failed to initialize project: ${toErrorMessage(error)}`),
    });

    yield* Console.log(
      `✓ Created new FunScript project '${projectName}' using template '${resolvedTemplate}' in ${destDir}`,
    );
    yield* Console.log(`\nNext steps:`);
    if (destDir !== cwd) {
      yield* Console.log(`  cd ${targetDir}`);
    }
    if (resolvedTemplate === "bun-server") {
      yield* Console.log(`  bun install`);
      yield* Console.log(`  bun run dev`);
    } else {
      yield* Console.log(`  npm install`);
      yield* Console.log(
        resolvedTemplate.startsWith("vite-")
          ? `  npm run dev`
          : `  npm run run`,
      );
    }
  });
}
