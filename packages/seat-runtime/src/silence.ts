/**
 * silence.ts — deciding that a seat has stopped talking.
 *
 * Its own module because it is the judgement the first watchdog got wrong:
 * it had ONE deadline where there are two, and it counted from the start
 * where it must count from the last byte. The comment claimed "idle rather
 * than total" while the code armed a single timer and never reset it, so a
 * long task died mid-answer and an unreachable endpoint took ten minutes to
 * say nothing.
 */

export interface SilenceLimits {
  /** How long a seat may go quiet AFTER it has said something. */
  readonly idleMs: number;
  /** How long a seat may say nothing at all before it counts as unreachable. */
  readonly firstOutputMs: number;
  /** How often to look. */
  readonly pollMs: number;
}

export type SilenceReason = "silent" | "no-output";

/**
 * The thresholds every seat backend uses, in ONE place.
 *
 * 1.x had this number written out three times — claude-code, codex and the
 * harness executor — plus a fourth in the secretary, each with its own copy
 * of the comment. They happened to agree; nothing made them agree. Here the
 * backends read these and may override them from config, so a divergence is
 * a deliberate line in a profile rather than a constant somebody forgot.
 *
 * `idleMs` is 1.x's number exactly: fifteen minutes of SILENCE, not of work.
 * There is no total-duration cap, and there should not be — a deep task
 * legitimately runs far longer than any wall clock, and a CLI that is working
 * streams as it goes, so it never goes quiet for long. Too short a window
 * kills real work; a long one only delays reclaiming a truly stuck process.
 *
 * `firstOutputMs` is ours, and 1.x had no equivalent. Before the first byte
 * there is nothing to be deep ABOUT: a seat that has not said a word is
 * usually pointed at an endpoint that will never answer, and making a person
 * wait fifteen minutes to be told that is a quarter of an hour spent proving
 * something a connection test proves in a second.
 *
 * It only means anything on a CLI that actually writes while it works, and
 * one of ours did not: `dsh --profile headless` awaits the whole turn and
 * then writes the answer in a single call, so its byte count was ZERO however
 * well it was going — making this five-minute deadline a five-minute cap on
 * the entire turn, enforced with a message blaming the connection. The answer
 * was not a longer deadline (that only makes a person wait longer to learn
 * nothing) but a real signal: that backend now reports its own progress on
 * stderr, one line per session event. See `alive.ts`.
 *
 * Five minutes, and the number comes from a measurement rather than a guess:
 * a dsh seat on a real round took about 100 seconds to produce its first
 * byte — profile boot, then the model's first token. It was 33 seconds from
 * being killed as unreachable while it was working perfectly well. A deadline
 * that close to observed behaviour is a deadline that will eventually fire on
 * a healthy seat, and a watchdog that cries wolf gets ignored on the day it
 * is right.
 */
export const SEAT_SILENCE_LIMITS: SilenceLimits = {
  idleMs: 900_000,
  firstOutputMs: 300_000,
  pollMs: 2_000,
};

/**
 * Whether a stretch of silence has become a verdict, and which one.
 *
 * @param bytesSeen - total output bytes so far; zero means nothing ever arrived.
 * @param quietFor - milliseconds since the byte count last changed.
 */
export function silenceVerdict(
  bytesSeen: number,
  quietFor: number,
  limits: Pick<SilenceLimits, "idleMs" | "firstOutputMs">,
): SilenceReason | undefined {
  // Before the first byte there is nothing to be deep about, so the shorter
  // deadline applies — and the verdict names the difference, because "never
  // answered" and "stopped answering" send a person to different places.
  if (bytesSeen === 0) return quietFor >= limits.firstOutputMs ? "no-output" : undefined;
  return quietFor >= limits.idleMs ? "silent" : undefined;
}

/**
 * Cancel a seat that has gone silent — not one that is merely slow.
 *
 * Watches the stream: bytes arriving reset the clock, silence does not. A CLI
 * streaming its progress is never quiet for long, so real silence means the
 * far end is gone.
 */
export function watchSilence(
  read: () => Promise<number>,
  limits: SilenceLimits,
  onVerdict: (reason: SilenceReason) => void,
): { stop(): void } {
  let seen = 0;
  let lastChange = Date.now();
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const bytes = await read().catch(() => seen);
    if (bytes > seen) {
      seen = bytes;
      lastChange = Date.now();
    }
    const verdict = silenceVerdict(seen, Date.now() - lastChange, limits);
    if (verdict !== undefined) {
      stopped = true;
      onVerdict(verdict);
      return;
    }
    const next = setTimeout(() => void tick(), limits.pollMs);
    next.unref?.();
  };

  const first = setTimeout(() => void tick(), limits.pollMs);
  first.unref?.();
  return {
    stop: () => {
      stopped = true;
    },
  };
}

/** What a watchdog kill should say, so the reason reaches the person. */
export function silenceMessage(reason: SilenceReason, limits: Pick<SilenceLimits, "idleMs" | "firstOutputMs">): string {
  return reason === "no-output"
    ? `这个席位 ${Math.round(limits.firstOutputMs / 60_000)} 分钟内一个字都没输出，按连不上处理。` +
        `多半是它的连接端点没有响应——到 Agent 库点「测试」看接口地址那一项。`
    : `这个席位连续 ${Math.round(limits.idleMs / 60_000)} 分钟没有任何新输出，判定为卡死，已经中止。` +
        `判据是静默：只要有输出（哪怕是思考过程）就重新计时，所以跑得久本身不会被中止。`;
}
