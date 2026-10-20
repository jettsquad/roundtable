import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SubagentActivationSpec, SubagentResult } from "@deepseek-ai/dsh-subagent";
import { runSeat } from "../src/subagent.ts";

function setup() {
  const controller = new AbortController();
  let finish!: (result: SubagentResult) => void;
  const result = new Promise<SubagentResult>((resolve) => {
    finish = resolve;
  });
  const dispose = vi.fn(async () => {
    finish({ output: [], stopReason: "aborted" });
  });
  const startActivation = vi.fn(async (_spec: SubagentActivationSpec) => ({ result, dispose }));
  const ctx = { subagents: { getProvider: () => ({ capabilities: {} }), startActivation } } as unknown as Context;
  const request = { parent: {} as Agent, prompt: [], label: "seat", signal: controller.signal };
  return { ctx, request, controller, finish, dispose, startActivation };
}

describe("managed seat activation", () => {
  it("returns the answer to the caller and releases the activation", async () => {
    const s = setup();
    const answer: SubagentResult = { output: [{ type: "text", text: "收到" }], stopReason: "completed" };
    const pending = runSeat(s.ctx, "codex", s.request);
    s.finish(answer);
    expect(await pending).toBe(answer);
    expect(s.startActivation.mock.calls[0]?.[0]).toMatchObject({ delivery: "caller", label: "seat" });
    expect(s.dispose).toHaveBeenCalledOnce();
  });

  it("cancels after startup has published the activation", async () => {
    const s = setup();
    const pending = runSeat(s.ctx, "codex", s.request);
    await Promise.resolve();
    s.controller.abort();
    expect((await pending).stopReason).toBe("aborted");
    expect(s.dispose).toHaveBeenCalledOnce();
  });

  it("handles cancellation during the publication handoff", async () => {
    const s = setup();
    s.startActivation.mockImplementation(async () => {
      s.controller.abort();
      return { result: Promise.resolve({ output: [], stopReason: "aborted" }), dispose: s.dispose };
    });
    await runSeat(s.ctx, "codex", s.request);
    expect(s.dispose).toHaveBeenCalledOnce();
  });

  it("rejects unsupported tool permissions before starting a child", async () => {
    const s = setup();
    await expect(runSeat(s.ctx, "codex", { ...s.request, toolFilter: { allow: ["WebFetch"] } })).rejects.toThrow(
      "unsupported Squad option: toolFilter",
    );
    expect(s.startActivation).not.toHaveBeenCalled();
  });
});
