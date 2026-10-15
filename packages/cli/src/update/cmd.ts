import { colorEnabled, makeStyle, utf8Enabled } from "../style.ts";
import {
  applyPending,
  type CheckDeps,
  checkAndStage,
  readPending,
} from "./apply.ts";
import { planUpdate, verifyUpdateManifest } from "./manifest.ts";

export interface UpdateIo {
  out: (s: string) => void;
  err: (s: string) => void;
  isTTY?: boolean;
  env?: Record<string, string | undefined>;
}

export type UpdateDeps = Omit<CheckDeps, "channel" | "force">;

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

const REFUSED: Record<
  string,
  (v: { current: string }) => { what: string; fix?: string }
> = {
  schema: () => sig(),
  no_key: () => ({
    what: "This version of hawl has no release verification key, so nothing was installed.",
    fix: "update from npm: npm i -g hawl.ai. Your current version keeps working.",
  }),
  bad_sig: () => sig(),
  sha256: () => ({
    what: "The download doesn't match its checksum, so it was thrown away.",
    fix: "run hawl update again.",
  }),
  channel: () => ({
    what: 'That update is for the "next" channel, not "latest".',
    fix: "hawl update --channel next, or stay on latest.",
  }),
  downgrade: ({ current }) => ({
    what: `The newest version on this channel is older than yours (${current}). Nothing to do.`,
  }),
  no_asset: () => ({
    what: "There is no build for this computer in that release yet.",
    fix: "wait for the next release, or use npm: npm i -g hawl.ai.",
  }),
};
function sig() {
  return {
    what: "The update list from hawl.ai didn't pass its signature check, so nothing was installed.",
    fix: "report this at hawl.ai/docs/troubleshooting, or update from npm: npm i -g hawl.ai. Your current version keeps working.",
  };
}

/** `hawl update`: prints a summary (S-420), never JSON. Runs even when update.auto is false. */
export async function runUpdate(
  o: { channel: string; now?: boolean; check?: boolean },
  d: UpdateDeps,
  io: UpdateIo,
): Promise<number> {
  const env = io.env ?? {};
  const st = makeStyle(
    colorEnabled({ env, argv: [], isTTY: !!io.isTTY }),
    utf8Enabled(process.platform, env),
  );
  const refuse = (reason: string): number => {
    const r = (REFUSED[reason] ?? sig)({ current: d.current });
    io.err(`${st.fail} ${r.what}\n${r.fix ? `Fix: ${r.fix}\n` : ""}`);
    return reason === "downgrade" ? 0 : 1;
  };

  if (o.now) {
    const p = readPending(d.stateDir);
    if (!p) {
      io.out(`${st.ok} Nothing is staged. Run hawl update first.\n`);
      return 0;
    }
    const r = applyPending({
      stateDir: d.stateDir,
      binPath: d.binPath,
      current: d.current,
    });
    if (r.status === "applied") {
      io.out(
        `${st.ok} Installed hawl ${r.to}. Your agents reconnect when the helper restarts.\n  What's new: hawl.ai/changelog\n`,
      );
      return 0;
    }
    return refuse(r.status === "refused" ? r.reason : "sha256");
  }

  io.err(`Checking hawl.ai for updates (channel: ${o.channel})...\n`);
  if (o.check) {
    try {
      const v = verifyUpdateManifest(await d.fetchManifest(), d.pubkey);
      if (!v.ok) return refuse(v.reason);
      const plan = planUpdate(v.manifest, { ...d, channel: o.channel });
      if (!plan.ok) {
        return plan.reason === "up_to_date"
          ? (io.out(`${st.ok} You're on the latest version (${d.current}).
`),
            0)
          : refuse(plan.reason);
      }
      io.out(`hawl ${plan.version} is available (you have ${d.current}).
`);
      return 10;
    } catch (e) {
      io.err(`${st.fail} Couldn't reach hawl.ai (${(e as Error).message}).
Fix: check your connection, then run hawl update again.
`);
      return 1;
    }
  }
  let size = 0;
  let r: Awaited<ReturnType<typeof checkAndStage>>;
  try {
    r = await checkAndStage({
      ...d,
      channel: o.channel,
      force: true,
      download: async (u) => {
        const b = await d.download(u);
        size = b.length;
        return b;
      },
    });
  } catch (e) {
    io.err(
      `${st.fail} Couldn't reach hawl.ai (${(e as Error).message}).\nFix: check your connection, then run hawl update again.\n`,
    );
    return 1;
  }
  if (r.status === "refused") return refuse(r.reason);
  if (r.status === "skipped") {
    io.out(`${st.ok} You're on the latest version (${d.current}).\n`);
    return 0;
  }
  if (o.check) {
    io.out(`hawl ${r.version} is available (you have ${d.current}).\n`);
    return 10;
  }
  const sz = size ? ` (${mb(size)})` : "";
  io.out(
    `${st.ok} hawl ${r.version} downloaded${sz}, signature and checksum match.\n  It installs when the helper restarts. To do it now: hawl update --now\n`,
  );
  return 0;
}
