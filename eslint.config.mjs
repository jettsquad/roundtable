import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/lib/**"] },
  js.configs.recommended,
  { languageOptions: { globals: globals.node } },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // A silent drop is this project's recurring bug family: an unused
      // binding is usually a branch that stopped doing what it says.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  {
    // The smoke plugin's whole output is what it prints, and the scripts are
    // command-line tools whose console output is their interface.
    files: ["packages/smoke/**/*.ts", "scripts/*.mjs"],
    rules: { "no-console": "off" },
  },
  {
    // @squad/shared is pure functions and nothing else. The moment it can reach
    // a service it stops being shared logic and becomes a second home for
    // behaviour, and the plugin boundaries survive only on paper.
    files: ["packages/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@deepseek-ai/*"], message: "shared 只放纯函数：需要服务的东西属于拥有该服务的插件。" },
            { group: ["@squad/*"], message: "shared 是最底层，不得依赖任何插件包。" },
            { group: ["node:fs", "node:child_process", "node:net", "node:http*"], message: "shared 不做 I/O。" },
          ],
        },
      ],
    },
  },
  {
    files: ["**/test/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
