import type { Context } from "@deepseek-ai/cordis";
import type { SubagentResult, SubagentStartRequest } from "@deepseek-ai/dsh-subagent";

/** Squad-specific options understood by its CLI providers. */
declare module "@deepseek-ai/dsh-subagent" {
  interface SubagentStartRequest {
    readonly persona?: string;
    readonly toolFilter?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] };
  }
  interface SubagentCapabilities {
    readonly persona?: boolean;
    readonly toolFilter?: boolean;
  }
}

/** Run a caller-delivered activation, retaining cancellation ownership until teardown. */
export async function runSeat(ctx: Context, provider: string, request: SubagentStartRequest): Promise<SubagentResult> {
  const capabilities = ctx.subagents.getProvider(provider)?.capabilities;
  for (const option of ["persona", "toolFilter"] as const) {
    if (request[option] !== undefined && capabilities?.[option] !== true) {
      throw new Error(`${provider}: unsupported Squad option: ${option}`);
    }
  }
  const { signal, label, ...task } = request;
  const activation = await ctx.subagents.startActivation({
    provider,
    label: label ?? provider,
    request: task,
    signal,
    delivery: "caller",
  });
  // The manager's startup signal stops owning cancellation after publication.
  // Retain the disposal promise so an abort cannot create an unhandled rejection.
  let disposal: Promise<void> | undefined;
  const cancel = (): void => {
    disposal ??= activation.dispose();
    void disposal.catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    return await activation.result;
  } finally {
    signal.removeEventListener("abort", cancel);
    await (disposal ?? activation.dispose());
  }
}
