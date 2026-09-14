/**
 * config-dir.ts — which configuration home a seat's `claude` runs against.
 *
 * Two rules, and the second one used to be wrong.
 *
 * An api-key seat must NOT use the host's: the CLI prefers a stored
 * subscription login over `ANTHROPIC_API_KEY`, so the connection's key was
 * accepted, displayed, and then ignored in favour of an OAuth token the
 * connection's gateway answered with 401.
 *
 * And the directory it uses instead must be STABLE. The CLI keeps its
 * conversations under the configuration home, so a fresh temp directory per
 * turn deleted the conversation that turn had just recorded — and the next
 * turn's `--resume` came back `No conversation found with session ID: <uuid>`.
 * One turn per seat lost, repeatedly, plus an identifier the person never
 * chose appearing in their transcript. Per connection is the right grain: the
 * directory's job is to hold ONE credential's state, and seats sharing a
 * connection share a credential.
 */
import { seatStateDir } from "@squad/seat-runtime";

/**
 * @returns the directory to pass as `CLAUDE_CONFIG_DIR`, or nothing when this
 * seat should use the host's own — which is what subscription mode means.
 */
export function claudeConfigDirFor(input: {
  readonly authMode?: string | undefined;
  readonly connectionId?: string | undefined;
}): string | undefined {
  if (input.authMode !== "api-key") return undefined;
  const id = (input.connectionId ?? "").trim();
  if (id === "") return undefined;
  return seatStateDir("claude-config", id);
}
