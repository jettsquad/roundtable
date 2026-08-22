import { describe, expect, it } from "vitest";
import { buildDshArgv } from "../src/argv.ts";
import { readDshOutput } from "../src/stream.ts";

describe("buildDshArgv", () => {
  it("profile + 一个参数的提示词", () => {
    // `dsh --profile headless` 会把多个词用空格连起来，拆开传就会把
    // 席位提示词里承重的换行悄悄压平。
    const argv = buildDshArgv({ prompt: "第一行\n第二行", profile: "headless" });
    expect(argv).toEqual(["--profile", "headless", "第一行\n第二行"]);
  });

  it("profile 可换", () => {
    expect(buildDshArgv({ prompt: "x", profile: "seats" })[1]).toBe("seats");
  });
});

describe("readDshOutput", () => {
  it("纯文本直接就是答复", () => {
    expect(readDshOutput("  答复在这里  ")).toMatchObject({ text: "答复在这里", failed: false });
  });

  it("空输出算失败", () => {
    expect(readDshOutput("").failed).toBe(true);
    expect(readDshOutput("\n \n").failed).toBe(true);
  });

  it("没有用量，而不是零用量", () => {
    // headless 只打印最终消息，没有账目。报 0 会读成「便宜」而不是「没计量」。
    expect(readDshOutput("答复").usage).toBeUndefined();
  });
});
