/**
 * @squad/smoke — stage 1's end-to-end check, mounted only by hand.
 *
 * It proves the one thing stage 1 exists to prove: that a host node can be
 * created, a seat can run as a real CLI agent in the project folder, and its
 * answer can come back into the host's session. Everything else waits until
 * this holds.
 *
 * Not part of any shipped composition.
 */
import type { Context } from "@deepseek-ai/cordis";

export const name = "squad-smoke";
export const inject = ["teams"];

export interface Config {
  readonly projectFolder: string;
  readonly instruction: string;
}

export function apply(ctx: Context, config: Config): void {
  void (async () => {
    const line = (text: string) => process.stdout.write(`[smoke] ${text}\n`);
    try {
      line("建团…");
      const team = await ctx.teams.create({
        displayName: "冒烟团队",
        projectFolder: config.projectFolder,
        hostDisplayName: "主持人",
        seats: [
          {
            seatId: "seat-a",
            displayName: "甲",
            role: "通用",
            systemPrompt: "你回答简短，不做多余的事。",
            backend: "claude-code",
          },
        ],
      });
      line(`团队已建：${team.teamId}，主持人 session = ${team.hostSessionId}`);

      line(`发指令：${config.instruction}`);
      const replies = await team.ask(config.instruction);
      for (const reply of replies) {
        line(`回复 ← ${reply.displayName}${reply.failed ? "（失败）" : ""}：${reply.text}`);
      }

      await team.dispose();
      line(replies.some((r) => r.failed) ? "结束：有席位失败" : "结束：全部成功");
    } catch (error) {
      line(`失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  })();
}
