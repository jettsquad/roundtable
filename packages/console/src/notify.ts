/**
 * notify.ts — tell the person a round is done, outside the panel.
 *
 * Done on the SERVER, with the operating system's own notifier, rather than
 * with the browser's Notification API: that one needs a permission prompt, a
 * tab that is still alive, and timers that browsers throttle to once a minute
 * in a background tab — which is exactly the state of a panel you have looked
 * away from. The server runs on the machine the person is sitting at.
 *
 * The one thing a server cannot know is whether the person is looking at the
 * panel right now, so the panel reports its focus (`PresenceTracker`) and a
 * banner is skipped while it is in front: being told what you are reading is
 * noise, and noise is what gets a notification switched off.
 */
import { execFile } from "node:child_process";

/** What a finished round is worth saying, structurally the same as the table's event. */
export interface FinishedRound {
  readonly teamName: string;
  readonly kind: "round" | "agenda";
  readonly stopped: boolean;
  readonly answered: number;
  readonly failed: number;
  readonly last?: { readonly speaker: string; readonly text: string } | undefined;
  readonly moreQueued: boolean;
  readonly waitingForHost: boolean;
}

export interface Banner {
  readonly title: string;
  readonly body: string;
}

const PREVIEW_CHARS = 90;

/** One line of a reply, with Markdown noise flattened so a banner is readable. */
export function previewOf(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS)}…`;
}

/** The banner for a finished round, or undefined when this is not a moment to interrupt. */
export function bannerFor(round: FinishedRound): Banner | undefined {
  // A queued message is already starting the next round: the person asked for
  // both, and one banner when the last of them ends is what they want.
  if (round.moreQueued) return undefined;
  const title = round.teamName;
  const what = round.kind === "agenda" ? "议程" : "这一轮";
  if (round.waitingForHost) return { title, body: `${what}停在这里，等你来决定下一步。` };
  if (round.stopped) return { title, body: `${what}已被叫停。` };
  if (round.answered > 0 && round.failed === round.answered) {
    return { title, body: `${what}结束了，但席位都没答上来。` };
  }
  const failure = round.failed > 0 ? `（${round.failed} 位没答上）` : "";
  const preview = round.last === undefined ? "" : ` ${round.last.speaker}：${previewOf(round.last.text)}`;
  return { title, body: `${what}完成了${failure}。${preview}`.trimEnd() };
}

/** A string safe inside an AppleScript double-quoted literal. */
export function appleScriptString(text: string): string {
  return `"${text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ")}"`;
}

/**
 * Raise the banner. Best effort and silent on failure: a notification that
 * cannot be shown must not turn into an error in the round that finished.
 * Arguments go as an argv array — never through a shell — because the text is
 * whatever a model wrote.
 */
export function showBanner(banner: Banner, platform: NodeJS.Platform = process.platform): void {
  const done = (): void => undefined;
  if (platform === "darwin") {
    execFile(
      "osascript",
      ["-e", `display notification ${appleScriptString(banner.body)} with title ${appleScriptString(banner.title)}`],
      done,
    );
  } else if (platform === "linux") {
    execFile("notify-send", [banner.title, banner.body], done);
  }
}

/** How long a focus report stays believable without another one. */
const FOCUS_TTL_MS = 30_000;

/**
 * Whether any panel is in front of the person right now.
 *
 * Reports arrive on focus changes and as a heartbeat while focused; one that
 * is not renewed expires, so a tab that was closed or crashed while focused
 * cannot silence notifications forever.
 */
export class PresenceTracker {
  private focusedAt: number | undefined;

  report(focused: boolean, now = Date.now()): void {
    this.focusedAt = focused ? now : undefined;
  }

  isFocused(now = Date.now()): boolean {
    return this.focusedAt !== undefined && now - this.focusedAt < FOCUS_TTL_MS;
  }
}

/** One per process: there is one person at one screen. */
export const presence = new PresenceTracker();
