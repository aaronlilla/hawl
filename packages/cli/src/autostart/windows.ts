import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, type Runner, TASK_NAME } from "./types.ts";

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function xmlPath(home: string): string {
  return join(home, ".hawl", "hawl-daemon-task.xml");
}

/** Launcher written by CLI 0.1.x; removed on install and uninstall so upgrades leave nothing behind. */
export function legacyVbsPath(home: string): string {
  return join(home, ".hawl", "bin", "hawl-daemon.vbs");
}

/**
 * Hidden launcher: a visible console from a logon task would kill the daemon when closed.
 * PowerShell starts the daemon with no window and waits, so the task sees the daemon's exit
 * code and RestartOnFailure still fires. Inline `-Command` is not subject to execution policy.
 * No VBScript: Microsoft is turning it off by default (FOD), and `conhost --headless` is
 * undocumented and flagged by EDR rules.
 */
export function renderLauncherArgs(
  bin: string,
  command = "daemon",
  stateDir?: string,
): string {
  const quoted = bin.replaceAll("'", "''");
  const prefix = stateDir
    ? `$env:HAWL_HOME = '${stateDir.replaceAll("'", "''")}'; `
    : "";
  const script = `${prefix}$p = Start-Process -FilePath '${quoted}' -ArgumentList '${command}' -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`;
  return `-NoProfile -NonInteractive -WindowStyle Hidden -Command "${script}"`;
}

/**
 * Task XML for `schtasks /Create /XML` (spec 16 section 3.6). The /SC ONLOGON defaults stop the
 * daemon on battery and after 72h; this turns both off (PT0S = no time limit).
 */
export function renderTaskXml(
  bin: string,
  user?: string,
  command = "daemon",
  stateDir?: string,
): string {
  const userId = user ? `\n      <UserId>${esc(user)}</UserId>` : "";
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>${userId}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">${userId}
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>${esc(renderLauncherArgs(bin, command, stateDir))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function createArgs(xml: string): string[] {
  return ["/Create", "/TN", TASK_NAME, "/XML", xml, "/F"];
}

export function runArgs(): string[] {
  return ["/Run", "/TN", TASK_NAME];
}

export function deleteArgs(): string[] {
  return ["/Delete", "/TN", TASK_NAME, "/F"];
}

export function installAutostart(
  run: Runner,
  bin: string,
  home: string,
  env: Record<string, string | undefined> = {},
  command = "daemon",
  stateDir?: string,
): void {
  const user =
    env.USERNAME && env.USERDOMAIN
      ? `${env.USERDOMAIN}\\${env.USERNAME}`
      : env.USERNAME;
  mkdirSync(join(home, ".hawl", "bin"), { recursive: true });
  rmSync(legacyVbsPath(home), { force: true });
  // schtasks /XML wants UTF-16LE with a BOM.
  writeFileSync(
    xmlPath(home),
    Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(renderTaskXml(bin, user, command, stateDir), "utf16le"),
    ]),
  );
  check(run("schtasks", createArgs(xmlPath(home))), "schtasks create");
  // Start it now; a failed /Run still leaves a working logon task.
  run("schtasks", runArgs());
}

export function uninstallAutostart(run: Runner, home: string): void {
  const r = run("schtasks", deleteArgs());
  rmSync(xmlPath(home), { force: true });
  rmSync(legacyVbsPath(home), { force: true });
  // Deleting a task that is not there is already the wanted end state.
  if (r.status !== 0 && !/cannot find|does not exist/i.test(r.stderr)) {
    check(r, "schtasks delete");
  }
}
