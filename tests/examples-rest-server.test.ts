import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compileString } from "../src/compiler.js";
import { typeCheckFiles } from "../src/compiler/check.js";

describe("Program 08: Real-World HTTP REST API Server (TASK-028)", () => {
  const programPath = path.resolve("programs/08-rest-api-server.fun");
  let programSource: string;
  let compiledTs: string;
  let serverInstance: any;
  let serverPort: number;
  let baseUrl: string;

  // Imported functions from compiled server module
  let startServer: (port: number) => Promise<any>;
  let stopServer: () => Promise<boolean>;
  let getItemsCount: () => number;
  let resetItemsStore: () => Promise<boolean>;

  beforeAll(async () => {
    programSource = await fs.readFile(programPath, "utf-8");
    const res = await Effect.runPromise(compileString(programSource, programPath));
    compiledTs = res.typescript;

    // Dynamically import the compiled server
    const serverModulePath = path.resolve("programs/08-rest-api-server.ts");
    const mod = await import(serverModulePath);
    startServer = mod.startServer;
    stopServer = mod.stopServer;
    getItemsCount = mod.getItemsCount;
    resetItemsStore = mod.resetItemsStore;

    // Spin up server on an ephemeral port (port 0)
    serverInstance = await startServer(0);
    serverPort = serverInstance.address().port;
    baseUrl = `http://127.0.0.1:${serverPort}`;
  });

  afterAll(async () => {
    if (stopServer) {
      await stopServer();
    }
  });

  describe("1. Static Compilation & Type Check Verification", () => {
    it("compiles cleanly to TypeScript with Effect and ts-pattern imports", () => {
      expect(compiledTs).toBeDefined();
      expect(compiledTs).toContain('import { Console, Effect, Schema, pipe } from "effect";');
      expect(compiledTs).toContain('import { match, P } from "ts-pattern";');
      expect(compiledTs).toContain('import { createServer } from "node:http";');
    });

    it("emits payload schemas with Schema.Struct and typeof Type", () => {
      expect(compiledTs).toContain("export const CreateItemRequest = Schema.Struct({");
      expect(compiledTs).toContain("export type CreateItemRequest = typeof CreateItemRequest.Type;");
      expect(compiledTs).toContain("export const ItemResponse = Schema.Struct({");
      expect(compiledTs).toContain("export type ItemResponse = typeof ItemResponse.Type;");
      expect(compiledTs).toContain("export const ApiError = Schema.Struct({");
      expect(compiledTs).toContain("export type ApiError = typeof ApiError.Type;");
    });

    it("emits tagged error schemas extending Schema.TaggedError", () => {
      expect(compiledTs).toContain('export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError",');
      expect(compiledTs).toContain('export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError",');
      expect(compiledTs).toContain('export class ServerError extends Schema.TaggedError<ServerError>()("ServerError",');
    });

    it("emits pattern matching on routes with tuple matching", () => {
      expect(compiledTs).toContain("return match([method, url])");
      expect(compiledTs).toContain('.with(["GET", "/api/health"], () => handleHealth(res))');
      expect(compiledTs).toContain('.with(["GET", "/api/items"], () => handleGetItems(res))');
      expect(compiledTs).toContain('.with(["POST", "/api/items"], () => handleCreateItem(req, res))');
      expect(compiledTs).toContain('.with(["GET", "/api/error"], () => handleSimulatedError())');
      expect(compiledTs).toContain(".otherwise(() => handleNotFound(method, url))");
    });

    it("emits 'when' early return checks inside validation functions", () => {
      expect(compiledTs).toContain('if ((authHeader === "")) return Effect.fail(makeValidationError("Missing Authorization header"));');
      expect(compiledTs).toContain('if ((authHeader !== "Bearer test-api-key")) return Effect.fail(makeValidationError("Invalid authorization token"));');
      expect(compiledTs).toContain('if ((title === "")) return Effect.fail(makeValidationError("Item title cannot be empty"));');
    });

    it("passes static type-checking with funscript check (0 diagnostics)", async () => {
      const checkRes = await Effect.runPromise(typeCheckFiles([programPath]));
      expect(checkRes.success).toBe(true);
      expect(checkRes.diagnostics.length).toBe(0);
      expect(checkRes.errorCount).toBe(0);
    });
  });

  describe("2. Endpoints Integration & HTTP REST Scenarios", () => {
    it("GET /api/health returns 200 with service metadata", async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");

      const body = await res.json();
      expect(body).toEqual({
        status: "ok",
        service: "FunScript REST API",
      });
    });

    it("GET /api/items returns 200 with initial items", async () => {
      const res = await fetch(`${baseUrl}/api/items`);
      expect(res.status).toBe(200);

      const items = await res.json();
      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBe(2);
      expect(items[0]).toEqual({ id: "item-1", title: "Setup Project", priority: 1 });
      expect(items[1]).toEqual({ id: "item-2", title: "Write FunScript REST API", priority: 2 });
    });

    it("POST /api/items rejects request when Authorization header is missing", async () => {
      const res = await fetch(`${baseUrl}/api/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Task without auth", priority: 3 }),
      });

      expect(res.status).toBe(400);
      const error = await res.json();
      expect(error).toEqual({
        error: "ValidationError",
        message: "Missing Authorization header",
      });
    });

    it("POST /api/items rejects request when Authorization token is invalid", async () => {
      const res = await fetch(`${baseUrl}/api/items`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token-xyz",
        },
        body: JSON.stringify({ title: "Task with wrong auth", priority: 3 }),
      });

      expect(res.status).toBe(400);
      const error = await res.json();
      expect(error).toEqual({
        error: "ValidationError",
        message: "Invalid authorization token",
      });
    });

    it("POST /api/items rejects request with empty request body", async () => {
      const res = await fetch(`${baseUrl}/api/items`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-api-key",
        },
        body: "",
      });

      expect(res.status).toBe(400);
      const error = await res.json();
      expect(error.error).toBe("ValidationError");
      expect(error.message).toContain("Request body is empty");
    });

    it("POST /api/items rejects request with malformed JSON body", async () => {
      const res = await fetch(`${baseUrl}/api/items`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-api-key",
        },
        body: "{ not valid json ...",
      });

      expect(res.status).toBe(400);
      const error = await res.json();
      expect(error.error).toBe("ValidationError");
      expect(error.message).toContain("Invalid JSON");
    });

    it("POST /api/items rejects payload failing schema decoding (priority is not a number)", async () => {
      const res = await fetch(`${baseUrl}/api/items`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-api-key",
        },
        body: JSON.stringify({ title: "Valid Title", priority: "high-priority-string" }),
      });

      expect(res.status).toBe(400);
      const error = await res.json();
      expect(error.error).toBe("ValidationError");
      expect(error.message).toContain("Schema validation failed");
      expect(error.message).toContain("Expected number");
    });

    it("POST /api/items rejects payload with empty title via when early return", async () => {
      const res = await fetch(`${baseUrl}/api/items`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-api-key",
        },
        body: JSON.stringify({ title: "", priority: 1 }),
      });

      expect(res.status).toBe(400);
      const error = await res.json();
      expect(error).toEqual({
        error: "ValidationError",
        message: "Item title cannot be empty",
      });
    });

    it("POST /api/items creates new item successfully on valid auth and schema", async () => {
      const initialCount = getItemsCount();

      const res = await fetch(`${baseUrl}/api/items`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-api-key",
        },
        body: JSON.stringify({ title: "Build Microservice in FunScript", priority: 10 }),
      });

      expect(res.status).toBe(201);
      const createdItem = await res.json();
      expect(createdItem).toEqual({
        id: "item-3",
        title: "Build Microservice in FunScript",
        priority: 10,
      });

      // Verify item was stored in memory
      expect(getItemsCount()).toBe(initialCount + 1);

      const itemsRes = await fetch(`${baseUrl}/api/items`);
      const allItems = await itemsRes.json();
      expect(allItems.length).toBe(3);
      expect(allItems[2]).toEqual(createdItem);
    });

    it("GET /api/error triggers ServerError and responds with 500 status", async () => {
      const res = await fetch(`${baseUrl}/api/error`);
      expect(res.status).toBe(500);

      const error = await res.json();
      expect(error).toEqual({
        error: "ServerError",
        message: "Simulated internal database connection failure",
      });
    });

    it("GET /api/unknown-endpoint responds with 404 NotFoundError", async () => {
      const res = await fetch(`${baseUrl}/api/unknown-endpoint`);
      expect(res.status).toBe(404);

      const error = await res.json();
      expect(error).toEqual({
        error: "NotFoundError",
        message: "Route not found: GET /api/unknown-endpoint",
      });
    });

    it("DELETE /api/items responds with 404 NotFoundError for unhandled methods", async () => {
      const res = await fetch(`${baseUrl}/api/items`, { method: "DELETE" });
      expect(res.status).toBe(404);

      const error = await res.json();
      expect(error).toEqual({
        error: "NotFoundError",
        message: "Route not found: DELETE /api/items",
      });
    });

    it("resets store cleanly with resetItemsStore()", async () => {
      await resetItemsStore();
      expect(getItemsCount()).toBe(2);

      const res = await fetch(`${baseUrl}/api/items`);
      const items = await res.json();
      expect(items.length).toBe(2);
      expect(items[0].id).toBe("item-1");
      expect(items[1].id).toBe("item-2");
    });
  });
});
