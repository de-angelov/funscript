import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as EffectPackage from "effect";
import {
  EFFECT_PIPELINE_CATALOG_VERSION,
  EFFECT_PIPELINE_COMPATIBILITY_ALIASES,
  PIPELINE_COMPANION_CATALOG,
} from "../src/emitter/pipeline-catalog.js";

describe("pipeline companion catalog", () => {
  it("is locked to, and valid for, the installed Effect declaration surface", async () => {
    const effectPackage = JSON.parse(await readFile("node_modules/effect/package.json", "utf8")) as { version: string };
    expect(effectPackage.version).toBe(EFFECT_PIPELINE_CATALOG_VERSION);

    for (const [module, operations] of Object.entries(PIPELINE_COMPANION_CATALOG)) {
      const namespace = EffectPackage[module as keyof typeof EffectPackage] as Record<string, unknown>;
      const declarations = await readFile(`node_modules/effect/dist/${module}.d.ts`, "utf8");
      for (const operation of operations) {
        expect(namespace[operation], `${module}.${operation} must be a public Effect export`).toBeTypeOf("function");
        expect(declarations, `${module}.${operation} must retain a data-last self overload`).toContain(`export declare const ${operation}`);
      }
    }
  });

  it("keeps compatibility aliases mapped to public Effect exports", () => {
    for (const [alias, target] of Object.entries(EFFECT_PIPELINE_COMPATIBILITY_ALIASES)) {
      expect(alias).not.toBe(target);
      expect(EffectPackage.Effect[target as keyof typeof EffectPackage.Effect]).toBeTypeOf("function");
    }
  });
});
