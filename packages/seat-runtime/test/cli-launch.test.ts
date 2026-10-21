import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { findCliLaunch } from "../src/cli-launch.ts";

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "squad-cli-"));
  roots.push(dir);
  return dir;
}
function entry(dir: string, pkg: string, bin: string, file: string): string {
  const base = join(dir, "node_modules", pkg);
  mkdirSync(join(base, "bin"), { recursive: true });
  writeFileSync(join(base, "package.json"), JSON.stringify({ bin: { [bin]: file } }));
  writeFileSync(join(base, file), "");
  return join(base, file);
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it("launches Windows npm entries without cmd.exe or the extensionless shell shim", () => {
  const dir = root();
  const codex = entry(dir, "@openai/codex", "codex", "bin/codex.js");
  const claude = entry(dir, "@anthropic-ai/claude-code", "claude", "bin/claude.exe");
  writeFileSync(join(dir, "codex"), "#!/bin/sh");
  expect(findCliLaunch("codex", { Path: dir }, "win32")).toEqual({
    command: process.execPath,
    args: [codex],
    path: codex,
  });
  expect(findCliLaunch("claude", { Path: dir }, "win32")).toEqual({ command: claude, args: [], path: claude });
  expect(findCliLaunch("codex", { PATH: dir }, "darwin")).toBeUndefined();
});
it("does not select a missing package binary", () => {
  const dir = root();
  expect(findCliLaunch("claude", { PATH: dir }, "win32")).toBeUndefined();
});
it("reuses only a verified dsh host entry when no global command exists", () => {
  const dir = root();
  mkdirSync(join(dir, "lib"));
  const bin = join(dir, "lib", "bin.js");
  writeFileSync(bin, "");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "other-cli" }));
  expect(findCliLaunch("dsh", {}, "win32", bin)).toBeUndefined();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh" }));
  expect(findCliLaunch("dsh", {}, "win32", bin)).toEqual({ command: process.execPath, args: [bin], path: bin });
});
