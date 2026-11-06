import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Windows consoles (Windows Terminal, conhost, the VS Code terminal, and mintty when it runs native
 * programs on a pseudo console): no program can type into them from outside, so Hawl writes key
 * events straight into the agent's console input buffer (AttachConsole + WriteConsoleInputW).
 * A template step `["hawl:windows-console","{text}"]` asks for it. The target is found once, by
 * `clear` or `test` while the agent's process tree is alive: the nearest ANCESTOR of this process
 * (parent links only, never a sibling) whose image is claude.exe (isClaudeCode), and its console. No Claude Code above this process, or one without a console: refused, nothing
 * typed.
 * The typed text is still only `/clear` or the test marker; the self-test proves the rest.
 */
export const WIN_CONSOLE = "hawl:windows-console";
/** The whole template for a Windows console: `hawl handover config --template '[["hawl:windows-console","{text}"]]'`. */
export const WIN_CONSOLE_TEMPLATE = [[WIN_CONSOLE, "{text}"]];

/** The same charset render() allows for /clear and the marker; nothing else reaches the script. */
const SAFE_TEXT = /^[a-z0-9/-]{1,64}$/;
/** The agent's pid and its start time (100 ns ticks), so a reused pid is never typed into. */
const TARGET = /^[1-9]\d{0,9}:\d{1,20}$/;

