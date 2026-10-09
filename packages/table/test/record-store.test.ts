/**
 * Squad 自己那份讨论记录。
 *
 * 这份文件是以后唯一读的地方，所以它要是悄悄少了一行、或者悄悄退回去读旧的，
 * 界面上什么都看不出来——讨论只是「好像短了一点」。这里钉住的都是这种安静的错。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareRecords, missingFromFile, readRecordFile, storedTeamLog, type TranscriptEvent } from "../src/log.ts";

function fakeHost(seed: { type: string; data?: unknown }[] = []) {
  const events = seed.map((event, seq) => ({ ...event, seq, time: 1000 + seq }));
  let refuse = false;
  const host = {
    session: {
      append(type: string, data: unknown) {
        if (refuse) throw new Error("dsh 不收");
        events.push({ type, data, seq: events.length, time: 1000 + events.length });
      },
      snapshotEvents: () => events,
    },
  };
  return { host: host as never, events, refuseAppends: () => (refuse = true) };
}

const said = (id: string, speaker: string, text: string) => ({
  type: "user/message",
  data: { id, role: "user", source: { kind: "user" }, content: [{ type: "text", text: `【${speaker}】${text}` }] },
});
const line = (turnId: string, text: string, kind = "user/message"): TranscriptEvent => ({ kind, text, turnId, at: 1 });

const folders: string[] = [];
const tempFile = (): string => {
  const folder = mkdtempSync(join(tmpdir(), "squad-record-"));
  folders.push(folder);
  return join(folder, "records", "team-1.jsonl");
};
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("storedTeamLog：第一次打开", () => {
  it("把 dsh 会话里已有的全部事件按顺序搬进文件", () => {
    // 不是发言的事件也搬：检查点记的「覆盖到哪一条」有时是这类事件的编号
    // （seq-51），搬丢了那份检查点就找不到自己的边界。
    const { host } = fakeHost([{ type: "permission/preset" }, said("t1", "主持人", "问"), said("t2", "樱木", "答")]);
    const path = tempFile();
    const log = storedTeamLog(host, path, () => undefined);
    expect(readRecordFile(path).map((event) => [event.kind, event.turnId, event.text])).toEqual([
      ["permission/preset", "seq-0", ""],
      ["user/message", "t1", "【主持人】问"],
      ["user/message", "t2", "【樱木】答"],
    ]);
    expect(log.check()).toMatchObject({ source: "file", lines: 2, sessionLines: 2, missing: [], different: [] });
  });

  it("保住每条原来的时间", () => {
    const { host } = fakeHost([said("t1", "主持人", "问")]);
    const path = tempFile();
    storedTeamLog(host, path, () => undefined);
    expect(readRecordFile(path)[0]?.at).toBe(1000);
  });

  it("不留半个文件", () => {
    const { host } = fakeHost([said("t1", "主持人", "问")]);
    const path = tempFile();
    storedTeamLog(host, path, () => undefined);
    expect(existsSync(`${path}.partial`)).toBe(false);
  });
});

describe("storedTeamLog：之后", () => {
  it("新发言两边都写，读的是文件", () => {
    const { host, events } = fakeHost([said("t1", "主持人", "问")]);
    const path = tempFile();
    const log = storedTeamLog(host, path, () => undefined);
    const id = log.append("樱木", "答");
    expect(events).toHaveLength(2);
    expect(readRecordFile(path).map((event) => event.turnId)).toEqual(["t1", id]);
    expect(log.events().map((event) => event.text)).toEqual(["【主持人】问", "【樱木】答"]);
  });

  it("重新打开：文件就是记录，哪怕 dsh 会话已经换成一个空的", () => {
    // 升级之后旧的主持节点会话打不开，换一个新的——讨论必须还在。
    const first = fakeHost([said("t1", "主持人", "问"), said("t2", "樱木", "答")]);
    const path = tempFile();
    storedTeamLog(first.host, path, () => undefined);
    const fresh = fakeHost([{ type: "permission/preset" }]);
    const log = storedTeamLog(fresh.host, path, () => undefined);
    expect(log.events().map((event) => event.turnId)).toEqual(["t1", "t2"]);
    // 新会话里那些只有编号的事件不往文件里抄：编号从头再来，会跟旧的撞。
    expect(readRecordFile(path)).toHaveLength(2);
  });

  it("重新打开：dsh 会话里多出来的发言补进文件", () => {
    // 中间跑过一次老版本，或者两次写入之间进程死了。
    const { host, events } = fakeHost([said("t1", "主持人", "问")]);
    const path = tempFile();
    storedTeamLog(host, path, () => undefined);
    events.push({ ...said("t2", "樱木", "答"), seq: events.length, time: 2000 });
    const log = storedTeamLog(host, path, () => undefined);
    expect(log.events().map((event) => event.turnId)).toEqual(["t1", "t2"]);
    expect(log.check().missing).toEqual([]);
  });

  it("dsh 会话不收这条了，文件照写，不算失败", () => {
    const { host, refuseAppends } = fakeHost([said("t1", "主持人", "问")]);
    const path = tempFile();
    const said2: string[] = [];
    const log = storedTeamLog(host, path, (message) => said2.push(message));
    refuseAppends();
    const id = log.append("樱木", "答");
    expect(log.events().at(-1)).toMatchObject({ turnId: id, text: "【樱木】答" });
    expect(said2.join()).toContain("没能写进 dsh 会话");
  });
});

describe("storedTeamLog：文件出了问题", () => {
  it("文件坏了就退回去读 dsh 会话，并且说出来", () => {
    const { host } = fakeHost([said("t1", "主持人", "问")]);
    const path = tempFile();
    storedTeamLog(host, path, () => undefined);
    writeFileSync(path, "这不是 JSON\n", "utf8");
    const reported: string[] = [];
    const log = storedTeamLog(host, path, (message) => reported.push(message));
    expect(log.events().map((event) => event.turnId)).toEqual(["t1"]);
    expect(log.check()).toMatchObject({ source: "session" });
    expect(log.check().problem).toContain("不是 JSON");
    expect(reported).toHaveLength(1);
    // 坏文件原样留着，不覆盖——它是什么样，得有人能看。
    expect(readFileSync(path, "utf8")).toBe("这不是 JSON\n");
  });
});

describe("missingFromFile / compareRecords", () => {
  it("只补发言，不补只有编号的事件", () => {
    const file = [line("t1", "【甲】一")];
    const session = [line("seq-0", "", "permission/preset"), line("t1", "【甲】一"), line("t2", "【乙】二")];
    expect(missingFromFile(file, session).map((event) => event.turnId)).toEqual(["t2"]);
  });

  it("一条不差时两个清单都是空的", () => {
    const events = [line("t1", "【甲】一"), line("t2", "【乙】二")];
    expect(compareRecords(events, events)).toEqual({ lines: 2, sessionLines: 2, missing: [], different: [] });
  });

  it("少了的、内容对不上的，各自点名", () => {
    const file = [line("t1", "【甲】一"), line("t2", "【乙】改过了")];
    const session = [line("t1", "【甲】一"), line("t2", "【乙】二"), line("t3", "【丙】三")];
    expect(compareRecords(file, session)).toMatchObject({ missing: ["t3"], different: ["t2"] });
  });

  it("文件比会话多不算问题——换过主持节点之后就是这样", () => {
    const file = [line("t1", "【甲】一"), line("t2", "【乙】二")];
    expect(compareRecords(file, [])).toEqual({ lines: 2, sessionLines: 0, missing: [], different: [] });
  });
});
