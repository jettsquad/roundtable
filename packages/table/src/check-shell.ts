/** Run agenda checks in the host platform's native shell. */
export function checkShellArgv(command: string, platform: string = process.platform): readonly string[] {
  return platform === "win32"
    ? ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
    : ["/bin/sh", "-c", command];
}
