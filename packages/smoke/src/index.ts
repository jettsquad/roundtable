/**
 * @squad/smoke — the end-to-end check, mounted only by hand.
 *
 * Stage 1 proved a seat can run and answer. Stage 2 has to prove something a
 * single round cannot show: that the seat SEES the discussion. So it runs two
 * rounds and asks the second one for a token that appears ONLY in round 1 —
 * not in the project folder, not in the seat's memory (it has none), and not
 * derivable. Either the window carried it or the seat cannot produce it.
 *
 * It reports the assembled window's size separately from what the seat said,
 * because those are two different failures and they look identical from the
 * outside. An earlier probe asked the seat to echo the <untrusted-data> block
 * verbatim; that answer turned out to be unstable — asking a model to dump a
 * block explicitly labelled untrusted is close enough to a prompt-injection
 * request that it sometimes declines. A probe whose failure mode is the
 * model's mood cannot tell you whether your plumbing works.
 *
 * Not part of any shipped composition.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";

export const name = "squad-smoke";
export const inject = ["teams", "teamContext", "secretary"];

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
      line(`团队已建：${team.teamId}`);

      // A neutral fact, deliberately NOT a secret. An earlier probe planted a
      // 「口令」(password) and asked the seat to reproduce it — which is the
      // exact shape of a prompt-injection exfiltration attempt, so the seat
      // refused and the probe reported a wiring failure that did not exist.
      // A probe must not look like an attack on the thing it is testing.
      const topic = `议题 ${Math.floor(Math.random() * 9000 + 1000)} 号`;
      const first = `我们这次讨论是「${topic}」。${config.instruction}`;
      line(`第 1 轮：${first}`);
      for (const reply of await team.ask(first)) {
        line(`  ← ${reply.displayName}${reply.failed ? "（失败）" : ""}：${reply.text}`);
      }

      // The stage-2 gate. A seat is a fresh process with no memory of round 1,
      // so a correct answer here can only come from the assembled window.
      // Phrased to test DELIVERY, not the model's willingness to volunteer
      // memory. "复述你上一轮" invites a fresh process to answer "I have no
      // history" truthfully-but-uselessly; pointing at the block that either
      // is or is not in the prompt makes the answer depend on assembly alone.
      const recall = "我们这次讨论是几号议题？只回答编号，不要做别的事。如果不知道，就回答「不知道」。";
      line(`第 2 轮：${recall}`);

      // Reported before the seat runs, so a failure is attributable: an empty
      // window is the assembler's problem, a full window the seat ignored is
      // the prompt's. Told apart here, they read identically anywhere else.
      const window = await ctx.teamContext.windowFor(team.teamId, "seat-a");
      line(`装配出的窗口：${window.length} 行，含议题号 = ${window.join("\n").includes(topic)}`);

      const second = await team.ask(recall);
      for (const reply of second) {
        line(`  ← ${reply.displayName}${reply.failed ? "（失败）" : ""}：${reply.text}`);
      }

      const saw = second.every(
        (reply) => !reply.failed && reply.text.includes(topic.replace("议题 ", "").replace(" 号", "")),
      );
      // ── 折叠：讨论 → 秘书 → 检查点 → 窗口 ────────────────────────────
      // The whole point of stages 2 and 3 together. A seat should stop seeing
      // the original turns and start seeing the document that stands in for
      // them — and the boundary has to hold, or history is cut with nothing
      // put in its place, which is the failure 1.x shipped for a while.
      const spoken = team.transcript().filter((entry) => entry.kind === "user/message" && entry.text.length > 0);

      // ── 议程：秘书拟 → 主持人确认 → 桌子执行 ──────────────────────────
      line("秘书拟议程…");
      const draft = await ctx.secretary.draftAgenda({
        parent: team.host,
        command: "让甲用一句话说明 README.md 讲了什么，并把答案写进 docs/smoke.md",
        topic: topic,
        seats: [{ seatId: "seat-a", displayName: "甲" }],
      });
      line(
        `草案：${draft.phases.length} 个阶段，` +
          `任务 ${draft.phases.flatMap((p) => p.tasks).length} 条，` +
          `产出路径 ${draft.phases
            .flatMap((p) => p.tasks)
            .map((t) => t.artifactPath ?? "无")
            .join("/")}`,
      );

      // The host confirms. Nothing ran until this line — that is the whole
      // point of drafting separately from executing.
      const outcome = await team.runAgenda(draft);
      line(`议程执行完：阶段 ${outcome.phasesRun.join(" → ")}，产出 ${outcome.artifacts.join(", ") || "无"}`);
      for (const reply of outcome.replies) {
        line(`  ← ${reply.displayName}${reply.failed ? "（失败）" : ""}：${reply.text.slice(0, 60)}`);
      }
      const wroteFile =
        outcome.artifacts.length === 0 ||
        outcome.artifacts.every((path) => existsSync(join(config.projectFolder, path)));
      line(wroteFile ? "✅ 议程走通（产出路径若有，文件确实存在）" : "❌ 产出路径报了但文件不在");

      // What the trigger sees. The smoke cannot cross the real threshold —
      // the floor is 1M × 0.05 = 50k tokens, and getting there means actually
      // sending a 50k-token round — so what is checked here is the accounting
      // and the reason it is holding, not the firing. `evaluateThreshold`
      // owns the firing decision and has its own tests.
      const before = ctx.teamContext.progress(team.teamId);
      line(
        `阈值：累计 ${before.accumulated} / 上限 ${before.limit}，crossed=${before.crossed}` +
          `${before.holdReason === undefined ? "" : `，按住的原因=${before.holdReason}`}`,
      );
      if (before.accumulated === 0) line("⚠️ 累计为 0——记录没被算进去，接线有问题");

      line("秘书写检查点（手动触发，走的是自动折叠的同一条路）…");
      const checkpoint = await ctx.teamContext.fold(team.teamId);
      line(`检查点 ${checkpoint.text.length} 字，覆盖到 ${checkpoint.coversUpTo}，标题齐全（否则已经抛错）`);

      // The index must name the file the program actually wrote. Given no
      // paths the secretary invents plausible ones, and an invented path is
      // worse than an empty index: a later agent follows it and finds nothing.
      // Checked against the 产出索引 SECTION, not the whole document: a path
      // the secretary happened to mention while summarising the discussion
      // would satisfy a whole-text search without the index containing
      // anything, which is the state this wiring exists to fix.
      const indexSection = checkpoint.text.slice(checkpoint.text.indexOf("## 产出索引"));
      const indexed =
        checkpoint.text.includes("## 产出索引") && outcome.artifacts.every((path) => indexSection.includes(path));
      line(
        `产出索引：记下的产出 ${ctx.teamContext.artifactsOf(team.teamId).join(", ") || "无"}，` +
          `检查点里都提到了 = ${indexed}`,
      );
      line(indexed ? "✅ 产出索引接上了" : "❌ 检查点没提到已写的文件");

      const folded = await ctx.teamContext.windowFor(team.teamId, "seat-a");
      const joined = folded.join("\n");
      const carriesCheckpoint = joined.includes("上下文检查点");
      // The original turns must be GONE, not merely accompanied. Compared
      // against text taken from the record itself: an earlier version fell
      // back to a placeholder when a reply was missing, and a placeholder
      // that appears nowhere makes this assertion pass without checking
      // anything.
      const firstSpoken = spoken[0]?.text;
      if (firstSpoken === undefined) throw new Error("记录里没有发言可比对。");
      const droppedOriginals = !joined.includes(firstSpoken);
      line(`折叠后的窗口：${folded.length} 行，含检查点 = ${carriesCheckpoint}，原文已切掉 = ${droppedOriginals}`);
      line(carriesCheckpoint && droppedOriginals ? "✅ 折叠成立" : "❌ 折叠没成立");

      line(`团队记录条目数：${team.transcript().length}`);
      line(saw ? "✅ 席位看见了上一轮——装配接线成立" : "❌ 席位看不到上一轮");

      await team.dispose();
    } catch (error) {
      line(`失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  })();
}
