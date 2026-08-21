/**
 * store.ts — the one bit of state two slots have to share.
 *
 * The button and the panel register into different slots, so they have no
 * common React ancestor and cannot share state through one. The first version
 * of this tried to reach into the panel's setState from the button's render:
 * the label toggled and the panel never opened, which is what a shared-parent
 * assumption looks like when there is no shared parent.
 *
 * DSH's slots do have a real store mechanism (`defineStore` in the register
 * options). This stays hand-written for now because it is four lines and the
 * seam it would sit behind is the same either way; the note is here so the
 * real one replaces this rather than growing alongside it.
 */
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

export const panelStore = {
  get: (): boolean => open,
  set: (value: boolean): void => {
    open = value;
    for (const listener of listeners) listener();
  },
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Whether the panel is open, as a hook. */
export function usePanelOpen(): boolean {
  return useSyncExternalStore(panelStore.subscribe, panelStore.get, panelStore.get);
}
