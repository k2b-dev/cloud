import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAcpSessionStateDirectory } from "./local-paths";

/** Editor sessions remembered per profile; an older session still resumes through its chat in the session list. */
export const ACP_SESSION_STORE_MAX_ENTRIES = 1_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Which Cloud chat each editor session uses, and in which folder, outside the cld profile so editors cannot grow it.
 * Each mapping is one file named `<sessionId>.<chatId>` that holds the folder: writing it through a rename and removing
 * it are atomic, so parallel editors never lose each other's entries, and one directory read answers both directions.
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
    /** Every session known for each given chat, newest first, with its folder; an entry from before folders has none. */
    lookup: async (chats: readonly string[]) => {
      const wanted = new Set(chats);
      const found = new Map<string, Array<{ session: string; cwd?: string; at: number }>>();
      for (const entry of await entries()) {
        if (!wanted.has(entry.chat)) continue;
        const path = join(directory, entry.name);
        const [cwd, info] = await Promise.all([readFile(path, "utf8").catch(() => ""), stat(path).catch(() => undefined)]);
        const list = found.get(entry.chat) ?? [];
        list.push({ session: entry.session, ...(cwd ? { cwd } : {}), at: info?.mtimeMs ?? 0 });
        found.set(entry.chat, list);
      }
      for (const list of found.values()) list.sort((a, b) => b.at - a.at);
      return found;
    },
    set: async (session: string, chat: string, cwd = "") => {
      if (!ID.test(session) || !ID.test(chat)) return;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const name = `${session}.${chat}`;
      const temporary = join(directory, `.${name}.${process.pid}.${crypto.randomUUID()}`);
      await writeFile(temporary, cwd, { mode: 0o600 });
      await rename(temporary, join(directory, name));
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
