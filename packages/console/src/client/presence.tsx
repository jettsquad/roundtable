/**
 * presence.ts — tell the server whether this page is in front of the person.
 *
 * The server raises the finish banner, and it must not raise one for a person
 * who is looking at the answer arriving. Focus is the honest signal: a
 * visible tab in an unfocused window is exactly "working in another app".
 *
 * Installed once per page whichever surface mounts first. A heartbeat while
 * focused, because the server lets a report expire — see `PresenceTracker`.
 */
import { api } from "./api.ts";

let installed = false;

export function startPresence(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const focused = (): boolean => document.visibilityState === "visible" && document.hasFocus();
  const report = (): void => void api.reportPresence(focused()).catch(() => undefined);
  window.addEventListener("focus", report);
  window.addEventListener("blur", report);
  document.addEventListener("visibilitychange", report);
  setInterval(() => {
    if (focused()) report();
  }, 10_000);
  report();
}
