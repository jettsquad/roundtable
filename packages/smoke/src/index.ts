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
export const inject = ["teams", "teamContext", "secretary", "reasoning"];

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

      // ── contextMode 对照实验 ─────────────────────────────────────────
      // `before-turn` had never actually executed. Testing cumulative alone
      // would not be worth much: if BOTH modes had degenerated into
      // cumulative, a "seat B saw seat A" check passes and says nothing. So
      // the two modes run the same two tasks and are compared against each
      // other — the claim is that they DIFFER, and that needs both halves.
      const pair = await ctx.teams.create({
        displayName: "对照团队",
        projectFolder: config.projectFolder,
        hostDisplayName: "主持人",
        seats: [
          { seatId: "seat-a", displayName: "甲", role: "通用", systemPrompt: "回答极简。", backend: "claude-code" },
          { seatId: "seat-b", displayName: "乙", role: "通用", systemPrompt: "回答极简。", backend: "claude-code" },
        ],
      });

      // Discriminated by WHICH word comes back, not by asking the seat to
      // reason about phases. A seat has no reliable way to tell which phase a
      // recorded line belongs to, and every probe in this project that asked
      // one to ("上一轮", "本阶段", "the untrusted block") failed for reasons
      // that had nothing to do with the wiring under test.
      //
      // Phase 1 plants 菠萝, phase 2 plants 香蕉, and B is asked the same
      // neutral question both times:
      //   cumulative  → B's window is taken before its own turn  → 菠萝
      //   independent → B's window is the phase-start snapshot, which holds
      //                 phase 1's 菠萝 but not phase 2's 香蕉    → 菠萝, never 香蕉
      // So "independent did not see its own phase" is provable from the
      // ABSENCE of 香蕉, without needing B to know what a phase is.
      const askB = "甲刚才回答了一个水果名，把那个水果名写出来。如果讨论里没有水果名，就只回答「无」。";
      line("对照实验：同样两个任务，先 cumulative 再 independent…");
      const compare = await pair.runAgenda({
        phases: [
          {
            title: "累积",
            contextMode: "cumulative",
            tasks: [
              { seatId: "seat-a", instruction: "这一轮的水果是菠萝。只回答这个水果名，不要解释。" },
              { seatId: "seat-b", instruction: askB },
            ],
          },
          {
            title: "独立",
            contextMode: "independent",
            tasks: [
              { seatId: "seat-a", instruction: "这一轮的水果是香蕉。只回答这个水果名，不要解释。" },
              { seatId: "seat-b", instruction: askB },
            ],
          },
        ],
      });

      const [cumA, cumB, indA, indB] = compare.replies;
      line(
        `  累积阶段：甲收到 ${cumA?.contextLines ?? -1} 行，乙收到 ${cumB?.contextLines ?? -1} 行 → 乙答「${(cumB?.text ?? "").slice(0, 12)}」`,
      );
      line(
        `  独立阶段：甲收到 ${indA?.contextLines ?? -1} 行，乙收到 ${indB?.contextLines ?? -1} 行 → 乙答「${(indB?.text ?? "").slice(0, 12)}」`,
      );

      // Gated on what the table DELIVERED, not on what the model said with it.
      // Those are different failures, and an end-to-end check that conflates
      // them reports a wiring bug every time a model answers oddly — which it
      // did, three probes running, on plumbing that was already correct.
      //
      //   cumulative  → B's window is taken before its own turn, so it holds
      //                 A's turn: strictly more lines than A got.
      //   independent → both are handed the one snapshot taken when the phase
      //                 opened: exactly equal, and there is no edge from A to
      //                 B for anything to travel along.
      const cumulativeGrew = (cumB?.contextLines ?? 0) > (cumA?.contextLines ?? 0);
      const independentShared = (indA?.contextLines ?? -1) === (indB?.contextLines ?? -2);
      line(
        cumulativeGrew && independentShared
          ? "✅ 两种模式确实不同：累积的窗口随发言增长，独立的两席位共用一份快照"
          : `❌ 对照失败：累积增长=${cumulativeGrew}，独立共享=${independentShared}`,
      );

      // Informational, never a gate: whether the seat used what it was given.
      const usedIt = (cumB?.text ?? "").includes("菠萝");
      const stayedBlind = !(indB?.text ?? "").includes("香蕉");
      line(`  （模型行为，仅供参考）累积席位用上了同伴发言=${usedIt}，独立席位没提到本阶段的词=${stayedBlind}`);

      await pair.dispose();

      // ── 中止交接：停一个跑到一半的议程，把没做完的交出去 ──────────────
      // writeTermination had an implementation and tests and no path that
      // could reach it, which is how a feature quietly stops working without
      // anyone noticing it ever did.
      const twoPhase = {
        hostGoal: "分两步看这个目录",
        phases: [
          {
            title: "第一步",
            contextMode: "independent" as const,
            tasks: [{ seatId: "seat-a", instruction: "用一句话说 README.md 是干什么的。" }],
          },
          {
            title: "第二步",
            contextMode: "independent" as const,
            tasks: [{ seatId: "seat-a", instruction: "再写一段详细说明。" }],
          },
        ],
      };

      line("跑两阶段议程，中途叫停…");
      // Timed against a variable-length agenda, so the stop can legitimately
      // arrive after the run already finished. That is a race in the PROBE,
      // not in the product — stopAgenda is right to refuse an idle team — so
      // it is caught and reported. An earlier version let it throw from a
      // bare timer and took the whole process down, turning a probe timing
      // issue into a crash that looked like a product failure.
      let material: ReturnType<typeof team.stopAgenda> | undefined;
      let stopRaced = false;
      const stopper = new Promise<void>((resolve) => {
        setTimeout(() => {
          try {
            material = team.stopAgenda("主持人改主意了");
          } catch {
            stopRaced = true;
          }
          resolve();
        }, 20_000);
      });
      const [outcome2] = await Promise.all([team.runAgenda(twoPhase), stopper]);
      if (stopRaced || material === undefined) {
        line("⚠️ 本次议程比计时器先跑完，中止路径这一轮没被执行到（不是通过，也不是失败）");
        material = {
          objective: twoPhase.hostGoal,
          reason: "（本轮未真正中止）",
          completed: [],
          remaining: ["阶段「第二步」：再写一段详细说明。"],
          artifacts: [],
          discussion: [],
        };
      } else {
        line(
          `议程结果：跑过 ${outcome2.phasesRun.join(" → ") || "（无）"}，` +
            `stoppedBecause=${outcome2.stoppedBecause ?? "（无）"}`,
        );
        line(`没做完的：${material.remaining.join(" | ") || "无"}`);
      }

      line("秘书写中止交接…");
      const handoff = await ctx.secretary.writeTermination({ parent: team.host, ...material });
      const namesRemaining = material.remaining.every((item) => handoff.includes(item.replace(/^阶段「|」.*$/g, "")));
      line(`交接文档 ${handoff.length} 字，五个标题齐全（否则已经抛错），` + `点到了未完成阶段 = ${namesRemaining}`);
      // Two claims, kept apart. The hand-off is judged on its own — it names
      // what is left, whatever produced the material — and the interruption
      // is judged separately, because a run the timer lost the race to did
      // not exercise it at all. Reporting one verdict for both would turn a
      // probe that skipped a step into a probe that passed it.
      line(namesRemaining ? "✅ 交接文档点到了未完成的部分" : "❌ 交接文档没点到未完成的部分");
      line(
        stopRaced
          ? "⚠️ 中止本身这一轮没验到"
          : outcome2.stoppedBecause !== undefined
            ? "✅ 中止走通：议程真的被打断了"
            : "❌ 中止没生效",
      );

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
      // One retry, and it says when it used one.
      //
      // Starting a subagent occasionally fails with no output at all — seen
      // twice in a row and then not again on identical code, so it is
      // transient rather than a defect in this path. Tolerated here because
      // this smoke costs four minutes of real model calls, and REPORTED
      // because a retry that hides itself turns a flaky dependency into a
      // green light.
      //
      // The automatic fold needs no retry of its own: it is triggered at
      // round end, so a failed attempt simply folds at the next one.
      let retried = false;
      const attempt = async (label: string) => {
        try {
          return await ctx.teamContext.fold(team.teamId);
        } catch (error) {
          line(`  折叠尝试(${label}) 失败：${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        }
      };
      let checkpoint = await attempt("立即");
      if (checkpoint === undefined) {
        line("  等 20 秒再试一次…");
        retried = true;
        await new Promise((r) => setTimeout(r, 20_000));
        checkpoint = await attempt("延迟后");
      }
      if (checkpoint === undefined) throw new Error("两次折叠都失败。");
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
      line(
        carriesCheckpoint && droppedOriginals
          ? `✅ 折叠成立${retried ? "（用掉了一次重试——子进程启动失败过一次）" : ""}`
          : "❌ 折叠没成立",
      );

      // ── Lil X 写路径：一次否决 → 一条待裁定的提议 ─────────────────────
      // The only value of this step is whether the distillation separates a
      // STANDARD from a CONCLUSION. "他选了 Postgres" cannot transfer to
      // another situation; "他要求给出迁移成本估算才接受选型" can. Nothing
      // but a real model call can tell us which one comes back.
      line("Lil X：记一次否决…");
      const captured = await ctx.reasoning.capture({
        kind: "veto",
        parent: team.host,
        situation: { action: "design-mechanism", features: ["automatic", "invisible-result"] },
        proposed: "讨论过长时自动折叠成检查点，不通知任何人。",
        verdict: "改成折叠后在系统通道告知主持人折了哪一段。",
        reason: "看不见的东西没法纠正。",
        project: "Squad2",
      });
      const waiting = await ctx.reasoning.pending();
      line(`  关系=${captured.relation}，实例=${captured.instanceId}`);
      line(`  提议主张：${captured.proposal.claim}`);
      line(`  待裁定队列：${waiting.length} 条；已生效判据：${(await ctx.reasoning.criteria()).length} 条`);

      // Nothing may activate itself. The system is editing its own scoring
      // rules; automatic approval is grading yourself.
      const noneActive = (await ctx.reasoning.criteria()).length === 0;
      const proposedOnly = waiting.some((item) => item.id === captured.proposal.id);
      // A conclusion names the specific thing; a standard names the property.
      const looksAbstract = !captured.proposal.claim.includes("检查点") && !captured.proposal.claim.includes("Squad");
      line(
        noneActive && proposedOnly
          ? `✅ 写路径成立：落在待裁定，没有自己生效${looksAbstract ? "；表述是抽象的" : "；⚠️ 表述里还带着具体项目名词"}`
          : "❌ 写路径没成立",
      );

      await ctx.reasoning.resolve(captured.proposal.id, "accept");
      line(
        `  人裁定 accept 之后：已生效 ${(await ctx.reasoning.criteria()).length} 条，待裁定 ${(await ctx.reasoning.pending()).length} 条`,
      );

      // ── Lil X 读路径：按处境召回，并证明它进不了席位 ────────────────
      const here = {
        action: "design-mechanism",
        features: ["automatic", "invisible-result"],
      } as const;
      const found = await ctx.reasoning.locate(here, team.host);
      const elsewhere = await ctx.reasoning.locate({ action: "produce-document", features: [] });
      line(`  按处境召回：命中 ${found.length} 条；换一个处境：${elsewhere.length} 条`);

      const brief = await ctx.reasoning.brief(here, team.host);
      line(`  系统通道文本 ${brief.length} 字，标了「是判据不是指令」=${brief.includes("是判据不是指令")}`);

      // The step that makes Lil X actually run rather than be a library
      // somebody could call: the secretary labels each phase while drafting,
      // and the briefs come off that label at confirmation time.
      const labelled = await ctx.secretary.draftAgenda({
        parent: team.host,
        command: "设计一个「讨论过长时自动折叠」的机制，让甲提出方案。",
        topic: topic,
        seats: [{ seatId: "seat-a", displayName: "甲" }],
      });
      const labels = labelled.phases.map(
        (p) =>
          `${p.title}=${p.situation === undefined ? "（未标）" : `${p.situation.action}[${p.situation.features.join(",")}]`}`,
      );
      line(`  秘书给阶段标的处境：${labels.join(" | ")}`);
      const briefs = await ctx.reasoning.briefForAgenda(labelled, team.host);
      line(`  按议程投放：${briefs.length} 个阶段拿到了判据`);
      for (const item of briefs) {
        line(`    [${item.phase}] ${item.brief.replace(/\n/g, " ").slice(0, 70)}…`);
      }

      // The one that matters. Criteria shape how work is organised and
      // judged, never how a participant thinks — and that has to be true of
      // the topology, not of anyone's discipline. So: assert the claim is
      // nowhere in what a seat would actually be handed.
      const seatWindow = (await ctx.teamContext.windowFor(team.teamId, "seat-a")).join("\n");
      const claim = found[0]?.claim ?? "";
      const leaked = claim !== "" && seatWindow.includes(claim.slice(0, 20));
      line(
        found.length > 0 && elsewhere.length === 0 && !leaked
          ? "✅ 读路径成立：按处境召回，且判据没有进入席位窗口"
          : `❌ 读路径有问题：命中=${found.length}，异处境=${elsewhere.length}，泄漏进席位=${leaked}`,
      );

      line(`团队记录条目数：${team.transcript().length}`);
      line(saw ? "✅ 席位看见了上一轮——装配接线成立" : "❌ 席位看不到上一轮");

      await team.dispose();
    } catch (error) {
      line(`失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  })();
}
