import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { check, LAUNCH_LABEL, type Runner } from "./types.ts";

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function plistPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);
}

/** `~/Library/LaunchAgents/com.hawl.daemon.plist`: runs at login, restarted only after a failed exit. */
export function renderPlist(
  bin: string,
  home: string,
  command = "daemon",
  stateDir?: string,
): string {
  const log = esc(posix.join(home, ".hawl", "logs", "daemon.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(bin)}</string>
    <string>${esc(command)}</string>
  </array>
${stateDir ? `  <key>EnvironmentVariables</key><dict><key>HAWL_HOME</key><string>${esc(stateDir)}</string></dict>` : ""}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

export function installAutostart(
  run: Runner,
  bin: string,
  home: string,
  uid: number,
  command = "daemon",
  stateDir?: string,
): void {
  const file = plistPath(home);
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(join(home, ".hawl", "logs"), { recursive: true });
  writeFileSync(file, renderPlist(bin, home, command, stateDir), {
    mode: 0o644,
  });
  // bootout first so a re-install reloads the new plist; "not loaded" is fine.
  run("launchctl", ["bootout", `gui/${uid}/${LAUNCH_LABEL}`]);
  check(
    run("launchctl", ["bootstrap", `gui/${uid}`, file]),
    "launchctl bootstrap",
  );
}

export function uninstallAutostart(
  run: Runner,
  home: string,
  uid: number,
): void {
  run("launchctl", ["bootout", `gui/${uid}/${LAUNCH_LABEL}`]);
  rmSync(plistPath(home), { force: true });
}
