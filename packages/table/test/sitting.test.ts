import { describe, expect, it } from "vitest";
import { basesForFolder, recordForSession, resolveBase, restoreOrder, unclaimed, nextHostId } from "../src/sitting.ts";

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

describe("文件夹里有哪些团队", () => {
  it("只认基准团队，不认某一场会话", () => {
    // 名册挂在基准团队上。让一场会话当基准，名册就会落在树的任意一层。
    expect(basesForFolder([sittingA, team, sittingB], "/w").map((row) => row.teamId)).toEqual(["t1"]);
  });

  it("别的文件夹不匹配", () => {
    expect(basesForFolder([team], "/别处")).toEqual([]);
  });

  it("团队已销毁时不算", () => {
    expect(basesForFolder([{ ...team, disposed: true }], "/w")).toEqual([]);
  });

  it("同一个文件夹里的几支团队都列出来", () => {
    const second = { teamId: "t2", sessionId: "s2", projectFolder: "/w" };
    expect(basesForFolder([team, second], "/w").map((row) => row.teamId)).toEqual(["t1", "t2"]);
  });
});

describe("一个会话归哪支团队", () => {
  // 老团队已经被打开过（sessionId 不是自己的 id），新团队还没人打开过。
  const old = { teamId: "old", sessionId: "sess-old", projectFolder: "/w" };
  const fresh = { teamId: "new", sessionId: "new", projectFolder: "/w" };
  const other = { teamId: "other", sessionId: "sess-o", projectFolder: "/w" };

  it("点名了团队就按团队 id，不管文件夹里谁先建", () => {
    // 这是那个 bug：新团队用了旧团队的文件夹，按文件夹找永远是最早的那支。
    const found = resolveBase([old, fresh], { projectFolder: "/w", teamId: "new" });
    expect(found).toEqual({ kind: "found", base: fresh });
  });

  it("点名的是一场会话，就落到它的基准团队上", () => {
    const sitting = { teamId: "sit-1", sessionId: "s", baseTeamId: "old", projectFolder: "/w" };
    const found = resolveBase([old, sitting], { projectFolder: "/w", teamId: "sit-1" });
    expect(found).toEqual({ kind: "found", base: old });
  });

  it("点名的团队不存在，或者在别的文件夹，不回落到文件夹", () => {
    expect(resolveBase([old], { projectFolder: "/w", teamId: "nope" }).kind).toBe("missing");
    expect(resolveBase([old], { projectFolder: "/别处", teamId: "old" }).kind).toBe("missing");
  });

  it("点名的团队已销毁，也是找不到", () => {
    expect(resolveBase([{ ...old, disposed: true }], { projectFolder: "/w", teamId: "old" }).kind).toBe("missing");
  });

  it("没点名、文件夹里只有一支，就是它", () => {
    expect(resolveBase([old], { projectFolder: "/w" })).toEqual({ kind: "found", base: old });
  });

  it("没点名、文件夹没人用，就是没有", () => {
    expect(resolveBase([old], { projectFolder: "/空" })).toEqual({ kind: "none" });
  });

  it("没点名、几支团队里只有一支从没被打开过，它接手第一个会话", () => {
    expect(resolveBase([old, fresh], { projectFolder: "/w" })).toEqual({ kind: "found", base: fresh });
  });

  it("没点名、几支团队都打开过，不替人挑第一支", () => {
    const found = resolveBase([old, other], { projectFolder: "/w" });
    expect(found.kind).toBe("ambiguous");
    expect(found.kind === "ambiguous" ? found.candidates.map((row) => row.teamId) : []).toEqual(["old", "other"]);
  });

  it("没点名、有两支都没被打开过，也不挑", () => {
    const fresh2 = { teamId: "new2", sessionId: "new2", projectFolder: "/w" };
    expect(resolveBase([fresh, fresh2], { projectFolder: "/w" }).kind).toBe("ambiguous");
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
