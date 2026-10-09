import { describe, expect, it } from "vitest";
import { baseForFolder, recordForSession, restoreOrder, unclaimed, nextHostId } from "../src/sitting.ts";

const team = { teamId: "t1", sessionId: "t1", projectFolder: "/w" };
const sittingA = { teamId: "sit-a", sessionId: "sess-a", baseTeamId: "t1", projectFolder: "/w" };
const sittingB = { teamId: "sit-b", sessionId: "sess-b", baseTeamId: "t1", projectFolder: "/w" };

describe("一个 session 归哪条记录", () => {
  it("按 session 找，不按文件夹找", () => {
    // 按文件夹找是那个 bug 本身：一个工作区里的两个 session 都能匹配上，
    // 先建的那个赢——于是新会话打开的是旧讨论。
    expect(recordForSession([team, sittingA, sittingB], "sess-b")?.teamId).toBe("sit-b");
  });

  it("老记录没有 sessionId 时，用它自己的 id 顶上", () => {
    // 有 sittings 之前写下的行没有这个字段。它服务的一直是与自己同名的那个
    // session，回落到 teamId 就还是那一条。
    expect(recordForSession([{ teamId: "old", projectFolder: "/w" }], "old")?.teamId).toBe("old");
  });

  it("没人认领的 session 就是没有", () => {
    expect(recordForSession([team], "sess-新")).toBeUndefined();
  });

  it("已销毁的不算", () => {
    expect(recordForSession([{ ...sittingA, disposed: true }], "sess-a")).toBeUndefined();
  });
});

describe("文件夹归哪支团队", () => {
  it("只认基准团队，不认某一场会话", () => {
    // 名册挂在基准团队上。让一场会话当基准，名册就会落在树的任意一层。
    expect(baseForFolder([sittingA, team, sittingB], "/w")?.teamId).toBe("t1");
  });

  it("别的文件夹不匹配", () => {
    expect(baseForFolder([team], "/别处")).toBeUndefined();
  });

  it("团队已销毁时不算", () => {
    expect(baseForFolder([{ ...team, disposed: true }], "/w")).toBeUndefined();
  });
});

describe("恢复顺序", () => {
  it("基准团队排在它的会话之前", () => {
    // 会话按引用共享基准的名册对象。先恢复会话，它就没有东西可指。
    const order = restoreOrder([sittingA, team, sittingB]).map((row) => row.teamId);
    expect(order[0]).toBe("t1");
    expect(order).toEqual(["t1", "sit-a", "sit-b"]);
  });

  it("同一组内保持原顺序", () => {
    // 两支团队按建立先后恢复，列表里的次序才对得上。
    const t2 = { teamId: "t2", sessionId: "t2", projectFolder: "/x" };
    expect(restoreOrder([team, t2]).map((row) => row.teamId)).toEqual(["t1", "t2"]);
  });

  it("一条都不丢", () => {
    expect(restoreOrder([sittingA, team]).length).toBe(2);
  });
});

describe("第一个会话认领团队本身", () => {
  it("刚建好、还没人坐下的团队算「未认领」", () => {
    // 建团队时还没有 session，记录借了自己的 id 当 sessionId。
    expect(unclaimed({ teamId: "t1", sessionId: "t1" })).toBe(true);
  });

  it("老记录没有 sessionId 也算未认领", () => {
    expect(unclaimed({ teamId: "t1" })).toBe(true);
  });

  it("已经被某个会话认领之后就不是了", () => {
    expect(unclaimed({ teamId: "t1", sessionId: "sess-a" })).toBe(false);
  });

  it("会话本身永远不算未认领", () => {
    // 否则一场会话会被下一个新 session 抢走，两个 session 指向同一条记录，
    // 正是这次要修的那个 bug。
    expect(unclaimed({ teamId: "sit-a", sessionId: "sit-a", baseTeamId: "t1" })).toBe(false);
  });
});

describe("recordForSession with duplicates", () => {
  const dup = (teamId: string, size: number) => ({ teamId, sessionId: "s", size });
  it("prefers the record with the discussion over an empty twin that comes first", () => {
    const rows = [dup("empty-1", 1), dup("empty-2", 1), dup("full", 40)];
    expect(recordForSession(rows, "s", (row) => row.size)?.teamId).toBe("full");
  });
  it("keeps the first when they weigh the same", () => {
    expect(recordForSession([dup("a", 3), dup("b", 3)], "s", (row) => row.size)?.teamId).toBe("a");
  });
});

describe("nextHostId", () => {
  it("第一次换主持节点：团队 id 加 -h2", () => {
    // 前缀留着：Squad 靠 team- / sit- 开头认出自己的主持节点，认不出来就会把它
    // 当成人开的会话，标记后显示在侧边栏里。
    expect(nextHostId("team-abc", "team-abc")).toBe("team-abc-h2");
    expect(nextHostId("sit-xyz", "sit-xyz")).toBe("sit-xyz-h2");
  });

  it("再换一次接着往上数，不跟上一个撞", () => {
    expect(nextHostId("team-abc", "team-abc-h2")).toBe("team-abc-h3");
    expect(nextHostId("team-abc", "team-abc-h9")).toBe("team-abc-h10");
  });
});
