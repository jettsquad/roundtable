/**
 * @squad/console — the slash commands that make Squad usable by a person.
 *
 * Commands, deliberately, and not tools an agent may call. A model that chose
 * which seats to ask would be chairing the meeting — the one thing this
 * product must not be — and the invariant that the host node runs no turns is
 * worth nothing if the surface above it puts an LLM back in the chair. The
 * registry never submits a command to the model, and results are rendered by
 * the UI without entering model history, so the whole path is deterministic:
 * a person typed it, code ran.
 *
 * That also makes this the "system channel" the Lil X design asks for —
 * physically separate from the discussion, and unable to reach a seat's
 * prompt because nothing here writes into the team record except the round
 * the host actually asked for.
 */
import { Service, type Context } from "@deepseek-ai/cordis";
// Imported for its type AND for the `Context.commands` declaration merging it
// carries: an augmentation only applies where its module is part of the
// compilation, so without this `ctx.commands` does not exist as far as tsc is
// concerned — while working perfectly at runtime, which is the worst of both.
import type { CommandInvocation } from "@deepseek-ai/dsh-commands";
import { createTeamFrom, registerSquadApi } from "./http.ts";
import { parseSay } from "./parse.ts";

/**
 * Derived from the context rather than imported from `@squad/table`.
 *
 * Plugins may not import each other — they talk through services on `ctx` —
 * and a type-only import is still an import. The service's own declaration
 * merging already puts this type in scope, so reaching for it here needs no
 * hole in the wall.
 */
type Team = NonNullable<ReturnType<Context["teams"]["get"]>>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    squadConsole: SquadConsole;
  }
}

export const name = "squad-console";

/**
 * `teams` to drive a table, `commands` to be typed at. `teamContext`,
 * `secretary` and `reasoning` are what the fold, hand-off and criteria
 * commands need — a console that could only start rounds would leave the
 * rest of the system unreachable, which is the state this package exists to
 * end.
 */
export const inject = ["commands", "teams", "teamContext", "secretary", "reasoning", "seatConnections", "webServer"];

export function apply(ctx: Context): void {
  ctx.plugin(SquadConsole);
}

const ok = (text: string) => ({ kind: "success" as const, text });
const bad = (text: string) => ({ kind: "error" as const, text });

export class SquadConsole extends Service {
  static readonly inject = [
    "commands",
    "teams",
    "teamContext",
    "secretary",
    "reasoning",
    "seatConnections",
    "webServer",
  ];

  /** The team commands act on. One console, one table at a time. */
  private current: string | undefined;

  constructor(ctx: Context) {
    super(ctx, "squadConsole");
  }

