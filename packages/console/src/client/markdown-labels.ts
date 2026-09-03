/**
 * markdown-labels.ts — the chrome strings `MarkdownText` now requires.
 *
 * dsh 0.1.2 made the labels a required prop instead of English defaults,
 * which is the right call for a localized shell: a default in one language is
 * a silent decision that every other language has to discover by looking at
 * the screen. Squad's surface is Chinese throughout, so it answers once, here,
 * rather than at each of the call sites that render model output.
 */
import type { MarkdownLabels } from "@deepseek-ai/dsh-client-ui-primitives";

export const MARKDOWN_LABELS: MarkdownLabels = {
  code: { copyLabel: "复制", copiedLabel: "已复制" },
  footnotes: "脚注",
};
