import { describe, expect, it } from "vitest";
import { checkAgendaAgainstRoster, needsOf, nodeIdOf, type AgendaPhase, type AgendaSpec } from "../src/agenda.ts";
import {
  afterAttempt,
  applyDecision,
  initialNodes,
  nodeOf,
  parseSeatReport,
  passedTitles,
  retryFeedback,
  rewindTo,
  runnable,
  settle,
  standing,
  tally,
  type ExitCheckResult,
  type NodeMap,
} from "../src/agenda-machine.ts";

const phase = (title: string, extra: Partial<AgendaPhase> = {}): AgendaPhase => ({
  title,
  contextMode: "cumulative",
  tasks: [{ seatId: "a", instruction: `做 ${title}` }],
  ...extra,
});
const checked = (title: string, extra: Partial<AgendaPhase> = {}): AgendaPhase =>
  phase(title, { check: { command: `test -f ${title}` }, ...extra });
const check = (exitCode: number | null, tail = "", timedOut = false): ExitCheckResult => ({
  exitCode,
  tail,
  at: 1,
  ...(timedOut ? { timedOut: true } : {}),
});
const mark = (nodes: NodeMap, id: string, state: NodeMap[string]["state"]): NodeMap => ({
  ...nodes,
  [id]: { ...nodeOf(nodes, id), state },
});

// 2026-10-10 夜里那份议程的形状：七个阶段，每个只依赖前一个。
const chain: AgendaSpec = { phases: ["T0", "T1", "T2", "T3"].map((title) => checked(title)) };

describe("节点与依赖", () => {
  it("没写 id 就按位置叫 p1、p2；没写 needs 就依赖前一个", () => {
    expect(chain.phases.map((one, index) => nodeIdOf(one, index))).toEqual(["p1", "p2", "p3", "p4"]);
    expect(needsOf(chain, 0)).toEqual([]);
    expect(needsOf(chain, 2)).toEqual(["p2"]);
  });

  it("写了 needs 就以它为准，哪怕是空的", () => {
    const agenda: AgendaSpec = {
      phases: [
        phase("后端", { id: "be" }),
        phase("iOS", { id: "ios", needs: [] }),
        phase("联调", { needs: ["be", "ios"] }),
      ],
    };
    expect(needsOf(agenda, 1)).toEqual([]);
    expect(needsOf(agenda, 2)).toEqual(["be", "ios"]);
  });

  it("needs 只能指向写在前面的阶段，节点名不能重复", () => {
    const agenda: AgendaSpec = {
      phases: [phase("甲", { id: "x", needs: ["y"] }), phase("乙", { id: "y" }), phase("丙", { id: "x" })],
    };
    const problems = checkAgendaAgainstRoster(agenda, ["a"]).map((one) => one.detail);
    expect(problems.some((detail) => detail.includes("「y」不是写在它前面的阶段"))).toBe(true);
    expect(problems.some((detail) => detail.includes("「x」和前面的阶段重了"))).toBe(true);
  });

  it("旧数据只有「已完成标题」时，读成这些节点已通过", () => {
    const nodes = initialNodes(chain, ["T0", "T1"]);
    expect(passedTitles(chain, nodes)).toEqual(["T0", "T1"]);
    expect(runnable(chain, nodes)).toEqual([2]);
  });
});

