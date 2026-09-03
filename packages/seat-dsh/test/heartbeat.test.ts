/**
 * The heartbeat is written by one process and read by another, and the two
 * agree on a string literal rather than on an import — see `heartbeat.ts` for
 * why. This is the check that makes the copy safe.
 */
import { readFileSync } from "node:fs";
import { SEAT_ALIVE_PREFIX, withoutHeartbeats } from "@squad/seat-runtime";
import { describe, expect, it } from "vitest";
import { heartbeatRows } from "../src/patch.ts";

describe("心跳前缀", () => {
  it("子进程写的前缀和父进程过滤的前缀是同一个", () => {
    // Read as TEXT on purpose: importing `heartbeat.ts` would run its module
    // body in the test process, and what needs checking is the literal in the
    // file the CHILD loads.
    const source = readFileSync(new URL("../src/heartbeat.ts", import.meta.url), "utf8");
    const declared = /const PREFIX = "([^"]+)"/.exec(source)?.[1];
    expect(declared).toBe(SEAT_ALIVE_PREFIX);
  });

  it("心跳行不会被当成失败原因", () => {
    // The failure channel and the liveness channel share stderr. If this ever
    // stops holding, a seat's real error is buried under its own heartbeat.
    const stderr = [
      `${SEAT_ALIVE_PREFIX} 2026-08-28T00:00:00.000Z turn/start`,
      "dsh: MISSING_CREDENTIAL: llm-deepseek: no API key",
      `${SEAT_ALIVE_PREFIX} 2026-08-28T00:00:01.000Z assistant/chunk`,
    ].join("\n");
    expect(withoutHeartbeats(stderr).trim()).toBe("dsh: MISSING_CREDENTIAL: llm-deepseek: no API key");
  });
});

describe("heartbeatRows", () => {
  it("按绝对路径插入插件行", () => {
    // A bare package name would resolve from the CHILD's profile directory,
    // where nothing of ours is installed.
    expect(heartbeatRows("/abs/heartbeat.ts").join("\n")).toBe(
      ["- insert:", "    - id: squad-seat-heartbeat", '      name: "/abs/heartbeat.ts"'].join("\n"),
    );
  });
});
