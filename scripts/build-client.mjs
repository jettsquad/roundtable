/**
 * build-client.mjs — the browser half of every Squad package that has one.
 *
 * The first client was written by hand as one CJS blob, deliberately: the
 * unknown then was whether an out-of-repo package can be discovered and
 * registered into a slot at all, and a build pipeline in the same step would
 * have meant a failure could be either. That chain is proven, so this
 * replaces the blob — and with it the two things a hand-written bundle
 * cannot have: JSX, and the ability to import `@squad/shared`, so a rule like
 * "which caps can bind under this auth mode" is the SAME function in the
 * browser as in the host rather than a second copy that drifts.
 *
 * The output contract is DSH's, from `packages/client/tsdown.client.ts`, and
 * it is restated here rather than imported because that preset lives in the
 * harness repo and reaches into it (`./web/src/platform.ts`, its workspace
 * layout, its sourcemap rebasing). What must match is the artifact:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *
 * a CJS module whose externals are answered by the injected `require` from
 * the frozen platform module table. Anything the table cannot answer is a
 * guaranteed runtime throw, so the rule is: table entries stay external,
 * everything else inlines.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The specifiers the shell shares into the frozen module table.
 *
 * Copied from `@deepseek-ai/dsh-client-web/src/platform.ts`. A copy is a
 * liability, so `checkPlatformTable` below reads the harness's own list at
 * build time and fails if they have diverged — the copy exists to be checked,
 * not trusted.
 */
const PLATFORM_MODULES = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-web-react",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-attachment",
  "@deepseek-ai/dsh-client-schema-form",
];

/**
 * Fail the build if our copy of the table no longer matches the harness's.
 *
 * A drifted table does not fail loudly at runtime — a specifier that moved
 * out of the table gets inlined instead, and the plugin then holds its own
 * duplicate React with its own hooks dispatcher, which surfaces as
 * "Invalid hook call" somewhere unrelated. Skipped, with a warning, when the
 * harness source is not on this machine: a missing checkout should not stop a
 * build, but it must not pass silently either.
 */
async function checkPlatformTable(harness) {
  const source = join(harness, "packages/client/web/src/platform.ts");
  if (!existsSync(source)) {
    console.warn(`⚠️  没找到 ${source}，跳过平台模块表比对——这次构建没验证过外部依赖表。`);
    return;
  }
  const text = await readFile(source, "utf8");
  const body = text.slice(text.indexOf("PLATFORM_MODULES = ["));
  const theirs = [...body.slice(0, body.indexOf("]")).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const missing = theirs.filter((name) => !PLATFORM_MODULES.includes(name));
  const extra = PLATFORM_MODULES.filter((name) => !theirs.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      "平台模块表和 DSH 的不一致了。\n" +
        (missing.length > 0 ? `  DSH 有我们没有：${missing.join(", ")}\n` : "") +
        (extra.length > 0 ? `  我们有 DSH 没有：${extra.join(", ")}\n` : "") +
        "  多出来的会被打进包里，React 会有第二份，报出来的错是别处的 Invalid hook call。",
    );
  }
}

/**
 * Build-time mirror of the module-edge rule.
 *
 * Any `@deepseek-ai/*` import that is not a platform module is a build error
 * rather than a runtime one. Inlining a cross-plugin package either
 * duplicates a runtime instance that was supposed to be shared, or asks the
 * frozen table for a specifier it cannot answer; both fail far from here.
 * Cross-plugin collaboration goes through cordis services. Type-only imports
 * are erased before this ever sees them.
 */
const purityGate = {
  name: "squad-client-purity",
  setup(build) {
    build.onResolve({ filter: /^@deepseek-ai\// }, (args) => {
      if (PLATFORM_MODULES.includes(args.path)) return { path: args.path, external: true };
      throw new Error(
        `「${args.path}」不是平台模块（${args.importer} 引的）。` +
          `跨插件的值引用是不允许的——要协作就走 cordis service，类型引用用 import type。`,
      );
    });
  },
};

