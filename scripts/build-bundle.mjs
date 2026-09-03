/**
 * build-bundle.mjs — compile the workspace into the one package users install.
 *
 * Why a build exists at all, when development runs the `.ts` directly: Node
 * REFUSES to strip types from files under `node_modules`
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). Development gets away with
 * it because the profile's entries are symlinks whose realpath lands back in
 * this repository — exactly the condition publishing removes.
 *
 * Why ONE package with nine entry points rather than nine packages: dsh's
 * client-modules resolves every Loader row to its PACKAGE and reconciles per
 * package, so nine rows of `@jettsquad/roundtable/*` produce a single browser
 * bundle. And `splitting` puts `@squad/shared` and `@squad/seat-runtime` into
 * shared chunks instead of copying them into nine outputs — a copy would not
 * merely be bigger, it would be nine module states where the design assumes
 * one.
 */
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClient } from "./build-client.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "@jettsquad/roundtable";
const bundleDir = join(root, "bundle");
const outDir = join(bundleDir, "lib");

/**
 * The plugin rows, as `<export name> → <source>`.
 *
 * Kept beside the patch rather than derived from it: a row that lost its
 * entry point should fail HERE, at build time, rather than at a user's boot.
 */
const ENTRIES = {
  connections: "packages/connections/src/index.ts",
  "seat-claude-code": "packages/seat-claude-code/src/index.ts",
  "seat-codex": "packages/seat-codex/src/index.ts",
  "seat-dsh": "packages/seat-dsh/src/index.ts",
  table: "packages/table/src/index.ts",
  context: "packages/context/src/index.ts",
  secretary: "packages/secretary/src/index.ts",
  console: "packages/console/src/index.ts",
  reasoning: "packages/reasoning/src/index.ts",
  // Not a row. The dsh seat hands this path to a CHILD dsh process, which
  // loads it as a plugin of its own — so it must survive as its own file
  // rather than be inlined into seat-dsh.
  heartbeat: "packages/seat-dsh/src/heartbeat.ts",
};

/**
 * What must NOT be bundled.
 *
 * The `@deepseek-ai/*` family and zod are peer dependencies resolved from the
 * profile's parent-walk to the harness's own farm. Bundling any of them would
 * hand the process a second cordis (two service registries, two `Symbol.for`
 * identities) or a second zod (schemas the storage domain rejects as "not a
 * zod schema"). The two parsers are dynamic imports and stay real
 * dependencies: they are large, optional in practice, and pull native-ish
 * code we have no business inlining.
 */
const EXTERNAL = ["@deepseek-ai/*", "zod", "pdf-parse", "mammoth"];

/** Check every declared export actually points at a built file. */
async function checkExports() {
  const manifest = JSON.parse(await readFile(join(bundleDir, "package.json"), "utf8"));
  const missing = [];
  for (const [name, target] of Object.entries(manifest.exports)) {
    if (typeof target !== "string" || !target.startsWith("./lib/")) continue;
    if (!existsSync(join(bundleDir, target))) missing.push(`${name} → ${target}`);
  }
  if (missing.length > 0) {
    throw new Error(`package.json 的 exports 指向了不存在的产物：\n  ${missing.join("\n  ")}`);
  }
  return manifest;
}

/**
 * Check the patch's rows resolve to declared exports, and that exactly one of
 * them is the BARE package name.
 *
 * The bare-name row is not a style choice. dsh decides whether a Loader row
 * can contribute a browser bundle with `exactPackageSpecifier`, which accepts
 * a scoped specifier only when it has exactly two segments — so a row named
 * `@jettsquad/roundtable/console` is classified as permanently not a client row.
 * The failure is silent and asymmetric: every host plugin loads, the panel
 * and the slash commands simply do not exist, and the server log says
 * nothing. Costing an afternoon once is enough.
 */
async function checkPatchRows(manifest) {
  const patch = await readFile(join(bundleDir, "cordis.patch.yml"), "utf8");
  const rows = [...patch.matchAll(/^\s+name:\s*'(@jettsquad\/[^']+)'/gm)].map((match) => match[1]);
  const unknown = rows.filter((row) => {
    const key = row === PACKAGE ? "." : `.${row.slice(PACKAGE.length)}`;
    return manifest.exports[key] === undefined;
  });
  if (unknown.length > 0) throw new Error(`patch 里的行没有对应的 export：${unknown.join(", ")}`);
  const bare = rows.filter((row) => row === PACKAGE);
  if (bare.length !== 1) {
    throw new Error(
      `带浏览器半边的那一行必须用裸包名 '${PACKAGE}'，现在有 ${bare.length} 行这样。\n` +
        `子路径行不会被 dsh 认成 client 行——宿主插件照常加载，面板和斜杠命令整个不出现，日志里一个字都没有。`,
    );
  }
  return rows.length;
}

export async function buildBundle() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const entryPoints = Object.fromEntries(
    Object.entries(ENTRIES).map(([name, source]) => {
      const path = join(root, source);
      if (!existsSync(path)) throw new Error(`入口不存在：${source}`);
      return [name, path];
    }),
  );

  await build({
    entryPoints,
    outdir: outDir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node22",
    external: EXTERNAL,
    sourcemap: true,
    logLevel: "warning",
  });

  // The browser half is built by its own script (its externals are the
  // shell's frozen module table, which has nothing to do with Node's), then
  // copied in under the name `exports["./client"]` promises.
  await buildClient("console", { id: PACKAGE });
  await cp(join(root, "packages/console/client/client.js"), join(outDir, "client.js"));

  const readme = join(root, "bundle/README.md");
  if (!existsSync(readme)) await writeFile(readme, `# ${PACKAGE}\n`);

  // The licence is the repository's, copied in rather than duplicated: two
  // files that must say the same thing eventually do not.
  await cp(join(root, "LICENSE"), join(bundleDir, "LICENSE"));

  const manifest = await checkExports();
  const rows = await checkPatchRows(manifest);
  return { entries: Object.keys(ENTRIES).length, rows };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { entries, rows } = await buildBundle();
  console.log(`✅ ${PACKAGE} → bundle/lib（${entries} 个入口，patch ${rows} 行，全部对得上）`);
}
