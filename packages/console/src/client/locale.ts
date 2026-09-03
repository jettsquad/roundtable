/**
 * locale.ts — reaching the language switch from components that never see `ctx`.
 *
 * Squad's panel is rendered into a slot and its inner components are several
 * levels below that, so threading a `t` prop down would touch every file for
 * a value none of them vary. The same reason `team-sessions.ts` holds the
 * shell's session verbs, and the same shape.
 *
 * What makes the holder safe here is a property of the service: `bind()`
 * returns a STABLE function that reads the active locale AT CALL TIME. So the
 * only thing the holder cannot do on its own is re-render — and that is what
 * `useT` subscribes for.
 */
import { useSyncExternalStore } from "react";
import { type SquadKey, zh } from "./locales.ts";

/** What the plugin hands over once `ctx.locale` exists. */
export interface LocaleFace {
  readonly t: (key: SquadKey, params?: Record<string, unknown>) => string;
  readonly subscribe: (fn: () => void) => () => void;
  readonly revision: () => number;
}

let face: LocaleFace | undefined;

export function setLocale(next: LocaleFace): void {
  face = next;
}

/**
 * The fallback, and why it is Chinese rather than the key.
 *
 * Tests render these components with no plugin mounted, and so does any
 * composition that did not install the locale package. Showing `panel.tab.teams`
 * there would turn a missing OPTIONAL service into a visibly broken screen;
 * showing the source language keeps the surface honest while the switch is
 * simply unavailable.
 */
function fallback(key: SquadKey, params?: Record<string, unknown>): string {
  const template: string = zh[key];
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

const NO_SUBSCRIBE = (): (() => void) => () => {};

/**
 * The translate function, re-rendering the caller when the language changes.
 *
 * `useSyncExternalStore` rather than an effect: the locale is external state
 * that can change between render and commit, and the store contract is what
 * the service already exposes.
 */
export function useT(): (key: SquadKey, params?: Record<string, unknown>) => string {
  const revision = useSyncExternalStore(
    face?.subscribe ?? NO_SUBSCRIBE,
    () => face?.revision() ?? 0,
    () => 0,
  );
  // `revision` is read so the hook re-runs on a switch; the returned function
  // is otherwise stable, which is the point of binding once.
  void revision;
  return face?.t ?? fallback;
}
