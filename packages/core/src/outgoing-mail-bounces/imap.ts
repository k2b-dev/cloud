import { isIP } from "node:net";
import { type ImapMailProfile, resolveImapMailCredentials } from "@k2b/cloud/services/outgoing-mail/store";
import { ImapFlow } from "imapflow";
import { DSN_PART_BYTES } from "./parser";
import { BOUNCE_BATCH_SIZE, type BounceMailbox } from "./poller";

export const IMAP_RESPONSE_BYTES = 2 * DSN_PART_BYTES;
// Ten UID digits plus a separator; leave room for response framing and completion.
const LEGACY_UID_WINDOW = Math.floor((IMAP_RESPONSE_BYTES - 1024) / 11);

/** Connect lazily, so profiles without IMAP never create a socket or decrypt a password. */
export const createImapBounceMailbox = (profile: ImapMailProfile, signal: AbortSignal): BounceMailbox => {
  let client: ImapFlow | undefined;
  let uidNext = 0;
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
        ...(!profile.imap.secure ? { doSTARTTLS: true } : {}),
        ...(isIP(profile.imap.host) ? { tls: { servername: undefined } } : {}),
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
        maxResponseSize: IMAP_RESPONSE_BYTES,
        maxLineLength: IMAP_RESPONSE_BYTES,
      });
      // Never forward server exceptions to logging: authentication errors can carry secrets.
      client.on("error", close);
      signal.addEventListener("abort", close, { once: true });
      await client.connect();
      const mailbox = await connected().mailboxOpen(folder, options);
      if (!Number.isSafeInteger(mailbox.uidNext) || mailbox.uidNext < 1 || mailbox.uidNext > 0xffffffff)
        throw new Error("IMAP mailbox has no valid UIDNEXT.");
      uidNext = mailbox.uidNext;
      return { uidValidity: mailbox.uidValidity.toString() };
    },
    async listUids(query) {
      const uids: number[] = [];
      let through = query.after ?? 0;
      // At most one window per batch slot (two searches with ESEARCH). The run budget
      // also bounds slow servers. Empty legacy windows still checkpoint scan progress.
      for (let low = through + 1, windows = 0; low < uidNext && uids.length < query.limit && windows < BOUNCE_BATCH_SIZE; windows++) {
        const since = query.since ? { since: query.since } : {};
        const client = connected();
        let first = low;
        let high = Math.min(low + LEGACY_UID_WINDOW - 1, uidNext - 1);
        if (client.capabilities.has("ESEARCH")) {
          const next = await client.search({ uid: `${low}:${uidNext - 1}`, ...since }, { uid: true, returnOptions: ["MIN"] });
          if (!next || Array.isArray(next)) throw new Error("IMAP ESEARCH failed.");
          if (next.min === undefined) {
            through = uidNext - 1;
            break;
          }
          first = next.min;
          if (!Number.isSafeInteger(first) || first < low || first >= uidNext) throw new Error("IMAP search returned an invalid UID.");
          high = Math.min(first + BOUNCE_BATCH_SIZE - 1, uidNext - 1);
        }
        const found = await connected().search({ uid: `${first}:${high}`, ...since }, { uid: true });
        if (!Array.isArray(found) || found.some((uid) => !Number.isSafeInteger(uid) || uid < first || uid > high))
          throw new Error("IMAP search returned invalid UIDs.");
        const sorted = [...new Set(found)].sort((a, b) => a - b);
        const remaining = query.limit - uids.length;
        uids.push(...sorted.slice(0, remaining));
        through = sorted.length > remaining ? uids[uids.length - 1]! : high;
        low = high + 1;
      }
      return { uids, through };
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
