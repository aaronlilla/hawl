import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { selfInstall } from "./self-install.ts";

function home() {
  return mkdtempSync(join(tmpdir(), "hawl-si-"));
}

test("npx run: writes a shim that runs the script, adds PATH to profile and process", () => {
  const h = home();
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  const r = selfInstall({
    home: h,
    platform: "linux",
    execPath: "/usr/bin/node",
    scriptPath: "/cache/hawl/dist/main.js",
    isSea: false,
    env,
  });
  assert.equal(r.warning, undefined);
  assert.equal(r.binPath, join(h, ".hawl", "bin", "hawl"));
  assert.match(
    readFileSync(r.binPath, "utf8"),
    /^#!\/bin\/sh\nexec "\/usr\/bin\/node" ".*main\.js" "\$@"\n$/,
  );
  if (process.platform !== "win32") assert.ok(statSync(r.binPath).mode & 0o100);
  assert.match(
    readFileSync(join(h, ".profile"), "utf8"),
    /\.hawl\/bin.*# added by hawl/,
  );
  assert.ok(env.PATH?.startsWith(r.binDir));
  assert.equal(r.processPathUpdated, true);
});

test("second run is idempotent: one profile line, PATH not doubled", () => {
  const h = home();
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  const d = {
    home: h,
    platform: "linux",
    execPath: "/n",
    scriptPath: "/s.js",
    isSea: false,
    env,
  } as const;
  selfInstall(d);
  const r2 = selfInstall(d);
  assert.deepEqual(r2.pathUpdated, []);
  assert.equal(r2.processPathUpdated, false);
  const profile = readFileSync(join(h, ".profile"), "utf8");
  assert.equal(profile.split("# added by hawl").length - 1, 1);
});

test("macOS uses .zprofile and appends to an existing .bash_profile", () => {
  const h = home();
  const bp = join(h, ".bash_profile");
  writeFileSync(bp, "export A=1");
  const r = selfInstall({
    home: h,
    platform: "darwin",
    execPath: "/n",
    scriptPath: "/s.js",
    isSea: false,
    env: { PATH: "/usr/bin" },
  });
  assert.equal(r.pathUpdated.length, 2);
  assert.match(
    readFileSync(bp, "utf8"),
    /^export A=1\nexport PATH=.*# added by hawl\n$/,
  );
  assert.ok(existsSync(join(h, ".zprofile")));
});

test("single-file binary is copied, not shimmed", () => {
  const h = home();
  const src = join(h, "src-hawl");
  writeFileSync(src, "BINARY");
  const r = selfInstall({
    home: h,
    platform: "linux",
    execPath: src,
    isSea: true,
    env: { PATH: "" },
  });
  assert.equal(readFileSync(r.binPath, "utf8"), "BINARY");
});

test("windows: .cmd shim and user PATH set through powershell with HAWL_BIN", () => {
  const h = home();
  const calls: { cmd: string; env?: NodeJS.ProcessEnv }[] = [];
  const env: NodeJS.ProcessEnv = { Path: "C:\\Windows" };
  const r = selfInstall({
    home: h,
    platform: "win32",
    execPath: "C:\\node\\node.exe",
    scriptPath: "C:\\cache\\main.js",
    isSea: false,
    env,
    run: (cmd, _a, e) => {
      calls.push({ cmd, env: e });
      return { status: 0, stdout: "changed\r\n", stderr: "" };
    },
  });
  assert.match(r.binPath, /hawl\.cmd$/);
  assert.match(
    readFileSync(r.binPath, "utf8"),
    /"C:\\node\\node\.exe" ".*main\.js" %\*/,
  );
  assert.equal(calls[0]?.cmd, "powershell");
  assert.equal(calls[0]?.env?.HAWL_BIN, r.binDir);
  assert.deepEqual(r.pathUpdated, ["user PATH"]);
  assert.ok(env.Path?.startsWith(r.binDir));
});

test("windows: HAWL_NO_PERSIST_PATH=1 leaves the user PATH alone", () => {
  let ran = false;
  const r = selfInstall({
    home: home(),
    platform: "win32",
    execPath: "n",
    scriptPath: "s.js",
    isSea: false,
    env: { Path: "C:\\Windows", HAWL_NO_PERSIST_PATH: "1" },
    run: () => {
      ran = true;
      return { status: 0, stdout: "changed", stderr: "" };
    },
  });
  assert.equal(ran, false);
  assert.deepEqual(r.pathUpdated, []);
  assert.equal(r.processPathUpdated, true);
});

test("a failed PATH write warns but keeps the install", () => {
  const h = home();
  const r = selfInstall({
    home: h,
    platform: "win32",
    execPath: "n",
    scriptPath: "s.js",
    isSea: false,
    env: {},
    run: () => ({ status: 1, stdout: "", stderr: "denied" }),
  });
  assert.match(r.warning ?? "", /PATH was not saved: denied/);
  assert.ok(existsSync(r.binPath));
});
