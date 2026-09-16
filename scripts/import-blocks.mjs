/**
 * import-blocks.mjs — turn a folder of Markdown files into prompt blocks.
 *
 * Why this exists rather than a seed list in the repository: the blocks
 * worth having here are the person's OWN standing instructions — their
 * problem-solving framework, the principles they work by. This repository is
 * public. Content that is theirs stays on their machine, so the SOURCE lives
 * under `$DSH_HOME/block-seeds` and only the mechanism is in git.
 *
 * It is also the smallest thing that is repeatable. Blocks are meant to be
 * written and edited on the 提示词块 page, and this does not replace that —
 * it is for the first load, when what you want to say already exists as
 * files. Drop a `.md` in, run this, edit it in the browser afterwards.
 *
 *     node scripts/import-blocks.mjs            # import
 *     node scripts/import-blocks.mjs --dry-run  # say what it would do
 *
 * File format: the first `# Heading` line is the block's NAME, everything
 * after it is the block's text. A file whose name already exists as a block
 * is SKIPPED, not overwritten — an import that clobbers the wording you
 * fixed by hand is an import you cannot run twice.
 */
import { createConnection } from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh-squad-dev");
const seedDir = join(dshHome, "block-seeds");
const storePath = join(dshHome, "storages", "squad_prompt_blocks.json");
const dryRun = process.argv.includes("--dry-run");

/**
 * Refuse to write while the UI is up.
 *
 * The server holds this table in memory and writes it back whole, so an edit
 * made underneath it is not merely racy — it is reliably lost at the next
 * save, which is the worst shape a failure can have: the script reports
 * success and the blocks are gone an hour later.
 */
const portInUse = (port) =>
  new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port })
      .on("connect", () => (socket.end(), resolve(true)))
      .on("error", () => resolve(false));
    socket.setTimeout(700, () => (socket.destroy(), resolve(false)));
  });

const port = Number(process.env.SQUAD_PORT ?? 9527);
if (!dryRun && (await portInUse(port))) {
  console.error(`Squad 正在 ${port} 上跑着。先停掉它再导入——不然这次写进去的块，会在它下次存盘时被覆盖掉。`);
  process.exit(1);
}

if (!existsSync(seedDir)) {
  mkdirSync(seedDir, { recursive: true });
  console.log(`建好了 ${seedDir}。往里放 .md 文件，第一行 "# 名字" 是块名，剩下的是正文，然后再跑一次。`);
  process.exit(0);
}

const files = readdirSync(seedDir)
  .filter((file) => file.endsWith(".md"))
  .sort();
if (files.length === 0) {
  console.log(`${seedDir} 里没有 .md 文件。`);
  process.exit(0);
}

const store = existsSync(storePath)
  ? JSON.parse(readFileSync(storePath, "utf8"))
  : { unit: { name: "squad_prompt_blocks", version: 1 }, global: null, tables: { blocks: {} } };
const blocks = (store.tables ??= {}).blocks ?? (store.tables.blocks = {});
const taken = new Set(Object.values(blocks).map((block) => block.name));

const now = Date.now();
let added = 0;
for (const file of files) {
  const raw = readFileSync(join(seedDir, file), "utf8");
  const match = /^#\s+(.+)$/m.exec(raw);
  if (match === null) {
    console.warn(`跳过 ${file}：没有 "# 名字" 那一行，不知道该叫它什么。`);
    continue;
  }
  const name = match[1].trim();
  const text = raw.slice(match.index + match[0].length).trim();
  if (text === "") {
    console.warn(`跳过 ${file}：只有标题，没有正文。`);
    continue;
  }
  if (taken.has(name)) {
    console.log(`已存在，跳过：${name}`);
    continue;
  }
  const blockId = `blk-${now.toString(36)}-${added.toString(36)}`;
  if (!dryRun) blocks[blockId] = { blockId, name, text, enabled: true, createdAt: now, updatedAt: now };
  taken.add(name);
  added += 1;
  console.log(`${dryRun ? "会新增" : "新增"}：${name}（${text.length} 字）`);
}

if (added === 0) {
  console.log("没有要新增的。");
} else if (dryRun) {
  console.log(`\n共 ${added} 条。去掉 --dry-run 真正写入。`);
} else {
  writeFileSync(storePath, JSON.stringify(store, null, 2));
  console.log(`\n写入 ${added} 条到 ${storePath}。启动 Squad，在「提示词块」页就能看到；给哪个席位用，在团队里选。`);
}
