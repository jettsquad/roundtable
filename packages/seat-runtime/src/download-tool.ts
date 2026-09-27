/**
 * download-tool.ts — how a seat backend finds and names the download server.
 *
 * Resolved from this module's own URL, for the reason the heartbeat's path is:
 * a seat runs with the TEAM's folder as its cwd. `.ts` beside this source in a
 * checkout, `.js` beside the emitted file in the published bundle.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOWNLOAD_DIR } from "@squad/shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT =
  ["download-mcp.ts", "download-mcp.js"].map((file) => join(HERE, file)).find((path) => existsSync(path)) ??
  join(HERE, "download-mcp.js");

/** The `--mcp-config` JSON that mounts the download tool, writing under `<cwd>/squad-downloads`. */
export function downloadMcpConfig(cwd: string, server: string): string {
  return JSON.stringify({
    mcpServers: { [server]: { command: process.execPath, args: [SCRIPT, join(cwd, DOWNLOAD_DIR)] } },
  });
}
