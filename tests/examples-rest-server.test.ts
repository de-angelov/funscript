import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { compileString } from "../src/compiler.js";
import { typeCheckFiles } from "../src/compiler/check.js";

describe("REST server example", () => {
  const examplePath = path.resolve("examples/rest-api-server.fun");
  let child: ChildProcess;
  let port: number;

  beforeAll(async () => {
    const source = await fs.readFile(examplePath, "utf8");
    const compiled = await Effect.runPromise(compileString(source, examplePath));
    expect(compiled.typescript).toContain("createServer");
    const check = await Effect.runPromise(typeCheckFiles([examplePath]));
    expect(check.success, JSON.stringify(check.diagnostics)).toBe(true);
    expect(check.errorCount).toBe(0);

    port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (!address || typeof address === "string") return reject(new Error("No ephemeral port"));
        const selected = address.port;
        probe.close((error) => error ? reject(error) : resolve(selected));
      });
    });
    child = spawn(process.execPath, [path.resolve("dist/cli/index.js"), "run", examplePath], {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, PORT: String(port) },
    });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`REST server exited with code ${child.exitCode}`);
      try {
        await fetch(`http://127.0.0.1:${port}/items`);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error("REST server did not start within 10 seconds");
  }, 20_000);

  afterAll(async () => {
    if (!child || child.exitCode !== null) return;
    process.kill(-child.pid!, "SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close((error) => error ? reject(error) : resolve()));
    });
  });

  it("serves schema-valid items and structured route and validation errors", async () => {
    const root = `http://127.0.0.1:${port}`;
    const list = await fetch(`${root}/items`);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);

    const created = await fetch(`${root}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Notebook" }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: 1, name: "Notebook" });

    const malformed = await fetch(`${root}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "ValidationError" });

    const invalid = await fetch(`${root}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: 42 }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "ValidationError" });

    const missing = await fetch(`${root}/missing`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "NotFoundError" });
  });
});