describe("下一步跑谁", () => {
  it("直线议程一次只有一个可跑的", () => {
    expect(runnable(chain, initialNodes(chain))).toEqual([0]);
  });

  it("前置没通过的节点不会被点到", () => {
    // 那天夜里 T1 没办成，T2 到 T6 却照样各被点了一次，每人回一句「不开工」。
    const nodes = mark(initialNodes(chain, ["T0"]), "p2", "deciding");
    expect(runnable(chain, nodes)).toEqual([]);
    expect(standing(chain, nodes)).toBe("deciding");
  });

  it("两个节点等的是同一个已通过的节点时，都可跑", () => {
    const agenda: AgendaSpec = {
      phases: [phase("基础", { id: "base" }), phase("后端", { needs: ["base"] }), phase("iOS", { needs: ["base"] })],
    };
    expect(runnable(agenda, initialNodes(agenda, ["基础"]))).toEqual([1, 2]);
  });

  it("放下一个节点，依赖它的全部跳过，不依赖它的照跑", () => {
    const agenda: AgendaSpec = {
      phases: [
        phase("后端", { id: "be" }),
        phase("接口联调", { id: "api", needs: ["be"] }),
        phase("发布", { needs: ["api"] }),
        phase("iOS", { id: "ios", needs: [] }),
      ],
    };
    const nodes = settle(agenda, mark(initialNodes(agenda), "be", "unresolved"));
    expect(nodes["api"]?.state).toBe("skipped");
    expect(nodes["p3"]?.state).toBe("skipped");
    // 说的是阶段的名字，不是节点编号——「它依赖的 p3」要人去数是第几个。
    expect(nodes["api"]?.why).toBe("它依赖的「后端」没有通过");
    expect(nodes["p3"]?.why).toBe("它依赖的「接口联调」没有通过");
    expect(runnable(agenda, nodes)).toEqual([3]);
  });

  it("障碍清掉之后，之前被跳过的节点活过来", () => {
    const skipped = settle(chain, mark(initialNodes(chain, ["T0"]), "p2", "unresolved"));
    expect(skipped["p3"]?.state).toBe("skipped");
    const revived = settle(chain, mark(skipped, "p2", "pending"));
    expect(revived["p3"]?.state).toBe("pending");
    expect(revived["p4"]?.state).toBe("pending");
  });

  it("全部通过才叫跑完；有放下的叫结束", () => {
    expect(standing(chain, initialNodes(chain, ["T0", "T1", "T2", "T3"]))).toBe("finished");
    const ended = settle(chain, mark(initialNodes(chain, ["T0"]), "p2", "unresolved"));
    expect(standing(chain, ended)).toBe("ended");
    expect(tally(chain, ended)).toMatchObject({ passed: 1, unresolved: 1, skipped: 2 });
  });
});

describe("一次尝试之后", () => {
  const node = checked("T1");

  it("检查通过就是通过", () => {
    expect(afterAttempt(node, 1, { check: check(0) })).toEqual({ kind: "pass" });
  });

  it("检查没过、次数没用完：重做", () => {
    expect(afterAttempt(node, 1, { check: check(1) })).toEqual({ kind: "retry" });
    expect(afterAttempt(node, 2, { check: check(1) })).toEqual({ kind: "retry" });
  });

  it("做满次数仍未通过：进决策点，并说清做了几次、检查怎么说", () => {
    const step = afterAttempt(node, 3, { check: check(2) });
    expect(step).toMatchObject({ kind: "decide", reason: "check-failed" });
    expect(step.kind === "decide" ? step.why : "").toMatch(/做了 3 次.*退出码 2/);
  });

  it("次数上限可以按节点改", () => {
    expect(afterAttempt(checked("T1", { maxAttempts: 1 }), 1, { check: check(1) }).kind).toBe("decide");
  });

  it("席位说「完成」而检查没过，以检查为准", () => {
    expect(afterAttempt(node, 1, { report: { kind: "done" }, check: check(1) })).toEqual({ kind: "retry" });
  });

  it("席位说被卡住：不原样重做三遍，直接进决策点", () => {
    // 野间那晚就是这样：问题在别人领地的脚本里，他重做多少遍都一样。
    const step = afterAttempt(node, 1, {
      report: { kind: "blocked", detail: "scripts/rb-exit.sh 缺 DATABASE_BOOTSTRAP_URL，是樱木的领地" },
      check: check(1),
    });
    expect(step).toMatchObject({ kind: "decide", reason: "blocked" });
    expect(step.kind === "decide" ? step.why : "").toContain("rb-exit.sh");
  });

  it("席位在问主持人：进决策点，而不是点下一个人", () => {
    const step = afterAttempt(node, 1, { report: { kind: "needs-host", detail: "要我现在改脚本吗" }, check: check(1) });
    expect(step).toMatchObject({ kind: "decide", reason: "needs-host" });
  });

  it("席位说被卡住但检查过了：事情办成了，算通过", () => {
    expect(afterAttempt(node, 1, { report: { kind: "blocked", detail: "x" }, check: check(0) })).toEqual({
      kind: "pass",
    });
  });

  it("席位技术性失败：进决策点，不跑检查也不重试", () => {
    const step = afterAttempt(node, 1, { seatFailed: { seat: "樱木花道", why: "判定为卡死" } });
    expect(step).toMatchObject({ kind: "decide", reason: "seat-failed" });
  });

  it("超时和被信号中止都不算通过", () => {
    expect(afterAttempt(node, 1, { check: check(0, "", true) }).kind).toBe("retry");
    expect(afterAttempt(node, 1, { check: check(null) }).kind).toBe("retry");
  });

  it("没有检查的阶段：答了就算过，除非自己说被卡住或在问主持人", () => {
    const plain = phase("讨论");
    expect(afterAttempt(plain, 1, {})).toEqual({ kind: "pass" });
    expect(afterAttempt(plain, 1, { report: { kind: "not-done", detail: "x" } })).toEqual({ kind: "pass" });
    expect(afterAttempt(plain, 1, { report: { kind: "blocked", detail: "x" } }).kind).toBe("decide");
  });

  it("重做时把检查命令、结果和输出交回去，并说清是第几次", () => {
    const feedback = retryFeedback(node, check(1, "FAILED test_x.py::test_y"), 1);
    expect(feedback).toContain("第 2 / 3 次");
    expect(feedback).toContain("test -f T1");
    expect(feedback).toContain("退出码 1");
    expect(feedback).toContain("FAILED test_x.py::test_y");
    expect(retryFeedback(node, check(1, ""), 1)).toContain("（没有输出）");
  });
});

