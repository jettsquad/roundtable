import { describe, expect, it } from "vitest";
import { checkAgendaAgainstRoster, type AgendaSpec } from "../src/agenda.ts";
import { vacuousCheckReason } from "../src/agenda-check.ts";

describe("不可能失败的出口检查", () => {
  it("RB8 那条：git log --grep 没匹配也退出 0，必须拒收", () => {
    // 真实出过事的命令：批次从没提交，却被记成「P6 通过」。
    expect(vacuousCheckReason("test -s ACCEPTANCE-RB8.md && git log --oneline -1 --grep='RB8 批次完成'")).toContain(
      "没人检查",
    );
    expect(vacuousCheckReason("git log --oneline -1 --grep='x'")).toBeDefined();
    expect(vacuousCheckReason("git log -S foo | head -1")).toBeDefined();
  });

  it("接上断言就放行", () => {
    expect(vacuousCheckReason("git log --oneline -1 --grep='RB8 批次完成' | grep -q .")).toBeUndefined();
    expect(vacuousCheckReason("test -n \"$(git log --oneline -1 --grep='RB8')\"")).toBeUndefined();
    expect(vacuousCheckReason("test -s a.md && git log --grep=x | grep -q .")).toBeUndefined();
  });

  it("只输出信息的命令没有任何一步会失败", () => {
    expect(vacuousCheckReason("true")).toBeDefined();
    expect(vacuousCheckReason("echo done")).toBeDefined();
    expect(vacuousCheckReason("git status")).toBeDefined();
    expect(vacuousCheckReason("git diff HEAD~1")).toBeDefined();
    expect(vacuousCheckReason("cat a.md | head -3")).toBeDefined();
    expect(vacuousCheckReason("")).toBeDefined();
  });

  it("把失败吞掉的写法", () => {
    expect(vacuousCheckReason("npm test || true")).toContain("吞掉");
    expect(vacuousCheckReason("npm test; true")).toContain("吞掉");
    expect(vacuousCheckReason("npm test || echo failed")).toContain("吞掉");
    expect(vacuousCheckReason("npm test; exit 0")).toContain("吞掉");
  });

  it("会失败的命令放行", () => {
    expect(vacuousCheckReason("npm test")).toBeUndefined();
    expect(vacuousCheckReason("cd clients/web && npx vitest run tests/a.test.ts && npm run typecheck")).toBeUndefined();
    expect(vacuousCheckReason("test -s implementation-plans/x.md")).toBeUndefined();
    expect(vacuousCheckReason("git diff --exit-code")).toBeUndefined();
    expect(vacuousCheckReason("git diff --quiet HEAD")).toBeUndefined();
    expect(vacuousCheckReason("bash -n scripts/rb-exit.sh && grep -qE 'RB8\\)' scripts/rb-exit.sh")).toBeUndefined();
    expect(vacuousCheckReason("scripts/rb-exit.sh RB8")).toBeUndefined();
    expect(
      vacuousCheckReason("python3 skills/spec-accept/scripts/run_evidence.py trace.json --batch RB8"),
    ).toBeUndefined();
  });

  it("引号里的分隔符不算", () => {
    expect(vacuousCheckReason("grep -q 'a && b | c' file.txt")).toBeUndefined();
  });

  it("议程审查会指出是哪个阶段", () => {
    const agenda: AgendaSpec = {
      phases: [
        {
          title: "收尾",
          contextMode: "cumulative",
          tasks: [{ seatId: "a", instruction: "做" }],
          check: { command: "git log --oneline -1 --grep='完成'" },
        },
      ],
    };
    const problems = checkAgendaAgainstRoster(agenda, ["a"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.phase).toBe("收尾");
    expect(problems[0]?.detail).toContain("出口检查不可能失败");
  });
});
