import { spawn } from "node:child_process";

/**
 * Can this terminal open a browser for the person? No over SSH, no on a Linux box without a
 * display, and never when `HAWL_NO_OPEN=1`.
 */
export function canOpenBrowser(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): boolean {
  if (env.HAWL_NO_OPEN === "1") return false;
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
  if (platform === "win32" || platform === "darwin") return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

type Spawn = typeof spawn;
const SETTLE_MS = 1_500;

/** One try: start the opener and wait briefly. False when it errors or exits non-zero. */
function attempt(
  spawnFn: Spawn,
  cmd: string,
  args: string[],
  verbatim: boolean,
  settleMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const end = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    // Still running (or detached and gone quiet) after the wait counts as opened.
    const timer = setTimeout(() => end(true), settleMs);
    try {
      const child = spawnFn(cmd, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
      });
      child.on("error", () => end(false));
      child.on("exit", (code) => end(code === 0 || code === null));
      child.unref();
    } catch {
      end(false);
    }
  });
}

/**
 * Open an http(s) link in the default browser. True when an opener started and did not fail
 * within a moment. Never throws and never waits longer than a few seconds, so a broken opener
 * cannot fail or slow `hawl join`: the caller prints the link either way.
 *
 * Windows goes through `cmd /c start`, then `explorer.exe`; `rundll32 url.dll` is not used (it
 * fails on some machines).
 */
export async function openUrl(
  url: string,
  platform: string = process.platform,
  spawnFn: Spawn = spawn,
  settleMs: number = SETTLE_MS,
): Promise<boolean> {
  // The link goes inside quotes on a command line: nothing that could end the quotes.
  if (!/^https?:\/\/[^\s"'`^<>|\\]+$/i.test(url)) return false;
  if (platform === "win32") {
    if (
      await attempt(
        spawnFn,
        "cmd.exe",
        ["/d", "/c", "start", '""', `"${url}"`],
        true,
        settleMs,
      )
    )
      return true;
    return attempt(spawnFn, "explorer.exe", [url], false, settleMs);
  }
  if (platform === "darwin")
    return attempt(spawnFn, "open", [url], false, settleMs);
  return attempt(spawnFn, "xdg-open", [url], false, settleMs);
}