describe("席位自报", () => {
  it("读最后一行【结果】", () => {
    expect(parseSeatReport("做完了。\n【结果】完成")).toEqual({ kind: "done" });
    expect(parseSeatReport("【结果】未完成：迁移没写完")).toEqual({ kind: "not-done", detail: "迁移没写完" });
    expect(parseSeatReport("【结果】被卡住：rb-exit.sh 是樱木的领地")).toEqual({
      kind: "blocked",
      detail: "rb-exit.sh 是樱木的领地",
    });
    expect(parseSeatReport("**【结果】需要主持人: 要不要改脚本**")).toMatchObject({ kind: "needs-host" });
  });

  it("写了好几行时以最后一行为准", () => {
    expect(parseSeatReport("【结果】未完成：先试试\n后来修好了\n【结果】完成")).toEqual({ kind: "done" });
  });

  it("没写或写得认不出，就当没写", () => {
    expect(parseSeatReport("都弄好了")).toBeUndefined();
    expect(parseSeatReport("【结果】差不多吧")).toBeUndefined();
  });
});

describe("在决策点", () => {
  const stuck = mark(initialNodes(chain, ["T0"]), "p2", "deciding");

  it("重做：回到待跑，次数重新算，交代的话带到下一次", () => {
    const nodes = applyDecision(chain, stuck, "p2", { kind: "retry", instruction: " 先修脚本再提交 " });
    expect(nodes["p2"]).toMatchObject({ state: "pending", attempts: 0, detour: { instruction: "先修脚本再提交" } });
    expect(runnable(chain, nodes)).toEqual([1]);
  });

  it("重做而不交代：不带多余的话", () => {
    expect(applyDecision(chain, stuck, "p2", { kind: "retry" })["p2"]?.detour).toBeUndefined();
  });

  it("让别人清障：下一次只跑那个席位，之后还是这个节点的检查说了算", () => {
    const nodes = applyDecision(chain, stuck, "p2", {
      kind: "assign",
      seatId: "sakuragi",
      instruction: "修 rb-exit.sh 三处",
    });
    expect(nodes["p2"]).toMatchObject({
      state: "pending",
      detour: { seatId: "sakuragi", instruction: "修 rb-exit.sh 三处" },
    });
  });

  it("视为通过：后面的阶段可以跑了", () => {
    const nodes = applyDecision(chain, stuck, "p2", { kind: "pass" });
    expect(nodes["p2"]?.state).toBe("passed");
    expect(runnable(chain, nodes)).toEqual([2]);
  });

  it("放下：依赖它的都跳过，议程结束", () => {
    const nodes = applyDecision(chain, stuck, "p2", { kind: "abandon" });
    expect(nodes["p2"]?.state).toBe("unresolved");
    expect(standing(chain, nodes)).toBe("ended");
  });

  it("上一次检查的结果留着，决定之后还看得到", () => {
    const withCheck: NodeMap = { ...stuck, p2: { state: "deciding", attempts: 3, lastCheck: check(1, "boom") } };
    expect(applyDecision(chain, withCheck, "p2", { kind: "retry" })["p2"]?.lastCheck?.tail).toBe("boom");
  });

  it("不在等决定的节点不能被决定", () => {
    expect(() => applyDecision(chain, stuck, "p1", { kind: "pass" })).toThrow(/不需要决定/);
    expect(() => applyDecision(chain, stuck, "nope", { kind: "pass" })).toThrow(/没有节点/);
  });

  it("退回到某一阶段：它和它后面的都重新待跑，前面的不动", () => {
    const done = initialNodes(chain, ["T0", "T1", "T2", "T3"]);
    const nodes = rewindTo(chain, done, 1);
    expect(passedTitles(chain, nodes)).toEqual(["T0"]);
    expect(runnable(chain, nodes)).toEqual([1]);
  });
});
