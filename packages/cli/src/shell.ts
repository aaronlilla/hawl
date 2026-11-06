/**
 * One command line for `cmd.exe`. Node 22+ prints DEP0190 ("Passing args to a child process with
 * shell option true...") whenever `spawn(cmd, args, { shell: true })` gets a non-empty args list,
 * so a `.cmd` shim such as `hawl.cmd` is started from one string instead. Each argument is quoted
 * when it holds a space or a shell character.
 */
export function winCommandLine(cmd: string, args: string[]): string {
  const q = (a: string) =>
    /[\s"&|<>^%()]/.test(a) || a === "" ? `"${a.replaceAll('"', '\\"')}"` : a;
  return [cmd, ...args].map(q).join(" ");
}
