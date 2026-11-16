import { spawn } from "node:child_process";

/** Opens a URL or folder with the OS default handler. Best effort: failures are ignored. */
export function openExternal(target: string): void {
  const [command, args]: [string, string[]] =
    process.platform === "win32"
      ? ["explorer.exe", [target]]
      : process.platform === "darwin"
        ? ["open", [target]]
        : ["xdg-open", [target]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Opening a browser is a convenience; the URL is also printed to the terminal.
  }
}
