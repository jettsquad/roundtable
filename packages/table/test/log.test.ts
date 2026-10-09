/**
 * 讨论记录的唯一入口。
 *
 * 桌子里所有读写都经过 TeamLog；这里钉住它对调用方的承诺，这样以后把记录换一个
 * 地方存的时候，换的是这个文件背后的东西，承诺不变。
 */
import { describe, expect, it } from "vitest";
import { sessionTeamLog } from "../src/log.ts";

/** A host whose session is an array — enough for the two calls the log makes. */
function fakeHost(seed: { type: string; data?: unknown }[] = []) {
  const events = seed.map((event, seq) => ({ ...event, seq, time: 1000 + seq }));
  const appended: unknown[] = [];
  const host = {
    session: {
      append(type: string, data: unknown, options: unknown) {
        appended.push(options);
        events.push({ type, data, seq: events.length, time: 1000 + events.length });
      },
      snapshotEvents: () => events,
    },
  };
  return { host: host as never, appended };
}

describe("sessionTeamLog", () => {
  it("写一条，读回来是「【谁】说了什么」，并带着它的 id 和时间", () => {
    const { host } = fakeHost();
    const log = sessionTeamLog(host);
    const turnId = log.append("樱木", "我认为可以");
    expect(log.events()).toEqual([{ kind: "user/message", text: "【樱木】我认为可以", turnId, at: 1000 }]);
  });

  it("给了 id 就用给的——命令的 id、迁移过来的旧发言的 id 都靠这个保住", () => {
    const { host } = fakeHost();
    const log = sessionTeamLog(host);
    expect(log.append("主持人", "问题", "squad-cmd-1")).toBe("squad-cmd-1");
    expect(log.events()[0]?.turnId).toBe("squad-cmd-1");
  });

  it("没给就现造一个，每条都不一样", () => {
    const { host } = fakeHost();
    const log = sessionTeamLog(host);
    expect(log.append("甲", "一")).not.toBe(log.append("甲", "二"));
  });

  it("不是发言的事件原样带出来：没有文字，但看得见类型", () => {
    // 装配器有一张表专门抓「主持节点自己跑了一轮」的事件类型。这里要是把它们
    // 滤掉，负责发现问题的那个部件就成了唯一看不见问题的部件。
    const { host } = fakeHost([{ type: "permission/preset" }, { type: "turn/start", data: { turn: 1 } }]);
    const log = sessionTeamLog(host);
    log.append("甲", "一");
    expect(log.events().map((event) => [event.kind, event.text, event.turnId])).toEqual([
      ["permission/preset", "", "seq-0"],
      ["turn/start", "", "seq-1"],
      ["user/message", "【甲】一", expect.stringMatching(/^squad-/)],
    ]);
  });

  it("size 数的是全部事件；零就是没人碰过的一场", () => {
    const { host } = fakeHost();
    const log = sessionTeamLog(host);
    expect(log.size()).toBe(0);
    log.append("甲", "一");
    expect(log.size()).toBe(1);
  });

  it("写进 dsh 会话时带上 surfaceOp", () => {
    // dsh 要求每条进入对话面的事件说明自己怎么加入；0.2 的校验器先查这个。
    const { host, appended } = fakeHost();
    sessionTeamLog(host).append("甲", "一");
    expect(appended).toEqual([{ surfaceOp: "append" }]);
  });
});
