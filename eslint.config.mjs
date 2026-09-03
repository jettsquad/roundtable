import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `packages/*/client/` is build OUTPUT now, not source. Linting a minified
  // bundle reports nothing useful and hides the fact that its source is
  // `src/client/`.
  { ignores: ["**/node_modules/**", "**/dist/**", "**/lib/**", "packages/*/client/**"] },
  js.configs.recommended,
  { languageOptions: { globals: globals.node } },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
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
    // The rules of hooks, enforced rather than remembered.
    //
    // This project shipped the exact bug they exist to catch: a `useState`
    // placed after `if (!open) return null` in the team panel, which made the
    // sidebar button do nothing at all. It type-checked, it built, it passed
    // every test — the only way to find it was to click the button.
    files: ["packages/*/src/client/**/*.tsx", "packages/*/src/client/**/*.ts"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // Warn, not error: an over-eager dependency array is a correctness
      // question a person has to answer, and failing the build on it teaches
      // people to silence it rather than read it.
      "react-hooks/exhaustive-deps": "warn",
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
    ignores: ["packages/shared/**/*.ts", "packages/seat-runtime/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@squad/*", "!@squad/shared", "!@squad/seat-runtime"],
              message: "插件之间只通过 ctx 上的服务说话，不互相 import。共用的纯逻辑走 @squad/shared。",
            },
          ],
        },
      ],
    },
  },
  {
    // `@squad/seat-runtime` is the second exception, and it is a LIBRARY, not
    // a plugin: it registers no service, provides nothing to a context, and
    // nothing can talk to it through `ctx`. It is the shared body of the
    // three CLI seat backends, which differ only in executable, arguments and
    // output format.
    //
    // The wall exists so plugins talk through services instead of reaching
    // into each other. A library nobody can reach through a service is not
    // what it was defending against — and three hand-kept copies of the
    // run-handle contract, the cancellation wiring and the silence watchdog
    // would drift, with the drifted copy being the one nobody reads.
    //
    // It may not import a plugin, for the same reason shared may not: that
    // would make it a back door.
    files: ["packages/seat-runtime/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@squad/*", "!@squad/shared"],
              message: "seat-runtime 是库不是插件：它可以用 shared，但不得依赖任何插件包。",
            },
          ],
        },
      ],
    },
  },
  {
    // Client bundles run in a browser, not in Node. Their globals are
    // different, and so is what they may import: only the platform module
    // table (react, ui-slots, cordis, …) is resolvable at runtime. Everything
    // else is bundled in, which the build's purity gate enforces — a
    // cross-plugin value import fails there rather than in the page.
    files: ["packages/*/src/client/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    rules: {
      // A plugin's console.log lands in the user's devtools alongside the
      // shell's own output, with nothing saying which plugin wrote it.
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  {
    files: ["**/test/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