export const CONSOLE_CS = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class HawlConsole {
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetConsoleProcessList([Out] uint[] list, uint count);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] records, uint count, out uint written);
  [DllImport("user32.dll")] static extern short VkKeyScanW(char c);
  [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint mapType);
  [StructLayout(LayoutKind.Sequential)] public struct KEY_EVENT_RECORD { public int KeyDown; public ushort RepeatCount; public ushort VirtualKeyCode; public ushort VirtualScanCode; public ushort UnicodeChar; public uint ControlKeyState; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUT_RECORD { [FieldOffset(0)] public ushort EventType; [FieldOffset(4)] public KEY_EVENT_RECORD Key; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI info);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ReadConsoleOutputCharacterW(IntPtr h, System.Text.StringBuilder b, uint len, uint xy, out uint read);
  [StructLayout(LayoutKind.Sequential)] public struct CSBI { public short SizeX, SizeY, CursorX, CursorY; public ushort Attributes; public short Left, Top, Right, Bottom; public short MaxX, MaxY; }
  public delegate bool RowReader(int y, System.Text.StringBuilder b, out uint read);
  // The visible window, where Claude Code draws its prompt box and its dialogs. null: unreadable.
  static string Screen() {
    IntPtr o = CreateFileW("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (o == new IntPtr(-1)) return null;
    CSBI i;
    string s = null;
    if (GetConsoleScreenBufferInfo(o, out i))
      s = ScreenOf(i.Bottom - i.Top + 1, i.Right - i.Left + 1, delegate(int y, System.Text.StringBuilder b, out uint r) {
        return ReadConsoleOutputCharacterW(o, b, (uint)(i.Right - i.Left + 1), (uint)(((i.Top + y) << 16) | (ushort)i.Left), out r);
      });
    CloseHandle(o);
    return s;
  }
  // Every row must read in full: a failed or short read is an unreadable screen, never a blank one.
  public static string ScreenOf(int rows, int w, RowReader read) {
    if (rows <= 0 || w <= 0) return null;
    var sb = new System.Text.StringBuilder();
    for (int y = 0; y < rows; y++) {
      var b = new System.Text.StringBuilder(w);
      uint r;
      if (!read(y, b, out r) || r != w) return null;
      sb.AppendLine(b.ToString(0, Math.Min(b.Length, w)));
    }
    return sb.ToString();
  }
  // H25: Claude Code's selection dialogs (permission prompts, the folder-trust question): their footer,
  // or a selected first option. Plain words like "Do you want to" alone also appear in replies.
  static readonly string[] DIALOG = { "enter to confirm", "esc to cancel" };
  public static uint[] Members(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return null;
    uint[] buf = new uint[512];
    uint n = GetConsoleProcessList(buf, 512);
    FreeConsole();
    if (n == 0 || n > 512) return null;
    uint[] r = new uint[n];
    Array.Copy(buf, r, n);
    return r;
  }
  // Everything slow happens first; then "ready", and the keys are written only on "go" (I6).
  public static int Type(uint pid, string text, System.IO.TextReader input, System.IO.TextWriter output) {
    FreeConsole();
    if (!AttachConsole(pid)) return 2;
    IntPtr h = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == new IntPtr(-1)) { FreeConsole(); return 3; }
    var recs = new List<INPUT_RECORD>();
    foreach (char c in text) {
      ushort vk = c == '\\r' ? (ushort)0x0D : (ushort)(VkKeyScanW(c) & 0xFF);
      for (int down = 1; down >= 0; down--) {
        var r = new INPUT_RECORD();
        r.EventType = 1;
        r.Key.KeyDown = down;
        r.Key.RepeatCount = 1;
        r.Key.VirtualKeyCode = vk;
        r.Key.VirtualScanCode = (ushort)MapVirtualKeyW(vk, 0);
        r.Key.UnicodeChar = c;
        recs.Add(r);
      }
    }
    // The caller checks the config and the turn at each stage and answers "go" or "no" (I6, H25).
    if (!Go("ready", input, output)) { CloseHandle(h); FreeConsole(); return 8; }
    // A dialog open in the agent's terminal would take the Enter: read the screen, refuse on one.
    int no = ScreenRefusal();
    if (no != 0) { output.WriteLine("nothing typed"); output.Flush(); CloseHandle(h); FreeConsole(); return no; }
    if (!Go("screened", input, output)) { CloseHandle(h); FreeConsole(); return 8; }
    uint written, entered = 0;
    bool ok = WriteConsoleInputW(h, recs.ToArray(), (uint)recs.Count, out written);
    bool go = ok && written == recs.Count && Go("typed", input, output);
    // A dialog can open while the text goes in: read the screen again right before the Enter. A few
    // ms between this read and the Enter stay open; no console API closes them.
    if (go) no = ScreenRefusal();
    if (go && no == 0) {
      ok = WriteConsoleInputW(h, Keys(0x0D, (char)13, 1), 2, out entered);
    } else if (written > 0) {
      // Refused before the Enter: one Backspace per character written, so the person's next words
      // never append to a stray "/clear" in their prompt box. Still no Enter.
      uint n = written / 2, erased;
      bool e = WriteConsoleInputW(h, Keys(0x08, (char)8, (int)n), n * 2, out erased);
      output.WriteLine("erased " + (e ? erased / 2 : 0) + " of " + n + " typed characters");
      output.Flush();
      CloseHandle(h);
      FreeConsole();
      return go ? no : 8;
    } else ok = false;
    output.WriteLine("wrote " + (written + entered) + " of " + (recs.Count + 2) + " key events");
    output.Flush();
    CloseHandle(h);
    FreeConsole();
    return ok && entered == 2 ? 0 : 4;
  }
  // 0 when the screen reads in full and shows no selection dialog, else 12 (unreadable) or 11 (dialog).
  static int ScreenRefusal() {
    string screen = Screen();
    if (screen == null) return 12;
    string low = screen.ToLowerInvariant();
    foreach (string line in screen.Split((char)10)) {
      string t = line.TrimStart();
      if (t.Length > 0 && (t[0] == (char)0x276F || t[0] == '>') && t.Substring(1).TrimStart().StartsWith("1. ")) return 11;
    }
    foreach (string d in DIALOG) if (low.Contains(d)) return 11;
    return 0;
  }
  static INPUT_RECORD[] Keys(ushort vk, char c, int times) {
    var r = new INPUT_RECORD[times * 2];
    for (int k = 0; k < r.Length; k++) {
      r[k].EventType = 1; r[k].Key.KeyDown = k % 2 == 0 ? 1 : 0; r[k].Key.RepeatCount = 1;
      r[k].Key.VirtualKeyCode = vk; r[k].Key.VirtualScanCode = (ushort)MapVirtualKeyW(vk, 0); r[k].Key.UnicodeChar = c;
    }
    return r;
  }
  static bool Go(string stage, System.IO.TextReader input, System.IO.TextWriter output) {
    output.WriteLine(stage);
    output.Flush();
    return input.ReadLine() == "go";
  }
}
`;

// The ancestor chain of __PID__, nearest first: parent links only.
const PS_FIND = `
$procs = @{}
Get-CimInstance Win32_Process | ForEach-Object { $procs[[uint32]$_.ProcessId] = $_ }
$chain = @()
$p = [uint32]__PID__
# __SELF__: the start pid itself is the first entry (it is a parent found through Git's msys table).
if ("__SELF__" -eq "1" -and $procs[$p]) {
  $chain += [pscustomobject]@{
    pid = $p
    name = "$($procs[$p].Name)"
    start = "$($procs[$p].CreationDate.ToUniversalTime().Ticks)"
    console = [bool][HawlConsole]::Members($p)
  }
}
for ($i = 0; $i -lt 24; $i++) {
  $me = $procs[$p]
  if (-not $me) { break }
  $pp = [uint32]$me.ParentProcessId
  $parent = $procs[$pp]
  # A parent that started after its child is a reused pid: the real parent is gone.
  if ($pp -eq 0 -or -not $parent -or $parent.CreationDate -gt $me.CreationDate) { break }
  $chain += [pscustomobject]@{
    pid = $pp
    name = "$($parent.Name)"
    start = "$($parent.CreationDate.ToUniversalTime().Ticks)"
    console = [bool][HawlConsole]::Members($pp)
  }
  $p = $pp
}
[Console]::Out.Write((ConvertTo-Json -InputObject @($chain) -Depth 4 -Compress))
`;

const PS_TYPE = `
$in = [Console]::In
$out = [Console]::Out
# The pid must still be the process found when clear ran, not a later one that reused its number.
$p = Get-CimInstance Win32_Process -Filter "ProcessId=__PID__"
if (-not $p -or $p.CreationDate.ToUniversalTime().Ticks -ne __TICKS__) { exit 10 }
exit [HawlConsole]::Type([uint32]__PID__, '__TEXT__', $in, $out)
`;

const PS_EXE = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const psArgs = (body: string) => [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
  Buffer.from(
    `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${CONSOLE_CS}\n'@\n${body}`,
    "utf16le",
  ).toString("base64"),
];

