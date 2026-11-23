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
      "editors/**",
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
      "no-empty": ["error", { allowEmptyCatch: true }],
      "prefer-const": "error",
      "no-useless-escape": "error",
      "no-case-declarations": "off",

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
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "@typescript-eslint/no-duplicate-enum-values": "off", // Intentional compatibility aliases in TokenType
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Compiler & AST data-structure pragmatism
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
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
