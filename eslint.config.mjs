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
      // dsh runs these .ts files through Node's strip-only type removal,
      // which rejects constructor parameter properties. tsc accepts them and
      // vitest transpiles them, so the only thing that catches one is a real
      // boot — the slowest and least specific signal available. Banned here
      // instead.
      "@typescript-eslint/parameter-properties": ["error", { prefer: "class-property" }],
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
    // The wall between plugins. Four plugins are planned and they talk to each
    // other through services on `ctx` — that is the whole architecture. An
    // import is the one way to reach past that contract into a sibling's
    // internals, and once one exists the four services degrade into four
    // directories that happen to import each other.
    //
    // `@squad/shared` is the single exception, and the only package allowed
    // more than one consumer. Deep paths (`@squad/x/src/...`) are already
    // unresolvable — every package exports "." and nothing else — so this
    // closes the remaining door, which is also the comfortable one to walk
    // through by accident.
    //
    // shared has its own stricter rule above and is excluded here so this one
    // does not relax it.
    files: ["packages/*/**/*.ts"],
    ignores: ["packages/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@squad/*", "!@squad/shared"],
              message: "插件之间只通过 ctx 上的服务说话，不互相 import。共用的纯逻辑走 @squad/shared。",
            },
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