function powershell(body: string, timeout: number) {
  return spawnSync(PS_EXE, psArgs(body), {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout,
  });
}

/** One ancestor as PS_FIND reports it. */
export interface Ancestor {
  pid: number;
  name: string;
  start: string;
  console: boolean;
}

/**
 * Claude Code itself, by image name only: claude.exe. The native install and the npm package
 * (2.x ships bin/claude.exe) both run it. Node is never a target: its command line cannot tell
 * Claude Code's old cli.js from another script (--title, --require and the like).
 */
export function isClaudeCode(a: Ancestor): boolean {
  return a.name.toLowerCase() === "claude.exe";
}

/** `pid:start` of the nearest claude.exe ancestor, or why there is none to type into. */
export function pickAgent(chain: Ancestor[]): string {
  const a = chain.find(isClaudeCode);
  if (!a)
    throw new Error(
      "auto-clear on Windows needs Claude Code 2.x's claude.exe above this command; type /clear yourself",
    );
  if (!a.console)
    throw new Error(
      "the Claude Code process above this command has no console",
    );
  return `${a.pid}:${a.start}`;
}

/**
 * The Windows parent of an msys process (sh.exe from an npm or `~/.hawl/bin` shim) can be a fork
 * that already exited, so the Windows chain stops there. Git's `ps -W` still has the msys parent:
 * its Windows pid, or undefined when there is none.
 */
export function msysParent(psW: string, winpid: number): number | undefined {
  const rows = psW
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => /^\d+$/.test(c[0] ?? ""));
  const me = rows.find((c) => Number(c[3]) === winpid);
  const up = me && rows.find((c) => c[0] === me[1]);
  const w = Number(up?.[3]);
  return w > 0 && w !== winpid ? w : undefined;
}

/**
 * The chain from PS_FIND, continued through msys parents while no claude.exe is found. Parent
 * links only, never a sibling.
 */
export function joinMsysChain(
  chain: Ancestor[],
  start: number,
  psW: () => string,
  find: (pid: number) => Ancestor[],
): Ancestor[] {
  let out = chain;
  for (let i = 0; i < 4 && !out.some(isClaudeCode); i++) {
    // `exec node` makes node itself the msys process, so its own row is tried before its parents'.
    const table = psW();
    const up = [start, ...out.map((a) => a.pid)]
      .map((p) => msysParent(table, p))
      .find((p) => p !== undefined && !out.some((a) => a.pid === p));
    if (up === undefined) break;
    const more = find(up);
    if (!more.length) break;
    out = [...out, ...more];
  }
  return out;
}

