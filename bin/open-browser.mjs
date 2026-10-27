// Open the page in the default browser. A machine without an opener (a server, WSL, a minimal Linux
// without xdg-open) must not crash the server: spawn reports the missing program as an "error" event,
// which would otherwise be unhandled, so the address is printed instead.
import { spawn } from "node:child_process";

export function openBrowser(url, platform = process.platform, log = console.log) {
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  const child = spawn(cmd, [url], { stdio: "ignore", detached: true, shell: platform === "win32" });
  child.on("error", () => log(`Could not open a browser here; open ${url} yourself.`));
  child.unref();
}
