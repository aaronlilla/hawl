import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, type Runner, UNIT_NAME } from "./types.ts";

export function unitDir(home: string, xdgConfigHome?: string): string {
  return join(xdgConfigHome || join(home, ".config"), "systemd", "user");
}

function quote(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** `systemd --user` unit `hawl-daemon.service` (spec 16 section 3.6). */
export function renderUnit(
  bin: string,
  command = "daemon",
  stateDir?: string,
): string {
  return `[Unit]
Description=hawl daemon
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
${stateDir ? `Environment=${quote(`HAWL_HOME=${stateDir}`)}` : ""}
ExecStart=${quote(bin)} ${command}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function installAutostart(
  run: Runner,
  bin: string,
  home: string,
  xdgConfigHome?: string,
  command = "daemon",
  stateDir?: string,
): void {
  const dir = unitDir(home, xdgConfigHome);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, UNIT_NAME), renderUnit(bin, command, stateDir), {
    mode: 0o644,
  });
  check(
    run("systemctl", ["--user", "daemon-reload"]),
    "systemctl daemon-reload",
  );
  check(
    run("systemctl", ["--user", "enable", "--now", UNIT_NAME]),
    "systemctl enable",
  );
}

export function uninstallAutostart(
  run: Runner,
  home: string,
  xdgConfigHome?: string,
): void {
  run("systemctl", ["--user", "disable", "--now", UNIT_NAME]);
  rmSync(join(unitDir(home, xdgConfigHome), UNIT_NAME), { force: true });
  run("systemctl", ["--user", "daemon-reload"]);
}
