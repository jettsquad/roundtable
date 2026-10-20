import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkShellArgv } from "../src/check-shell.ts";

describe("agenda check shell", () => {
  it("uses the host shell on Windows and POSIX", () => {
    expect(checkShellArgv("exit 1", "win32")).toEqual([
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "exit 1",
    ]);
    expect(checkShellArgv("exit 1", "darwin")).toEqual(["/bin/sh", "-c", "exit 1"]);
  });

  it.skipIf(process.platform !== "win32")(
    "runs the secretary's conditional check and rejects missing or short files",
    () => {
      const root = mkdtempSync(join(tmpdir(), "squad-check-"));
      const command =
        "if (-not (Test-Path 'plan.md')) { exit 1 }; $c = Get-Content 'plan.md' -Raw; if ($c.Length -lt 20) { exit 1 }; exit 0";
      const [program, ...args] = checkShellArgv(command, "win32");
      if (program === undefined) throw new Error("No shell");
      try {
        expect(spawnSync(program, args, { cwd: root }).status).toBe(1);
        writeFileSync(join(root, "plan.md"), "stub");
        expect(spawnSync(program, args, { cwd: root }).status).toBe(1);
        writeFileSync(join(root, "plan.md"), "A complete document that exceeds the required size.");
        expect(() => execFileSync(program, args, { cwd: root })).not.toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
