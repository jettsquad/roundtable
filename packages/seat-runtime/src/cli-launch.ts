import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, basename } from "node:path";

export interface CliLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly path: string;
}

/** npm's Windows shims are shell scripts, not executables. Launch the declared
 * package entry directly so prompts never pass through cmd.exe quoting/limits. */
export function findCliLaunch(
  command: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  hostEntry: string | undefined = process.argv[1],
): CliLaunch | undefined {
  const packages: Record<string, string> = {
    claude: "@anthropic-ai/claude-code",
    codex: "@openai/codex",
    npm: "npm",
  };
  if (platform === "win32" && packages[command] !== undefined) {
    const path = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
    for (const dir of path.split(delimiter).filter(Boolean)) {
      const packageDir = join(dir, "node_modules", packages[command]!);
      try {
        const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
          bin?: string | Record<string, string>;
        };
        const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[command];
        if (entry !== undefined && existsSync(join(packageDir, entry))) {
          const target = join(packageDir, entry);
          return /\.(?:c?js|mjs)$/i.test(target)
            ? { command: process.execPath, args: [target], path: target }
            : { command: target, args: [], path: target };
        }
      } catch {
        // Not an npm installation in this PATH directory.
      }
      // Respect an earlier native installation rather than silently skipping it.
      if (existsSync(join(dir, `${command}.exe`))) {
        return undefined;
      }
    }
  }
  // A source-started harness need not have a global dsh shim. Only reuse an
  // entry whose package identifies itself as the harness CLI.
  if (command === "dsh" && hostEntry !== undefined && basename(hostEntry) === "bin.js") {
    try {
      const manifest = JSON.parse(readFileSync(join(dirname(hostEntry), "..", "package.json"), "utf8")) as {
        name?: string;
      };
      if (manifest.name === "@deepseek-ai/dsh") {
        return { command: process.execPath, args: [hostEntry], path: hostEntry };
      }
    } catch {
      // Not the harness entry point.
    }
  }
  return undefined;
}
