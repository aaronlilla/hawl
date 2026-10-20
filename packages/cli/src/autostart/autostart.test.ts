import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveAutostartBin, setAutostart } from "./index.ts";
import {
  installAutostart as linuxInstall,
  uninstallAutostart as linuxUninstall,
  renderUnit,
  unitDir,
} from "./linux.ts";
import {
  installAutostart as macInstall,
  uninstallAutostart as macUninstall,
  plistPath,
  renderPlist,
} from "./macos.ts";
import type { Runner } from "./types.ts";
import {
  createArgs,
  deleteArgs,
  legacyVbsPath,
  renderLauncherArgs,
  renderTaskXml,
  runArgs,
  installAutostart as winInstall,
  uninstallAutostart as winUninstall,
  xmlPath,
} from "./windows.ts";

function recorder(
  status = 0,
  stderr = "",
): {
  run: Runner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status, stderr };
    },
  };
}

test("windows: XML task with no battery/time limits, hidden PowerShell launcher, no VBScript, runs now", () => {
  const home = mkdtempSync(join(tmpdir(), "hawl-win-"));
  const r = recorder();
  const bin = "C:\\Users\\O'Neil a&b\\.hawl\\bin\\hawl.cmd";
  // A 0.1.x install left a VBScript launcher; installing must clear it.
  mkdirSync(join(home, ".hawl", "bin"), { recursive: true });
  writeFileSync(legacyVbsPath(home), "old");
  winInstall(r.run, bin, home, { USERDOMAIN: "PC", USERNAME: "a&b" });
  assert.deepEqual(r.calls, [
    ["schtasks", ...createArgs(xmlPath(home))],
    ["schtasks", ...runArgs()],
  ]);
  assert.deepEqual(createArgs("x.xml"), [
    "/Create",
    "/TN",
    "hawl-daemon",
    "/XML",
    "x.xml",
    "/F",
  ]);
  const raw = readFileSync(xmlPath(home));
  assert.deepEqual([...raw.subarray(0, 2)], [0xff, 0xfe]);
  const xml = raw.subarray(2).toString("utf16le");
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<UserId>PC\\a&amp;b<\/UserId>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false</);
  assert.match(xml, /<StopIfGoingOnBatteries>false</);
  assert.match(xml, /<ExecutionTimeLimit>PT0S</);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew</);
  assert.match(xml, /<StartWhenAvailable>true</);
  assert.match(xml, /<Interval>PT1M<\/Interval>\s*<Count>999</);
  assert.match(xml, /<Command>powershell\.exe<\/Command>/);
  assert.doesNotMatch(xml, /wscript|\.vbs/i);
  assert.equal(existsSync(legacyVbsPath(home)), false);
  const args = renderLauncherArgs(bin);
  assert.ok(
    xml.includes(
      `<Arguments>${args.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")}</Arguments>`,
    ),
  );
  assert.match(
    args,
    /^-NoProfile -NonInteractive -WindowStyle Hidden -Command "/,
  );
  // Single quotes in the path are doubled for the PowerShell literal.
  assert.ok(
    args.includes("-FilePath 'C:\\Users\\O''Neil a&b\\.hawl\\bin\\hawl.cmd'"),
  );
  assert.match(
    args,
    /-ArgumentList 'daemon' -WindowStyle Hidden -Wait -PassThru; exit \$p\.ExitCode"$/,
  );
  winUninstall(r.run, home);
  assert.equal(existsSync(xmlPath(home)), false);
  assert.equal(existsSync(legacyVbsPath(home)), false);
});

test("windows: failed /Run is ignored, failed /Create throws, missing task on delete does not", () => {
  const home = mkdtempSync(join(tmpdir(), "hawl-win-"));
  const calls: string[][] = [];
  winInstall(
    (cmd, args) => {
      calls.push([cmd, ...args]);
      return args[0] === "/Run"
        ? { status: 1, stderr: "nope" }
        : { status: 0, stderr: "" };
    },
    "x",
    home,
  );
  assert.equal(calls.length, 2);
  assert.throws(
    () => winInstall(recorder(1, "denied").run, "x", home),
    /denied/,
  );
  winUninstall(recorder(1, "ERROR: The system cannot find the file").run, home);
  assert.throws(
    () => winUninstall(recorder(1, "access denied").run, home),
    /access/,
  );
  assert.deepEqual(deleteArgs().slice(0, 3), ["/Delete", "/TN", "hawl-daemon"]);
});

