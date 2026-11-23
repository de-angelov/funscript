import * as vitest from "vitest";

const getGlobal = (name: string): any => (globalThis as any)[name];

export const describe = getGlobal("describe") ?? vitest.describe;
export const it = getGlobal("it") ?? vitest.it;
export const test = getGlobal("test") ?? vitest.test;
export const expect = getGlobal("expect") ?? vitest.expect;
export const assert = getGlobal("assert") ?? vitest.assert;
export const beforeAll = getGlobal("beforeAll") ?? vitest.beforeAll;
export const beforeEach = getGlobal("beforeEach") ?? vitest.beforeEach;
export const afterAll = getGlobal("afterAll") ?? vitest.afterAll;
export const afterEach = getGlobal("afterEach") ?? vitest.afterEach;
export const vi = getGlobal("vi") ?? vitest.vi;

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
