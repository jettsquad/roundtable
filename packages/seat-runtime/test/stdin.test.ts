import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";
import { runCliSeat } from "../src/index.ts";

describe("seat prompt transport", () => {
  it("delivers the entire long Unicode prompt as stdin data without putting it in argv", async () => {
    const prompt = '很长的讨论 "quotes"\n'.repeat(10000);
    const spawn = vi.fn((_spec: SubprocessSpawnSpec) => ({
      done: Promise.resolve({ exitCode: 0 }),
      collected: { stdout: { readFrom: () => ({ text: "收到", nextOffset: 6 }) } },
      terminate: vi.fn(),
    }));
    const ctx = {
      subprocess: { resolveExecutable: async () => "cli", spawn },
      logger: { warn: vi.fn() },
    } as unknown as Context;
    const run = await runCliSeat({
      ctx,
      who: "test",
      command: "cli",
      promptViaStdin: true,
      request: {
        cwd: tmpdir(),
        parent: { session: { id: "parent" } } as unknown as Agent,
        prompt: [{ type: "text", text: prompt }],
        signal: new AbortController().signal,
      },
      argv: () => ["-p"],
      env: {},
      parse: (text) => ({ text, failed: false }),
      limits: { idleMs: 1000, firstOutputMs: 1000, pollMs: 100 },
      disposeGraceMs: 100,
    });
    expect((await run.result).stopReason).toBe("completed");
    expect(spawn.mock.calls[0]?.[0].stdio.stdin).toEqual({ data: prompt });
    expect(spawn.mock.calls[0]?.[0].argv).toEqual(["cli", "-p"]);
  });
});