test("resolveAutostartBin: SEA uses execPath, else the launcher, else a clear error", () => {
  assert.equal(
    resolveAutostartBin({ isSea: true, execPath: "/x/hawl" }),
    "/x/hawl",
  );
  assert.equal(
    resolveAutostartBin({
      isSea: false,
      home: "/h",
      platform: "linux",
      execPath: "/usr/bin/node",
      exists: () => true,
    }),
    join("/h", ".hawl", "bin", "hawl"),
  );
  assert.equal(
    resolveAutostartBin({
      isSea: false,
      home: "C:\\h",
      platform: "win32",
      exists: () => true,
    }),
    join("C:\\h", ".hawl", "bin", "hawl.cmd"),
  );
  assert.throws(
    () =>
      resolveAutostartBin({ isSea: false, home: "/h", exists: () => false }),
    /npx hawl\.ai join/,
  );
});

test("macos: plist has label, program args and escapes the path", () => {
  const p = renderPlist("/Users/a&b/hawl", "/Users/a&b");
  assert.match(p, /<string>com\.hawl\.daemon<\/string>/);
  assert.match(
    p,
    /<string>\/Users\/a&amp;b\/hawl<\/string>\s*<string>daemon<\/string>/,
  );
  assert.match(p, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(p, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(p, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  const log = "/Users/a&amp;b/.hawl/logs/daemon.log";
  assert.match(p, new RegExp(`StandardOutPath</key>\\s*<string>${log}<`));
  assert.match(p, new RegExp(`StandardErrorPath</key>\\s*<string>${log}<`));
});

test("macos: install writes the plist and bootstraps, uninstall removes it", () => {
  const home = mkdtempSync(join(tmpdir(), "hawl-mac-"));
  const r = recorder();
  macInstall(r.run, "/usr/local/bin/hawl", home, 501);
  assert.ok(existsSync(plistPath(home)));
  assert.equal(
    readFileSync(plistPath(home), "utf8"),
    renderPlist("/usr/local/bin/hawl", home),
  );
  assert.ok(existsSync(join(home, ".hawl", "logs")));
  assert.deepEqual(r.calls.at(-1), [
    "launchctl",
    "bootstrap",
    "gui/501",
    plistPath(home),
  ]);
  macUninstall(r.run, home, 501);
  assert.equal(existsSync(plistPath(home)), false);
});

test("linux: unit file and systemctl --user calls", () => {
  const u = renderUnit("/home/a/.hawl/bin/hawl");
  assert.match(u, /ExecStart="\/home\/a\/\.hawl\/bin\/hawl" daemon/);
  assert.match(u, /WantedBy=default\.target/);
  assert.match(u, /Restart=always/);
  assert.match(u, /RestartSec=5/);
  assert.match(u, /StartLimitIntervalSec=0/);
  assert.match(u, /After=network-online\.target/);
  assert.match(u, /Wants=network-online\.target/);

  const home = mkdtempSync(join(tmpdir(), "hawl-lin-"));
  const r = recorder();
  linuxInstall(r.run, "/opt/hawl", home);
  const file = join(unitDir(home), "hawl-daemon.service");
  assert.equal(readFileSync(file, "utf8"), renderUnit("/opt/hawl"));
  assert.deepEqual(r.calls.at(-1), [
    "systemctl",
    "--user",
    "enable",
    "--now",
    "hawl-daemon.service",
  ]);
  linuxUninstall(r.run, home);
  assert.equal(existsSync(file), false);
});

test("linux: honours XDG_CONFIG_HOME", () => {
  assert.equal(unitDir("/home/a", "/cfg"), join("/cfg", "systemd", "user"));
});

test("local login services select the local hub and persist its state directory", () => {
  const stateDir = "C:/Users/a'b/.hawl/local";
  const windows = renderTaskXml("C:/hawl.cmd", undefined, "local", stateDir);
  assert.ok(windows.includes("&apos;local&apos;"));
  assert.ok(windows.includes("$env:HAWL_HOME"));
  assert.ok(windows.includes("a&apos;&apos;b"));
  const linux = renderUnit("/home/a/hawl", "local", "/home/a/.hawl/local");
  assert.ok(linux.includes('Environment="HAWL_HOME=/home/a/.hawl/local"'));
  assert.ok(linux.includes('ExecStart="/home/a/hawl" local'));
  const mac = renderPlist(
    "/Users/a/hawl",
    "/Users/a",
    "local",
    "/Users/a/.hawl/local",
  );
  assert.ok(mac.includes("<string>local</string>"));
  assert.ok(
    mac.includes("<key>HAWL_HOME</key><string>/Users/a/.hawl/local</string>"),
  );
});

test("HAWL_NO_AUTOSTART=1: the login entry is never touched (test machines share the OS user's one)", async () => {
  const calls: string[][] = [];
  const run: Runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status: 0, stdout: "", stderr: "" };
  };
  for (const platform of ["win32", "darwin", "linux"])
    await assert.rejects(
      setAutostart(true, {
        run,
        platform,
        home: tmpdir(),
        bin: "hawl",
        env: { HAWL_NO_AUTOSTART: "1" },
      }),
      /HAWL_NO_AUTOSTART/,
    );
  assert.deepEqual(calls, []);
});
