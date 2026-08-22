import { beforeEach, describe, expect, it, vi } from "vitest";
import { setTeamFolders, teamFolders, watchTeamFolders } from "../src/client/team-sessions.ts";

beforeEach(() => setTeamFolders([]));

describe("team folders cache", () => {
  it("换了才通知", () => {
    // 面板每两秒轮询一次。每次都通知就会每两秒重新注册一次 composer，
    // 把人正在打的字连输入框一起拆掉。
    const heard = vi.fn();
    watchTeamFolders(heard);
    setTeamFolders(["/a"]);
    expect(heard).toHaveBeenCalledTimes(1);
    setTeamFolders(["/a"]);
    expect(heard).toHaveBeenCalledTimes(1);
    setTeamFolders(["/a", "/b"]);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("顺序不同不算变", () => {
    const heard = vi.fn();
    setTeamFolders(["/a", "/b"]);
    watchTeamFolders(heard);
    setTeamFolders(["/b", "/a"]);
    expect(heard).not.toHaveBeenCalled();
  });

  it("少了一个也算变", () => {
    // 解散一支团队之后，它的 session 必须交回原来的输入框。
    const heard = vi.fn();
    setTeamFolders(["/a", "/b"]);
    watchTeamFolders(heard);
    setTeamFolders(["/a"]);
    expect(heard).toHaveBeenCalledTimes(1);
    expect([...teamFolders()]).toEqual(["/a"]);
  });

  it("取消订阅之后不再通知", () => {
    const heard = vi.fn();
    const stop = watchTeamFolders(heard);
    stop();
    setTeamFolders(["/x"]);
    expect(heard).not.toHaveBeenCalled();
  });
});
