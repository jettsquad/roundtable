/**
 * locales.ts — the `squad` namespace dictionaries.
 *
 * `zh` is the key-set source of truth: `ctx.locale.register` type-checks `en`
 * against the key union declared for the namespace, so a key that exists in
 * one language and not the other fails at compile time rather than showing a
 * user the raw key.
 *
 * Keys are `area.thing`, named for what the string IS rather than what it
 * says — `panel.tab.blocks`, not `panel.tab.promptLibrary` — so rewording the
 * Chinese does not orphan the English.
 *
 * Not everything belongs here. Text that a MODEL reads (seat prompts, the
 * secretary's instructions, the designer seed) is not UI copy: it decides what
 * language the agents answer in, and some of it is load-bearing in ways a
 * translation would break — JSON keys that must stay English, phase titles
 * that feed a confirmation hash. That half is a separate problem.
 */

/** Simplified Chinese — the key-set source of truth. */
export const zh = {
  "panel.open": "团队 ▾",
  "panel.closed": "团队 ▸",
  "panel.close": "关闭",
  "panel.tab.teams": "团队",
  "panel.tab.agents": "Agent 库",
  "panel.tab.blocks": "提示词库",
  "panel.tab.connections": "连接",
  "panel.tab.criteria": "判据",
  "panel.count": "（{n}）",
  "panel.criteria.pending": "{n} 条判据待裁定 →",
  "panel.search": "搜团队名、文件夹、成员……",
} as const;

/** The keys this namespace owns. */
export type SquadKey = keyof typeof zh;

/** English. Must cover exactly the same keys. */
export const en: Record<SquadKey, string> = {
  "panel.open": "Teams ▾",
  "panel.closed": "Teams ▸",
  "panel.close": "Close",
  "panel.tab.teams": "Teams",
  "panel.tab.agents": "Agents",
  "panel.tab.blocks": "Prompts",
  "panel.tab.connections": "Connections",
  "panel.tab.criteria": "Criteria",
  "panel.count": " ({n})",
  "panel.criteria.pending": "{n} criteria awaiting a ruling →",
  "panel.search": "Search teams, folders, members…",
};
