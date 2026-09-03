/**
 * tts.ts — turning one chunk of text into audio, on the host.
 *
 * On the host and not in the browser for one reason: the key. A connection's
 * credential is resolved per operation from `ctx.credentials` and must never
 * reach a page — so the browser sends text and receives bytes, and the secret
 * stays on this side of the wire.
 *
 * MiniMax's `t2a_v2`, with the audio inlined as hex rather than returned as a
 * URL. The URL form works and then does not: the object it points at lives in
 * a bucket whose ACL refuses anonymous reads, so a browser handed that link
 * gets an XML access error for audio that was successfully synthesised and
 * already paid for. Hex costs one decode and depends on nothing.
 */
import { credentialFrom } from "@squad/shared";
import type { Context } from "@deepseek-ai/cordis";

/** What the host needs to say one chunk. */
export interface SpeakRequest {
  readonly text: string;
  /** Which connection pays for it and whose endpoint answers. */
  readonly connectionId: string;
  readonly voiceId: string;
  /** 0.5–2. Outside that MiniMax refuses, so it is clamped rather than sent. */
  readonly speed?: number | undefined;
  readonly model?: string | undefined;
}

/** The default voice, used when a seat has not been given one. */
export const DEFAULT_VOICE = "Chinese (Mandarin)_Lyrical_Voice";

/**
 * Turbo rather than HD.
 *
 * A discussion is listened to as it arrives, so latency is the whole
 * experience; HD's extra quality buys nothing you notice while waiting for
 * the next seat to start talking.
 */
export const DEFAULT_TTS_MODEL = "speech-02-turbo";

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** The speech endpoint for a connection's base URL. */
export function speechEndpointFor(endpoint: string | undefined): string {
  const base = (endpoint ?? "").trim().replace(/\/+$/, "");
  // The connection points at the chat API — `/v1` for the OpenAI-compatible
  // shape, `/anthropic` for the Claude one. Speech lives beside them at
  // `/v1/t2a_v2`, so the host is what carries over, not the path.
  const host = base.replace(/\/(v1|anthropic)$/, "");
  if (host === "") throw new Error("这个连接没有填服务地址，合成不了语音。");
  return `${host}/v1/t2a_v2`;
}

/**
 * Synthesise one chunk. Throws with MiniMax's own words when it refuses.
 *
 * Its refusals are specific — an exhausted quota, a model the subscription
 * does not cover — and they are the entire value of the failure. A generic
 * 「合成失败」 would throw away the only part that says what to do.
 */
export async function speak(ctx: Context, request: SpeakRequest): Promise<Buffer> {
  const connection = ctx.seatConnections.get(request.connectionId);
  if (connection === undefined) throw new Error(`没有这个连接：${request.connectionId}。`);
  const env = await ctx.seatConnections.envFor(request.connectionId);
  const key = credentialFrom(env);
  if (key === undefined) throw new Error(`连接「${connection.displayName}」没有可用的密钥，合成不了语音。`);

  const response = await fetch(speechEndpointFor(connection.endpoint), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: request.model ?? DEFAULT_TTS_MODEL,
      text: request.text,
      voice_setting: { voice_id: request.voiceId, speed: clamp(request.speed ?? 1, 0.5, 2) },
      audio_setting: { format: "mp3" },
    }),
  });
  if (!response.ok) throw new Error(`语音接口回了 HTTP ${response.status}。`);

  const body = (await response.json()) as {
    data?: { audio?: string };
    base_resp?: { status_code?: number; status_msg?: string };
  };
  const status = body.base_resp?.status_code ?? 0;
  if (status !== 0) throw new Error(`语音接口拒绝了：${body.base_resp?.status_msg ?? `状态码 ${status}`}`);
  const hex = body.data?.audio;
  if (hex === undefined || hex === "") throw new Error("语音接口没有返回音频。");
  return Buffer.from(hex, "hex");
}
