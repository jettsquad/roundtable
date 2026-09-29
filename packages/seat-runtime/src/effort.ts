/**
 * effort.ts — reading the one `agentOptions` field Squad's seats honour.
 *
 * The seam's `agentOptions` can also carry a provider, a model and an output
 * cap. A seat backend's model comes from its CONNECTION, so those three have
 * no meaning here — and a request carrying one is refused rather than run
 * with the field quietly dropped, which is the seam's own rule for anything
 * a provider does not support.
 */
import { isReasoningEffort, type ReasoningEffort } from "@squad/shared";

export function requestedEffort(request: { readonly agentOptions?: unknown }): ReasoningEffort | undefined {
  const options = request.agentOptions;
  if (options === undefined) return undefined;
  if (typeof options !== "object" || options === null) throw new Error("agentOptions 不是一个对象。");
  const { reasoningEffort, ...rest } = options as { reasoningEffort?: unknown; [key: string]: unknown };
  const extra = Object.entries(rest)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  if (extra.length > 0) {
    throw new Error(`席位只认 agentOptions.reasoningEffort；${extra.join("、")} 由连接决定，不能在这里改。`);
  }
  if (reasoningEffort === undefined) return undefined;
  if (!isReasoningEffort(reasoningEffort)) throw new Error(`不认识的思考强度「${String(reasoningEffort)}」。`);
  return reasoningEffort;
}
