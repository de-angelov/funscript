import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compileString } from "../src/compiler.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("dist/cli/index.js");

describe(".funx & TSX Component Support (Compiler & CLI)", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "funscript-funx-test-"));
  });

  afterAll(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe("Compiler targetExtension recognition", () => {
    it("recognizes .funx file and sets targetExtension to .tsx", async () => {
      const code = `
export Button = (props: Props) -> <button className="btn">{props.label}</button>
`.trim();
      const res = await Effect.runPromise(compileString(code, "src/components/Button.funx"));
      expect(res.targetExtension).toBe(".tsx");
      expect(res.typescript).toContain(
        'export const Button = (props: Props) => <button className="btn">{props.label}</button>;',
      );
    });

    it("recognizes .fun file and sets targetExtension to .ts", async () => {
      const code = `
export add = (a: number, b: number) -> a + b
`.trim();
      const res = await Effect.runPromise(compileString(code, "src/math.fun"));
      expect(res.targetExtension).toBe(".ts");
      expect(res.typescript).toContain("export const add = (a: number, b: number) => (a + b);");
    });
  });

  describe("End-to-End Component Compilation (.funx -> .tsx)", () => {
    it("compiles a complex UI component with signals, effects, and mutative draft state", async () => {
      const code = `
schema TaskItem = {
  id: string
  title: string
  completed: boolean
}

export TaskList = (tasks: Array<TaskItem>) ->
  <div className="task-container">
    <header className="header">
      <h1>Task Tracker</h1>
    </header>
    <ul className="tasks">
      {tasks |> Array.map((task) -> <li key={task.id}>{task.title}</li>)}
    </ul>
  </div>
`.trim();

      const res = await Effect.runPromise(compileString(code, "TaskList.funx"));
      expect(res.typescript).toBeDefined();
      expect(res.typescript).toContain('import { Array, Schema, pipe } from "effect";');
      expect(res.typescript).toContain("export const TaskList = (tasks: Array<TaskItem>) => {");
      expect(res.typescript).toContain('return <div className="task-container">');
      expect(res.typescript).toContain('<header className="header"><h1>Task Tracker</h1></header>');
      expect(res.typescript).toContain('<ul className="tasks">');
      expect(res.typescript).toContain("pipe(");
      expect(res.typescript).toContain("Array.map((task) => <li key={task.id}>{task.title}</li>)");
    });

    it("compiles pattern matching inside component body to ts-pattern match with JSX output", async () => {
      const code = `
schema ViewState =
  | Loading
  | Failed(msg: string)
  | Ready(content: string)

export View = (state: ViewState) ->
  match state
    | Loading -> <div className="spinner"><span /></div>
    | Failed(err) -> <div className="error-banner">{err.msg}</div>
    | Ready(info) -> <div className="content"><p>{info.content}</p></div>
`.trim();

      const res = await Effect.runPromise(compileString(code, "View.funx"));
      expect(res.typescript).toContain('import { match, P } from "ts-pattern";');
      expect(res.typescript).toContain('.with({ _tag: "Loading" }, () => <div className="spinner"><span /></div>)');
      expect(res.typescript).toContain('.with({ _tag: "Failed" }');
      expect(res.typescript).toContain('return <div className="error-banner">{err.msg}</div>;');
      expect(res.typescript).toContain('.with({ _tag: "Ready" }');
      expect(res.typescript).toContain('return <div className="content"><p>{info.content}</p></div>;');
    });

    it("compiles attributes with string template interpolation correctly", async () => {
      const code = `
export Card = (variant: string, size: string) ->
  <div className="card-{variant}" data-size="size-{size}">
    <span>Card content</span>
  </div>
`.trim();

      const res = await Effect.runPromise(compileString(code, "Card.funx"));
      expect(res.typescript).toContain('className={`card-${variant}`}');
      expect(res.typescript).toContain('data-size={`size-${size}`}');
    });

    it("compiles attributes with dollar-prefixed template interpolation correctly", async () => {
      const code = `
export Badge = (badgeKind: string) ->
  <span className="badge-\${badgeKind}">
    Badge
  </span>
`.trim();

      const res = await Effect.runPromise(compileString(code, "Badge.funx"));
      expect(res.typescript).toContain('className={`badge-${badgeKind}`}');
    });
  });

  describe("CLI build command with .funx files", () => {
    it("builds a single .funx file to .tsx adjacent to source", async () => {
      const funxFile = path.join(tmpDir, "Widget.funx");
      const expectedTsxFile = path.join(tmpDir, "Widget.tsx");

      await fs.writeFile(
        funxFile,
        `
export Widget = (props: Props) ->
  <div className="widget">
    <h3>{props.name}</h3>
  </div>
`.trim(),
        "utf-8",
      );

      const { stdout } = await execFileAsync("node", [cliPath, "build", funxFile]);
      expect(stdout).toContain(`✓ Built ${expectedTsxFile}`);

      const tsxContent = await fs.readFile(expectedTsxFile, "utf-8");
      expect(tsxContent).toContain("export const Widget = (props: Props) => {");
      expect(tsxContent).toContain('return <div className="widget"><h3>{props.name}</h3></div>;');
    });

    it("builds a .fun file to .ts adjacent to source", async () => {
      const funFile = path.join(tmpDir, "math.fun");
      const expectedTsFile = path.join(tmpDir, "math.ts");

      await fs.writeFile(
        funFile,
        `
export multiply = (a: number, b: number) -> a * b
`.trim(),
        "utf-8",
      );

      const { stdout } = await execFileAsync("node", [cliPath, "build", funFile]);
      expect(stdout).toContain(`✓ Built ${expectedTsFile}`);

      const tsContent = await fs.readFile(expectedTsFile, "utf-8");
      expect(tsContent).toContain("export const multiply = (a: number, b: number) => (a * b);");
    });

    it("builds a .funx file to an explicit output path using --out", async () => {
      const funxFile = path.join(tmpDir, "Header.funx");
      const outTsxFile = path.join(tmpDir, "custom", "HeaderComponent.tsx");

      await fs.writeFile(
        funxFile,
        `
export Header = () -> <header><h1>FunScript</h1></header>
`.trim(),
        "utf-8",
      );

      const { stdout } = await execFileAsync("node", [cliPath, "build", funxFile, "--out", outTsxFile]);
      expect(stdout).toContain(`✓ Built ${outTsxFile}`);

      const tsxContent = await fs.readFile(outTsxFile, "utf-8");
      expect(tsxContent).toContain("export const Header = () => <header><h1>FunScript</h1></header>;");
    });

    it("builds multiple .fun and .funx files into a directory using --outDir", async () => {
      const srcDir = path.join(tmpDir, "src");
      const distDir = path.join(tmpDir, "dist");
      await fs.mkdir(srcDir, { recursive: true });

      const file1 = path.join(srcDir, "App.funx");
      const file2 = path.join(srcDir, "utils.fun");

      await fs.writeFile(file1, "export App = () -> <main>Hello</main>\n");
      await fs.writeFile(file2, "export double = (x: number) -> x * 2\n");

      const { stdout } = await execFileAsync("node", [
        cliPath,
        "build",
        file1,
        file2,
        "--outDir",
        distDir,
      ]);

      expect(stdout).toContain(`✓ Built ${path.join(distDir, "App.tsx")}`);
      expect(stdout).toContain(`✓ Built ${path.join(distDir, "utils.ts")}`);

      const appContent = await fs.readFile(path.join(distDir, "App.tsx"), "utf-8");
      expect(appContent).toContain("export const App = () => <main>Hello</main>;");

      const utilsContent = await fs.readFile(path.join(distDir, "utils.ts"), "utf-8");
      expect(utilsContent).toContain("export const double = (x: number) => (x * 2);");
    });
  });
});
