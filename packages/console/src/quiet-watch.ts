/**
 * quiet-watch.ts — a quiet command, taken to somebody who can judge it.
 *
 * The runtime notices that a seat has written nothing for a whole window
 * while a command it started is still open, and that is all it can know. It
 * is told here, because this is the one place that can reach both the team
 * the seat belongs to and the secretary who can say whether to keep waiting.
 *
 * Whatever happens, the seat gets a verdict. No secretary, the secretary
 * being the quiet seat, the secretary failing to answer — each of those ends
 * in `ask`, with the reason, because a command nobody managed to judge is one
 * the host should be shown rather than one to go on waiting for in silence.
 */
import { open } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import { onQuietCommand, setQuietVerdict, type QuietCommand, type QuietVerdict } from "@squad/seat-runtime";

type Team = NonNullable<ReturnType<Context["teams"]["get"]>>;

/**
 * How much of a command's own output to read for the secretary. The prompt
 * cuts to its own limit; this only bounds what is read off disk.
 */
const TAIL_CHARS = 2000;

/**
 * How long the secretary gets to say whether to wait.
 *
 * Two lines from a model that was told not to use tools: observed at about
 * thirteen seconds. Long enough for a slow one, short against the window it
 * is judging.
 */
export const JUDGEMENT_TIMEOUT_MS = 90_000;

/** The team whose host node a seat is running under. */
function teamFor(ctx: Context, parentSessionId: string): Team | undefined {
  for (const teamId of ctx.teams.list()) {
    const team = ctx.teams.get(teamId);
    if (team !== undefined && String(team.host.session.id) === parentSessionId) return team;
  }
  return undefined;
}

/**
 * The end of a file, or nothing.
 *
 * Read from the end and bounded: a command's output can be gigabytes, and
 * only its last screen says whether it is still getting anywhere.
 */
export async function tailOf(path: string, chars = TAIL_CHARS): Promise<string | undefined> {
  try {
    const file = await open(path, "r");
    try {
      const { size } = await file.stat();
      // Bytes, not characters: four per character is the most UTF-8 takes, so
      // this never reads less than was asked for.
      const length = Math.min(size, chars * 4);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, size - length);
      return buffer.toString("utf8").slice(-chars);
    } finally {
      await file.close();
    }
  } catch {
    // Gone, unreadable, or never written. The judgement goes ahead without it.
    return undefined;
  }
}

/** What to record when the secretary could not be asked. */
export function unjudged(why: string, at = Date.now()): QuietVerdict {
  return { verdict: "ask", reason: why, at, by: "system" };
}

async function judge(ctx: Context, quiet: QuietCommand): Promise<QuietVerdict> {
  const team = teamFor(ctx, quiet.parentSessionId);
  // Not a seat at a table: a secretary's own task, or the configuration test.
  // Nothing here can say who to ask about it.
  if (team === undefined) return unjudged("找不到这个席位所在的团队，没有人能判断该不该等。");
  const seat = team.seats.find((one) => one.displayName === quiet.label);
  if (seat === undefined) return unjudged("这不是名册上的席位，没有人能判断该不该等。");
  const secretary = team.secretary;
  if (secretary === undefined) return unjudged("这支团队没有秘书，所以直接请你看。");
  if (seat.isSecretary === true) return unjudged("安静的正是秘书自己，所以直接请你看。");

  const now = Date.now();
  const commands = await Promise.all(
    (quiet.activity.doing ?? []).map(async (one) => ({
      command: one.command,
      runningForMs: now - one.startedAt,
      background: one.background,
      outputTail: one.outputFile === undefined ? undefined : await tailOf(one.outputFile),
    })),
  );
  // The secretary is a model, and a model can fail to answer for the same
  // reasons a seat can. A judgement that never comes back is the worst
  // outcome there is — the command goes unjudged AND looks judged, because
  // the last verdict stays on screen — so it is given a bounded time and
  // then the host is shown the command.
  const patience = new AbortController();
  const timer = setTimeout(() => patience.abort(new Error("timeout")), JUDGEMENT_TIMEOUT_MS);
  try {
    const judged = await ctx.secretary.judgeQuiet({
      parent: team.host,
      secretary,
      signal: patience.signal,
      seat: seat.displayName,
      commands,
      quietForMs: quiet.quietForMs,
      lastWords: quiet.activity.lastWords,
    });
    return { ...judged, at: Date.now(), by: "secretary" };
  } catch (failure) {
    if (patience.signal.aborted) {
      return unjudged(`秘书 ${Math.round(JUDGEMENT_TIMEOUT_MS / 1000)} 秒内没有给出判断，所以直接请你看。`);
    }
    return unjudged(
      `秘书没能给出判断（${String((failure as Error).message ?? failure).slice(0, 120)}），所以直接请你看。`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start listening. Returns the function that stops.
 *
 * One judgement at a time per seat: the secretary is a model and may take
 * longer than it should, and a second window elapsing meanwhile must not
 * start a second judgement of the same silence.
 */
export function watchQuietCommands(ctx: Context): () => void {
  const judging = new Set<string>();
  return onQuietCommand((quiet) => {
    if (judging.has(quiet.key)) return;
    judging.add(quiet.key);
    void judge(ctx, quiet)
      .then((verdict) => {
        setQuietVerdict(quiet.key, verdict);
        const command = quiet.activity.doing?.[0]?.command ?? "";
        teamFor(ctx, quiet.parentSessionId)?.noteQuiet(
          `${quiet.label} 的命令安静了 ${Math.round(quiet.quietForMs / 60_000)} 分钟（${command}）。` +
            `${verdict.by === "secretary" ? "秘书" : "系统"}判断：${verdict.verdict === "wait" ? "继续等" : "请主持人看"}——${verdict.reason}`,
        );
      })
      .catch((failure: unknown) => ctx.logger.warn(`quiet-watch: ${String(failure)}`))
      .finally(() => judging.delete(quiet.key));
  });
}