  async [Service.init](): Promise<void> {
    // The browser half reads through this; every mutation stays on the
    // commands, where a person typed it.
    this.ctx.effect(() => registerSquadApi(this.ctx));

    const register = (
      commandName: string,
      description: string,
      hint: string,
      handler: (raw: string) => Promise<string>,
    ): void => {
      this.ctx.effect(() =>
        this.ctx.commands.register({
          name: commandName,
          description,
          input: { hint },
          handler: async ({ rawInput }: CommandInvocation) => {
            try {
              return ok(await handler(rawInput));
            } catch (error) {
              // Surfaced verbatim. A console that swallowed the reason would
              // leave a person guessing at a grammar they cannot see.
              return bad(error instanceof Error ? error.message : String(error));
            }
          },
        }),
      );
    };

    register("squad-new", "建一支团队", "团队名 | 项目文件夹 | 甲*=角色, 乙=角色（* 标记秘书）", async (raw) => {
      // Through the same function the panel uses. The mapping used to be
      // written twice, and when creation learned to designate a secretary
      // only one copy learned it — the slash command would have gone on
      // building teams with no secretary and saying nothing.
      const teamId = await createTeamFrom(this.ctx, raw);
      const team = this.ctx.teams.get(teamId);
      if (team === undefined) throw new Error(`团队 ${teamId} 建好了却读不回来。`);
      this.current = team.teamId;
      return (
        `已建团队「${team.displayName}」（${team.teamId}），已设为当前团队。\n` +
        `项目文件夹：${team.projectFolder}\n` +
        `席位：${team.seats.map((seat) => `${seat.displayName}（${seat.role}）`).join("、")}\n\n` +
        `接着可以：/squad-say 你的指令`
      );
    });

    register("squad-teams", "列出团队并切换", "留空看列表，或给 teamId 切换", async (raw) => {
      const wanted = raw.trim();
      if (wanted !== "") {
        if (this.ctx.teams.get(wanted) === undefined) return `没有这支团队：${wanted}`;
        this.current = wanted;
        return `当前团队已切到 ${wanted}`;
      }
      const ids = this.ctx.teams.list();
      if (ids.length === 0) return "还没有团队。/squad-new 团队名 | 项目文件夹 | 甲=角色";
      return ids
        .map((id) => {
          const team = this.ctx.teams.get(id);
          return `${id === this.current ? "→" : " "} ${id}  ${team?.displayName ?? ""}`;
        })
        .join("\n");
    });

    register("squad-say", "向当前团队发一条指令", "指令，或「甲,乙: 指令」只问部分席位", async (raw) => {
      const team = this.team();
      const say = parseSay(
        raw,
        team.seats.map((seat) => seat.displayName),
      );
      const ids = say.named.map(
        (displayName) => team.seats.find((seat) => seat.displayName === displayName)?.seatId ?? "",
      );
      const replies = await team.ask(say.instruction, ids.length > 0 ? ids : undefined);
      return replies
        .map(
          (reply) =>
            `【${reply.displayName}】${reply.failed ? "（失败）" : ""}（看到 ${reply.contextLines} 行上下文）\n${reply.text}`,
        )
        .join("\n\n");
    });

    register("squad-record", "看团队记录", "留空看全部", async () => {
      const team = this.team();
      const spoken = team.transcript().filter((entry) => entry.kind === "user/message" && entry.text !== "");
      return spoken.length === 0 ? "记录是空的。" : spoken.map((entry) => entry.text).join("\n");
    });

    register("squad-window", "看某个席位这一轮会看到什么", "席位名，留空用第一个", async (raw) => {
      const team = this.team();
      const wanted = raw.trim();
      const seat = wanted === "" ? team.seats[0] : team.seats.find((candidate) => candidate.displayName === wanted);
      if (seat === undefined) return `这支团队里没有「${wanted}」。`;
      const window = await this.ctx.teamContext.windowFor(team.teamId, seat.seatId);
      return window.length === 0
        ? `${seat.displayName} 这一轮看不到任何上下文（第一轮就是这样）。`
        : `${seat.displayName} 会看到 ${window.length} 行：\n\n${window.join("\n")}`;
    });

    register("squad-fold", "现在折叠一次，把讨论换成检查点", "无参数", async () => {
      const team = this.team();
      const progress = this.ctx.teamContext.progress(team.teamId);
      const checkpoint = await this.ctx.teamContext.fold(team.teamId);
      return (
        `已折叠（折叠前累计 ${progress.accumulated} / 上限 ${progress.limit}）。\n` +
        `覆盖到 ${checkpoint.coversUpTo}\n\n${checkpoint.text}`
      );
    });

    register("squad-criteria", "看 Lil X 的判据与待裁定", "无参数", async () => {
      const [active, pending] = await Promise.all([this.ctx.reasoning.criteria(), this.ctx.reasoning.pending()]);
      const lines = [`已生效 ${active.length} 条，待你裁定 ${pending.length} 条。`];
      for (const criterion of active) lines.push(`  ✓ ${criterion.claim}`);
      for (const proposal of pending) lines.push(`  ? ${proposal.id}  ${proposal.claim}`);
      if (pending.length > 0) lines.push("", "裁定：/squad-accept <id> 或 /squad-reject <id>");
      return lines.join("\n");
    });

    register("squad-accept", "采纳一条待裁定的判据", "判据 id", async (raw) => {
      const id = raw.trim();
      if (id === "") return "要给一个判据 id。先看 /squad-criteria";
      await this.ctx.reasoning.resolve(id, "accept");
      return `已采纳 ${id}。`;
    });

    register("squad-reject", "否掉一条待裁定的判据", "判据 id", async (raw) => {
      const id = raw.trim();
      if (id === "") return "要给一个判据 id。先看 /squad-criteria";
      await this.ctx.reasoning.resolve(id, "reject");
      return `已否掉 ${id}。`;
    });
  }

  /**
   * The current team, or an error naming the way out.
   *
   * Every command that needs a team goes through here, so "no team selected"
   * is one message written once rather than a different silence per command.
   */
  private team(): Team {
    if (this.current === undefined) throw new Error("还没有当前团队。先 /squad-new，或 /squad-teams 切换。");
    const team = this.ctx.teams.get(this.current);
    if (team === undefined) throw new Error(`当前团队 ${this.current} 已经不在了。/squad-teams 看看还有哪些。`);
    return team;
  }
}

export { parseNewTeam, parseSay } from "./parse.ts";
export type { NewTeamInput, SayInput, SeatDraft } from "./parse.ts";

export { SQUAD_API_PREFIX, snapshotOf, registerSquadApi } from "./http.ts";
export type { SquadSnapshot, TeamSummary } from "./http.ts";
