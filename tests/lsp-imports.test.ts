import { describe, it, expect } from "vitest";
import {
  findAutoImportCodeActions,
  findRemoveUnusedImportsCodeActions,
} from "../src/lsp/imports.js";
import { FunScriptLspServer } from "../src/lsp/index.js";
import * as path from "node:path";

describe("LSP Auto-Import and Remove Unused Imports Code Actions", () => {
  const uri = `file://${path.resolve(process.cwd(), "tests/fixtures/import-test.fun")}`;

  describe("Auto-Import", () => {
    it("suggests auto-importing an unimported Effect module into existing import", () => {
      const source = `
import { Console } from "effect"

export main =
  effect {
    r <- Ref.make(0)
    _ <- Console.log("Hello")
    => void
  }
`;
      // Cursor on Ref
      const actions = findAutoImportCodeActions(source, uri, {
        start: { line: 5, character: 9 },
        end: { line: 5, character: 12 },
      });

      expect(actions.length).toBe(1);
      expect(actions[0].title).toBe('Add import { Ref } from "effect"');
      expect(actions[0].kind).toBe("quickfix");
      const edit = actions[0].edit?.changes?.[uri]?.[0];
      expect(edit).toBeDefined();
      expect(edit?.newText).toBe('import { Console, Ref } from "effect"');
    });

    it("creates a new import line when no effect import exists yet", () => {
      const source = `
export main =
  effect {
    t <- Duration.seconds(5)
    => void
  }
`;
      // Cursor on Duration
      const actions = findAutoImportCodeActions(source, uri, {
        start: { line: 3, character: 9 },
        end: { line: 3, character: 17 },
      });

      expect(actions.length).toBe(1);
      expect(actions[0].title).toBe('Add import { Duration } from "effect"');
      const edit = actions[0].edit?.changes?.[uri]?.[0];
      expect(edit?.newText).toContain('import { Duration } from "effect"');
    });

    it("does not suggest import if symbol is already imported", () => {
      const source = `
import { Ref, Console } from "effect"

export main = Ref.make(0)
`;
      const actions = findAutoImportCodeActions(source, uri, {
        start: { line: 3, character: 14 },
        end: { line: 3, character: 17 },
      });

      expect(actions.length).toBe(0);
    });

    it("does not suggest import if symbol is declared locally in module", () => {
      const source = `
export schema Ref = {
  id: String
}

export makeRef = Ref({ id: "1" })
`;
      const actions = findAutoImportCodeActions(source, uri, {
        start: { line: 5, character: 17 },
        end: { line: 5, character: 20 },
      });

      expect(actions.length).toBe(0);
    });

    it("preserves as Alias and type modifiers when adding to an existing effect import", () => {
      const source = `
import { Console as C, type Scope } from "effect"

export main = (s: Scope) =>
  effect {
    r <- Ref.make(0)
    _ <- C.log("Hello")
    => r
  }
`;
      const actions = findAutoImportCodeActions(source, uri, {
        start: { line: 5, character: 9 },
        end: { line: 5, character: 12 },
      });

      expect(actions.length).toBe(1);
      const edit = actions[0].edit?.changes?.[uri]?.[0];
      expect(edit?.newText).toBe(
        'import { Console as C, Ref, type Scope } from "effect"',
      );
    });
  });

  describe("Remove Unused Imports", () => {
    it("suggests removing an unused specifier from a partially used import", () => {
      const source = `
import { Console, Ref, Array } from "effect"

export main =
  effect {
    _ <- Console.log("Hello")
    => void
  }
`;
      // Cursor on the import line
      const actions = findRemoveUnusedImportsCodeActions(source, uri, {
        start: { line: 1, character: 5 },
        end: { line: 1, character: 15 },
      });

      const targeted = actions.find((a) =>
        a.title.includes("Remove unused import 'Ref, Array'"),
      );
      expect(targeted).toBeDefined();
      expect(targeted?.edit?.changes?.[uri]?.[0]?.newText).toBe(
        'import { Console } from "effect"',
      );

      const organize = actions.find(
        (a) => a.title === "Remove all unused imports",
      );
      expect(organize).toBeDefined();
      expect(organize?.kind).toBe("source.organizeImports");
    });

    it("deletes the entire import declaration when all specifiers are unused", () => {
      const source = `
import { Schedule } from "effect"
import { Console } from "effect"

export main = Console.log("Only console used")
`;
      // Cursor on line 1 (Schedule)
      const actions = findRemoveUnusedImportsCodeActions(source, uri, {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 20 },
      });

      const removeSchedule = actions.find((a) =>
        a.title.includes('Remove unused import from "effect"'),
      );
      expect(removeSchedule).toBeDefined();
      const edit = removeSchedule?.edit?.changes?.[uri]?.[0];
      expect(edit?.newText).toBe("");
    });

    it("preserves as Alias and type modifiers when removing unused imports", () => {
      const source = `
import { Console as C, type Scope, Unused } from "effect"
import type { Duration, UnusedType } from "effect"

export main = (s: Scope, d: Duration.Duration) => C.log("hi")
`;
      const actions = findRemoveUnusedImportsCodeActions(source, uri, {
        start: { line: 1, character: 0 },
        end: { line: 2, character: 50 },
      });

      const organize = actions.find(
        (a) => a.title === "Remove all unused imports",
      );
      expect(organize).toBeDefined();
      const edits = organize?.edit?.changes?.[uri] ?? [];
      expect(edits).toHaveLength(2);
      expect(edits[0].newText).toBe(
        'import { Console as C, type Scope } from "effect"',
      );
      expect(edits[1].newText).toBe('import type { Duration } from "effect"');
    });
  });

  describe("LSP Server Integration", () => {
    it("provides auto-import and unused import actions via onCodeActionHandler", () => {
      const server = new FunScriptLspServer();
      server.onInitializeHandler({
        capabilities: {},
        rootUri: `file://${process.cwd()}`,
      } as any);

      const docUri = `file://${process.cwd()}/test-server-import.fun`;
      const source = `
import { Console, UnusedModule } from "effect"

export main =
  effect {
    q <- Queue.unbounded()
    _ <- Console.log("Queue created")
    => void
  }
`;
      server.onDidOpenHandler({
        textDocument: {
          uri: docUri,
          languageId: "funscript",
          version: 1,
          text: source,
        },
      });

      // 1. Cursor on Queue (line 5)
      const queueActions = server.onCodeActionHandler({
        textDocument: { uri: docUri },
        range: {
          start: { line: 5, character: 9 },
          end: { line: 5, character: 14 },
        },
        context: { diagnostics: [] },
      });

      const autoImportQueue = queueActions.find(
        (a) => a.title === 'Add import { Queue } from "effect"',
      );
      expect(autoImportQueue).toBeDefined();

      // 2. Cursor on import line (line 1)
      const importActions = server.onCodeActionHandler({
        textDocument: { uri: docUri },
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 10 },
        },
        context: { diagnostics: [] },
      });

      const removeUnused = importActions.find((a) =>
        a.title.includes("Remove unused import"),
      );
      expect(removeUnused).toBeDefined();
    });
  });
});
