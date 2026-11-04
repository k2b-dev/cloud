import { createHash } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAcpSessionStateDirectory } from "./local-paths";

/** Editor sessions remembered per profile; an older session still resumes through its chat in the session list. */
export const ACP_SESSION_STORE_MAX_ENTRIES = 1_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Which Cloud chat each editor session uses, outside the cld profile so editors cannot grow it. Each mapping is one
 * empty file named `<sessionId>.<chatId>`: creating or removing a file is atomic, so parallel editors never lose each
 * other's entries, and one directory read answers both directions.
 */
export const createAcpSessionStore = (
  profile: { profile: string; server: string },
  root = getAcpSessionStateDirectory(),
  max = ACP_SESSION_STORE_MAX_ENTRIES,
) => {
  const directory = join(root, createHash("sha256").update(`${profile.server}\n${profile.profile}`).digest("hex").slice(0, 32));
  const entries = async (): Promise<Array<{ name: string; session: string; chat: string }>> => {
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    return names.flatMap((name) => {
      const [session, chat, ...rest] = name.split(".");
      return session && chat && !rest.length && ID.test(session) && ID.test(chat) ? [{ name, session, chat }] : [];
    });
  };
  const remove = (name: string) =>
    unlink(join(directory, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  return {
    chat: async (session: string) => (await entries()).find((entry) => entry.session === session)?.chat,
    /** Session IDs by chat ID, read once for a whole list page. */
    sessions: async () => new Map((await entries()).map((entry) => [entry.chat, entry.session])),
    set: async (session: string, chat: string) => {
      if (!ID.test(session) || !ID.test(chat)) return;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, `${session}.${chat}`), "", { mode: 0o600 });
      const all = await entries();
      if (all.length <= max) return;
      const aged = await Promise.all(
        all.map(async (entry) => ({ entry, at: (await stat(join(directory, entry.name)).catch(() => undefined))?.mtimeMs ?? 0 })),
      );
      aged.sort((a, b) => a.at - b.at);
      await Promise.all(aged.slice(0, all.length - max).map(({ entry }) => remove(entry.name)));
    },
    /** Forget a session, or every session of a chat that no longer exists. */
    forget: async (id: string) => {
      for (const entry of await entries()) if (entry.session === id || entry.chat === id) await remove(entry.name);
    },
  };
};
export type AcpSessionStore = ReturnType<typeof createAcpSessionStore>;
