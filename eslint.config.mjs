import js from "@eslint/js";
import tseslint from "typescript-eslint";
import effectPlugin from "@effect/eslint-plugin";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "examples/**",
      "slopboss/**",
      "tests/fixtures/**",
      "scripts/**",
      "editors/**/dist/**",
      "editors/**/node_modules/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    plugins: {
      "@effect": effectPlugin,
    },
    rules: {
      // General code quality
      "no-empty": "error",
      "prefer-const": "error",
      "no-useless-escape": "error",
      "no-case-declarations": "off",
      eqeqeq: ["error", "always"],

      // Effect rules
      "@effect/no-import-from-barrel-package": [
        "error",
        { packageNames: ["effect"] },
      ],

      // TypeScript type-safety rules
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
          disallowTypeAnnotations: false,
        },
      ],
      "@typescript-eslint/no-this-alias": [
        "error",
        { allowedNames: ["self", "receiver"] },
      ],
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
    },
  },
  // In recursive-descent parsers, while-loops consuming tokens have empty bodies
  {
    files: ["src/parser/parser.ts"],
    rules: {
      "no-empty": "off",
    },
  },
);
