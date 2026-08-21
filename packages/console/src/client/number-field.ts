/**
 * number-field.ts — reading a number out of a text field.
 *
 * Its own module, with tests, because of one collapse that is invisible in a
 * UI: `Number("")` is `0`. An empty cap field means "no limit" and a zero
 * means "stop before the first turn", and a parser that folds them together
 * turns a field the person left alone into a seat that never speaks.
 */

/** A non-negative finite number, or `undefined` for an empty or unusable field. */
export function numberOrUndefined(raw: string): number | undefined {
  const text = raw.trim();
  if (text === "") return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
