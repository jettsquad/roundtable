/**
 * agenda-check.ts — refuse an exit check that cannot fail.
 *
 * A check is the only thing that turns "somebody replied" into "the work is
 * there", and it says so by its exit code. A command that exits 0 whatever
 * the project looks like is therefore not a weak check but no check: the
 * phase passes the moment it runs. One agenda ended its last phase on
 * `test -s ACCEPTANCE.md && git log --oneline -1 --grep='批次完成'` — and
 * `git log` exits 0 when nothing matches, so a batch that was never
 * committed read as committed.
 *
 * Static and deliberately narrow: it recognises the shapes that are known to
 * pass vacuously. It cannot prove a command is a good check, only refuse the
 * ones that cannot be bad.
 */

/** Commands whose exit code does not depend on what they were asked to look at. */
const NEVER_FAILS = new Set([
  "true",
  ":",
  "echo",
  "printf",
  "pwd",
  "date",
  "sleep",
  "head",
  "tail",
  "wc",
  "cat",
  "sort",
  "uniq",
  "tee",
  "cut",
  "tr",
  "sed",
  "awk",
]);

/** `git` subcommands that report and exit 0 unless asked to fail on what they find. */
const GIT_REPORTS = new Set(["log", "show", "status", "branch", "diff", "tag", "rev-list", "shortlog"]);

/**
 * Split on a separator outside quotes. `||` is kept apart from `|`, and `&&`
 * from `&`, so a chain and a pipeline are not confused.
 */
function splitOutsideQuotes(text: string, separators: readonly string[]): readonly string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quote !== undefined) {
      current += char;
      if (char === quote && text[index - 1] !== "\\") quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    const sep = separators.find((candidate) => text.startsWith(candidate, index));
    if (sep !== undefined) {
      parts.push(current);
      current = "";
      index += sep.length - 1;
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

const firstWord = (segment: string): string => {
  const words = segment.replace(/^\(+|^\{\s*/, "").split(/\s+/);
  // Past leading `VAR=value` assignments and `cd dir &&`-style prefixes handled by the splitter.
  const word = words.find((candidate) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(candidate));
  return word ?? "";
};

/** Whether one simple command is of a kind that exits 0 whatever it finds. */
function neverFails(segment: string): boolean {
  const word = firstWord(segment);
  if (NEVER_FAILS.has(word)) return true;
  if (word === "exit") return /^exit\s+0?\s*$/.test(segment.trim()) || segment.trim() === "exit";
  if (word !== "git") return false;
  const rest = segment.trim().split(/\s+/).slice(1);
  const sub = rest.find((token) => !token.startsWith("-"));
  if (sub === undefined || !GIT_REPORTS.has(sub)) return false;
  // `git diff --exit-code` and `--quiet` are the asserting forms.
  return !/(^|\s)(--exit-code|--quiet)(\s|$)/.test(segment);
}

/** A `git log`-style search whose output nobody looks at. */
function unassertedSearch(pipeline: readonly string[]): boolean {
  const first = pipeline[0] ?? "";
  if (firstWord(first) !== "git") return false;
  const sub = first
    .trim()
    .split(/\s+/)
    .slice(1)
    .find((token) => !token.startsWith("-"));
  if (sub !== "log" && sub !== "show" && sub !== "rev-list") return false;
  const searches = /(^|\s)(--grep(=|\s)|-S\S*|-G\S*|--author(=|\s))/.test(first);
  if (!searches) return false;
  // Asserted only when something downstream can fail on empty output.
  const last = pipeline[pipeline.length - 1] ?? "";
  return pipeline.length === 1 || NEVER_FAILS.has(firstWord(last));
}

/**
 * Why this check command cannot fail, or `undefined` when it might.
 *
 * Three shapes are refused:
 *  - nothing in it can fail (`true`, `echo ok`, `git log | head`);
 *  - a failure is swallowed (`|| true`, `; true`, `exit 0`);
 *  - a search of history whose result is never asserted — the
 *    `git log --grep` above. Pipe it to `grep -q .` or wrap it in `test -n`.
 */
export function vacuousCheckReason(command: string): string | undefined {
  const text = command.trim();
  if (text === "") return "检查命令是空的";

  if (/\|\|\s*(true|:|exit\s+0|echo\b)/.test(text) || /;\s*(true|:|exit\s+0)\s*$/.test(text)) {
    return "命令把失败吞掉了（|| true、; true 或 exit 0），无论结果如何都会通过";
  }

  const chain = splitOutsideQuotes(text, ["&&", ";", "\n"]);
  // The stages of a pipe; `||` fallbacks were dealt with above.
  const stagesOf = (link: string): readonly string[] => splitOutsideQuotes(link, ["|"]);

  const everyLinkVacuous = chain.every((link) => {
    const stages = stagesOf(link);
    const last = stages[stages.length - 1] ?? "";
    return neverFails(last);
  });
  if (everyLinkVacuous) return "命令里没有任何一步会失败（只是输出信息），退出码永远是 0";

  for (const link of chain) {
    if (unassertedSearch(stagesOf(link))) {
      return "它搜索提交历史（git log --grep 等），但没人检查有没有搜到：没匹配也退出 0。后面接 | grep -q . ，或者用 test -n 包住整条命令的输出";
    }
  }
  return undefined;
}
