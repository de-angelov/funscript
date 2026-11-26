let bunTest: Record<string, unknown> | undefined;
if (typeof process !== "undefined" && Boolean(process.versions?.bun)) {
  try {
    bunTest = await import("bun:test");
  } catch {
    // Non-test Bun runtime environment
  }
}

type TestRunnerGlobal = unknown;
const getGlobal = (name: string): TestRunnerGlobal =>
  (globalThis as Record<string, unknown>)[name] ?? bunTest?.[name];

function createUniversalProxy(name: string): unknown {
  return new Proxy(
    function (this: unknown, ...args: unknown[]) {
      const g = getGlobal(name);
      if (typeof g === "function") {
        return Reflect.apply(g, this, args);
      }
      throw new Error(
        `Testing function '${name}' is not available in the current environment. Ensure tests are executed with a supported runner (e.g. 'funscript test', Vitest, or Bun).`,
      );
    },
    {
      get(_target, prop, receiver) {
        const g = getGlobal(name);
        if (
          g !== null &&
          g !== undefined &&
          typeof g === "object" &&
          prop in g
        ) {
          const val: unknown = Reflect.get(g, prop, receiver);
          return typeof val === "function"
            ? (val as (...args: unknown[]) => unknown).bind(g)
            : val;
        }
        return undefined;
      },
    },
  );
}

export const describe =
  getGlobal("describe") ?? createUniversalProxy("describe");
export const it = getGlobal("it") ?? createUniversalProxy("it");
export const test = getGlobal("test") ?? createUniversalProxy("test");
export const expect = getGlobal("expect") ?? createUniversalProxy("expect");
export const assert = getGlobal("assert") ?? createUniversalProxy("assert");
export const beforeAll =
  getGlobal("beforeAll") ?? createUniversalProxy("beforeAll");
export const beforeEach =
  getGlobal("beforeEach") ?? createUniversalProxy("beforeEach");
export const afterAll =
  getGlobal("afterAll") ?? createUniversalProxy("afterAll");
export const afterEach =
  getGlobal("afterEach") ?? createUniversalProxy("afterEach");
export const vi = getGlobal("vi") ?? createUniversalProxy("vi");

export default {
  describe,
  it,
  test,
  expect,
  assert,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
};