function psFind(pid: number, self: boolean): Ancestor[] {
  const r = powershell(
    PS_FIND.replace("__PID__", String(pid)).replace(
      "__SELF__",
      self ? "1" : "0",
    ),
    30_000,
  );
  try {
    const chain = JSON.parse(r.stdout ?? "") as Ancestor[];
    if (r.status !== 0 || !Array.isArray(chain)) throw 0;
    return chain;
  } catch {
    throw new Error(
      `the agent's console could not be found (exit ${r.status ?? r.error?.message})`,
    );
  }
}

const gitPs = () =>
  spawnSync("ps", ["-W"], {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: 10_000,
  }).stdout ?? "";

/** `pid:start` of the agent's console process, found from `pid` (this process) while its ancestors live. */
export function findAgentConsole(pid = process.pid): string {
  if (process.platform !== "win32")
    throw new Error(`the ${WIN_CONSOLE} clear command works only on Windows`);
  return pickAgent(
    joinMsysChain(psFind(pid, false), pid, gitPs, (p) => psFind(p, true)),
  );
}

/** What the PowerShell typer's exit codes mean, for the typer log. */
const EXIT_WHY: Record<number, string> = {
  2: "could not attach to the agent's console",
  3: "could not open the agent's console input",
  4: "not every key event was written",
  11: "a selection dialog is open in the agent's terminal (Enter to confirm, Esc to cancel or a selected 1.)",
  12: "could not read the agent's screen",
  10: "the agent process is gone or its pid was reused",
};

/** Steps as rendered, with each windows-console step bound to the agent's console now. */
export function bindConsole(steps: string[][], find = findAgentConsole) {
  if (!steps.some((s) => s[0] === WIN_CONSOLE)) return steps;
  const target = String(find());
  return steps.map((s) => (s[0] === WIN_CONSOLE ? [...s, target] : s));
}

/**
 * The detached child's half: type `text` + Enter into the bound console. PowerShell does all the
 * slow work (start, compile, check the pid's start time, attach, open the input) and then says
 * "ready"; only then is `check` run, and the keys are written only if it returns nothing (I6).
 * Resolves to 0 when every key event was written, a refusal reason string, or another exit code.
 */
export function typeIntoConsole(
  step: string[],
  check: () => string | undefined = () => undefined,
  log: (line: string) => void = (l) => process.stdout.write(l),
): Promise<number | string> {
  const [, text, target] = step;
  if (
    step.length !== 3 ||
    !SAFE_TEXT.test(text ?? "") ||
    !TARGET.test(target ?? "")
  )
    return Promise.resolve(9);
  const [pid, ticks] = (target as string).split(":") as [string, string];
  const body = PS_TYPE.replaceAll("__PID__", pid)
    .replace("__TICKS__", ticks)
    .replace("__TEXT__", text as string);
  return new Promise((done) => {
    const ps = spawn(PS_EXE, psArgs(body), {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let refused: string | undefined;
    let refusedAt = "";
    let out = "";
    const kill = setTimeout(() => ps.kill(), 30_000);
    ps.stdout.setEncoding("utf8");
    // One answer per stage line ("ready", "screened", "typed"); the last stdout line is the result.
    ps.stdout.on("data", (d: string) => {
      out += d;
      for (let i; (i = out.indexOf("\n")) >= 0 && !refused; ) {
        const l = out.slice(0, i).trim();
        if (l !== "ready" && l !== "screened" && l !== "typed") break;
        out = out.slice(i + 1);
        refused = check();
        if (refused) refusedAt = l;
        if (refused || l === "typed") ps.stdin.end(refused ? "no\n" : "go\n");
        else ps.stdin.write("go\n");
      }
    });
    ps.on("error", () => {});
    ps.on("close", (code) => {
      clearTimeout(kill);
      // One line per step in the typer log (its stdout), tests included: target and outcome, never the
      // text. A refusal is logged by the caller (runTyper's skip).
      const why = EXIT_WHY[code ?? -1];
      // Refused after the text went in: say what was erased (the caller logs the reason).
      if (refused && refusedAt === "typed") {
        const m = /erased (\d+) of (\d+)/.exec(out);
        log(
          `${WIN_CONSOLE} into ${target}: refused before the Enter; ${m ? `erased the ${m[1]} typed characters${m[1] === m[2] ? "" : ` of ${m[2]}`}` : "could not erase the typed text"}\n`,
        );
      }
      if (!refused)
        log(
          `${WIN_CONSOLE} into ${target}: exit ${code}${why ? ` (${why})` : ""}${out.trim() ? `, ${out.trim()}` : ""}\n`,
        );
      done(refused ?? code ?? 1);
    });
  });
}
