/**
 * hash.ts — the confirmation fingerprint.
 *
 * Separate from `@squad/shared`'s `agenda-identity.ts` for one reason:
 * `node:crypto`. That package is bundled into the browser panel, and a single
 * Node import in its barrel stops the client build. So the canonical form —
 * the part both sides must agree on, and the part with the subtle rules —
 * stays shared and tested; turning those bytes into sha256 stays here, on the
 * side that has a crypto module.
 */
import { createHash } from "node:crypto";
import { canonicalAgenda, type AgendaSpec } from "@squad/shared";

/** sha256 of the canonical agenda, hex. */
export function agendaHash(agenda: AgendaSpec): string {
  return createHash("sha256").update(canonicalAgenda(agenda), "utf8").digest("hex");
}
