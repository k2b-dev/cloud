import { type ImapMailProfile, resolveImapMailCredentials } from "@k2b/cloud/services/outgoing-mail/store";
import { ImapFlow } from "imapflow";
import { DSN_PART_BYTES } from "./parser";
import { BOUNCE_BATCH_SIZE, type BounceMailbox } from "./poller";

/** Connect lazily, so profiles without IMAP never create a socket or decrypt a password. */
export const createImapBounceMailbox = (profile: ImapMailProfile, signal: AbortSignal): BounceMailbox => {
  let client: ImapFlow | undefined;
  let uidNext = 1;
  let disposed = false;
  const close = () => {
    if (client && !disposed) {
      disposed = true;
      client.close();
    }
  };
  const connected = () => {
    signal.throwIfAborted();
    if (!client?.usable) throw new Error("IMAP connection is unavailable.");
    return client;
  };
  return {
    async open(folder, options) {
      signal.throwIfAborted();
      const password = await resolveImapMailCredentials(profile);
      signal.throwIfAborted();
      client = new ImapFlow({
        host: profile.imap.host,
        port: profile.imap.port,
        secure: profile.imap.secure,
        auth: { user: profile.imap.user, pass: password ?? undefined },
        logger: false,
        logRaw: false,
        emitLogs: false,
        disableAutoIdle: true,
        disableBinary: true,
        connectionTimeout: 30_000,
        greetingTimeout: 30_000,
        socketTimeout: 30_000,
        maxLiteralSize: DSN_PART_BYTES + 1,
        maxResponseSize: 2 * DSN_PART_BYTES,
        maxLineLength: 2 * DSN_PART_BYTES,
      });
      // Never forward server exceptions to logging: authentication errors can carry secrets.
      client.on("error", close);
      signal.addEventListener("abort", close, { once: true });
      await client.connect();
      const mailbox = await connected().mailboxOpen(folder, options);
      uidNext = mailbox.uidNext;
      return { uidValidity: mailbox.uidValidity.toString() };
    },
    async listUids(query) {
      const result: number[] = [];
      // MIN jumps past old mail and UID gaps without expanding a whole mailbox's IDs.
      // ImapFlow's typed SEARCH result is either ESEARCH metadata or a legacy UID array;
      // the connection's response byte limit bounds legacy responses as well.
      for (let low = (query.after ?? 0) + 1; low < uidNext && result.length < query.limit; ) {
        const since = query.since ? { since: query.since } : {};
        const next = await connected().search({ uid: `${low}:${uidNext - 1}`, ...since }, { uid: true, returnOptions: ["MIN"] });
        if (!next) throw new Error("IMAP search failed.");
        const first = Array.isArray(next) ? (next.length ? next.reduce((min, uid) => Math.min(min, uid), Infinity) : undefined) : next.min;
        if (first === undefined) break;
        if (!Number.isSafeInteger(first) || first < low || first >= uidNext) throw new Error("IMAP search returned an invalid UID.");
        const high = Math.min(first + BOUNCE_BATCH_SIZE - 1, uidNext - 1);
        const found = await connected().search({ uid: `${first}:${high}`, ...since }, { uid: true });
        if (!Array.isArray(found)) throw new Error("IMAP search failed.");
        result.push(
          ...found
            .filter((uid) => uid >= first && uid <= high)
            .sort((a, b) => a - b)
            .slice(0, query.limit - result.length),
        );
        low = high + 1;
      }
      return result;
    },
    async bodyStructure(uid) {
      const message = await connected().fetchOne(uid, { bodyStructure: true }, { uid: true });
      connected();
      return message ? (message.bodyStructure ?? null) : null;
    },
    async fetchPart(uid, part, maxBytes) {
      // ImapFlow emits BODY.PEEK[part]<0.maxLength>; +1 detects a truncated part.
      const message = await connected().fetchOne(uid, { bodyParts: [{ key: part, start: 0, maxLength: maxBytes + 1 }] }, { uid: true });
      connected();
      const content = message ? message.bodyParts?.get(part.toLowerCase()) : undefined;
      return content && content.byteLength <= maxBytes ? content : null;
    },
    close() {
      signal.removeEventListener("abort", close);
      close();
    },
  };
};