/** One package's browser half. */
export async function buildClient(pkg, { watch = false, dev = false } = {}) {
  const id = `@squad/${pkg}`;
  const options = {
    entryPoints: [join(root, "packages", pkg, "src/client/index.tsx")],
    outfile: join(root, "packages", pkg, "client/client.js"),
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    // CSS Modules: `import styles from "./x.module.css"` yields the hashed
    // class map. Hashed rather than plain, so a class name here cannot
    // collide with one from the shell or another plugin — the panel renders
    // inside the shell's own DOM.
    //
    // esbuild emits the compiled text as a SIDECAR .css file, and a plugin
    // bundle has no HTML to link one from: left alone, the classes resolve
    // and every rule is missing. `inlineStyles` below folds the text back
    // into the factory, which is what DSH's own preset does for the same
    // reason.
    loader: { ".module.css": "local-css" },
    write: false,
    sourcemap: dev ? "inline" : true,
    minify: !dev,
    define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
    external: PLATFORM_MODULES,
    plugins: [purityGate],
    // The closure-factory handoff. `intro` is not an esbuild option, so the
    // CJS preamble rides in the banner ahead of esbuild's own output.
    banner: {
      js:
        `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {\n` +
        "var module = { exports: {} }; var exports = module.exports;",
    },
    footer: { js: "return module.exports; } });" },
    logLevel: "warning",
  };

  if (watch) {
    const esbuild = await import("esbuild");
    const context = await esbuild.context({
      ...options,
      plugins: [...options.plugins, { name: "squad-emit", setup: (b) => b.onEnd((r) => void emit(id, options, r)) }],
    });
    await context.watch();
    console.log(`👀 ${id}/client 监听中`);
    return;
  }
  await emit(id, options, await build(options));
}

/**
 * Fold the sidecar stylesheet into the factory and write the artifact.
 *
 * The injected tag carries `data-plugin`, which is how the loader finds and
 * removes a plugin's styles when it unloads — a plugin that leaves its rules
 * behind after unloading is a plugin that keeps styling a shell that no
 * longer contains it. Idempotent, because a factory can be re-evaluated.
 */
async function emit(id, options, result) {
  const outputs = result.outputFiles ?? [];
  const js = outputs.find((file) => file.path.endsWith(".js"));
  const css = outputs.find((file) => file.path.endsWith(".css"));
  const map = outputs.find((file) => file.path.endsWith(".map"));
  if (js === undefined) throw new Error(`${id}: esbuild 没有产出 js。`);

  let text = js.text;
  if (css !== undefined) {
    const marker = "var module = { exports: {} }; var exports = module.exports;";
    const at = text.indexOf(marker);
    if (at < 0) throw new Error(`${id}: 在产物里找不到 CJS 前导，样式注入不进去。`);
    const injector =
      `\n(function () { var tag = document.querySelector('style[data-plugin=${JSON.stringify(id)}]');` +
      ` if (tag === null) { tag = document.createElement('style'); tag.dataset.plugin = ${JSON.stringify(id)};` +
      ` document.head.appendChild(tag); } tag.textContent = ${JSON.stringify(css.text)}; })();\n`;
    text = text.slice(0, at + marker.length) + injector + text.slice(at + marker.length);
  }

  await writeFile(options.outfile, text, "utf8");
  if (map !== undefined) await writeFile(`${options.outfile}.map`, map.text, "utf8");
  const kb = (Buffer.byteLength(text) / 1024).toFixed(1);
  console.log(
    `✅ ${id}/client → ${kb} KB${css === undefined ? "" : `（含 ${(css.text.length / 1024).toFixed(1)} KB 样式）`}`,
  );
}

/** Packages with a browser half, by the presence of `src/client/index.tsx`. */
export function clientPackages() {
  return ["console"].filter((pkg) => existsSync(join(root, "packages", pkg, "src/client/index.tsx")));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const watch = process.argv.includes("--watch");
  const dev = watch || process.argv.includes("--dev");
  const harness = process.env.DSH_SOURCE ?? join(process.env.HOME ?? "", ".local/share/roundtable/deepseek-harness");
  await checkPlatformTable(harness);
  const packages = clientPackages();
  if (packages.length === 0) throw new Error("没有找到带 src/client/index.tsx 的包。");
  for (const pkg of packages) await buildClient(pkg, { watch, dev });
}
