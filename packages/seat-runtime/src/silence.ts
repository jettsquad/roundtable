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
    ? `这个席位 ${Math.round(limits.firstOutputMs / 1000)} 秒内一个字都没输出，按连不上处理。` +
        `多半是它的连接端点没有响应——到 Agent 库点「测试」看接口地址那一项。`
    : `这个席位停了 ${Math.round(limits.idleMs / 1000)} 秒没有新输出，已经中止。`;
}
