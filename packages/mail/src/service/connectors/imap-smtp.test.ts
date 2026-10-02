import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import type { Socket } from "bun";
import { type FetchMessageObject, ImapFlow, type ListResponse } from "imapflow";
import nodemailer from "nodemailer";
import SMTPConnection from "nodemailer/lib/smtp-connection";
import type { ProviderConnectionInput } from "../../contracts";
import {
  assertProviderKeywordsSupported,
  assertSelectedMailbox,
  assertUidValidity,
  connectSmtpConnection,
  disposeImapClient,
  downloadSelectedSources,
  fetchRemoteMessageState,
  type ImapSession,
  imapSmtpConnector,
  listenOnImapSession,
  mapFetchedEnvelope,
  normalizeImapQuotaEvidence,
  parseEnvelopeHeaders,
  parseReferences,
  renameImapFolder,
  runImapSession,
  selectUidBatch,
  trackImapSession,
  transportDiagnostic,
  withSharedImapSession,
} from "./imap-smtp";

describe("Provider transport diagnostics", () => {
  test("keep the provider's TLS explanation next to the category", () => {
    const reason = Object.assign(new Error("Hostname/IP does not match certificate's altnames: Host: mail.example.org"), {
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
    expect(transportDiagnostic({ status: "rejected", reason })).toEqual({
      status: "failed",
      category: "tls",
      message: "TLS verification failed: Hostname/IP does not match certificate's altnames: Host: mail.example.org",
    });
  });

  test("redact the submitted password from an SMTP login failure", () => {
    const reason = Object.assign(new Error("Invalid login: 535 5.7.8 rejected s3cret-value"), { code: "EAUTH" });
    expect(transportDiagnostic({ status: "rejected", reason }, ["s3cret-value"]).message).toBe(
      "Authentication failed: Invalid login: 535 5.7.8 rejected [redacted]",
    );
  });
});

describe("IMAP client disposal", () => {
  test("does not close a connection ImapFlow already marked unusable", async () => {
    let closed = 0;
    await disposeImapClient({
      usable: false,
      logout: async () => {
        throw new Error("logout must not run");
      },
      close: () => {
        closed += 1;
      },
    });
    expect(closed).toBe(0);
  });

  test("closes a still-usable connection when logout fails", async () => {
    let closed = 0;
    await disposeImapClient({
      usable: true,
      logout: async () => {
        throw new Error("logout failed");
      },
      close: () => {
        closed += 1;
      },
    });
    expect(closed).toBe(1);
  });
});

describe("IMAP connection failures", () => {
  // Answers every command except `stalled`, like a provider that stops responding mid-session.
  const stallingServer = (stalled: string) =>
    Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (socket) => {
          socket.write("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] fixture ready\r\n");
        },
        data: (socket, data) => {
          for (const line of data.toString().split("\r\n").filter(Boolean)) {
            const [tag, command] = line.split(" ");
            if (command?.toUpperCase() !== stalled) socket.write(`${tag} OK done\r\n`);
          }
        },
      },
    });
  const sessionFor = (port: number) =>
    trackImapSession(
      new ImapFlow({
        host: "127.0.0.1",
        port,
        secure: false,
        doSTARTTLS: false,
        auth: { user: "fixture", pass: "fixture" },
        logger: false,
        disableAutoIdle: true,
        socketTimeout: 1_000,
      }),
    );

  test("rejects a command that never gets a reply instead of crashing the process", async () => {
    const server = stallingServer("SELECT");
    const session = sessionFor(server.port);
    try {
      // ImapFlow fails a command whose connection closed with NoConnection; mail commands classify that code as transport ambiguity.
      await expect(runImapSession(session, (client) => client.mailboxOpen("INBOX"))).rejects.toMatchObject({ code: "NoConnection" });
      expect(session.failure()).toMatchObject({ code: "ETIMEOUT" });
      expect(session.client.usable).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("rejects an operation that completed over a connection that failed", async () => {
    const server = stallingServer("NOOP");
    const session = sessionFor(server.port);
    try {
      await expect(runImapSession(session, (client) => client.noop())).rejects.toMatchObject({ code: "ETIMEOUT" });
      expect(session.client.usable).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  describe("during LOGIN", () => {
    // Greets, answers CAPABILITY and ID, and leaves LOGIN unanswered; `onLogin` decides what happens next.
    const loginServer = (onLogin: (socket: Socket<undefined>) => void) =>
      Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          open: (socket) => {
            socket.write("* OK fixture ready\r\n");
          },
          data: (socket, data) => {
            for (const line of data.toString().split("\r\n").filter(Boolean)) {
              const [tag, command] = line.split(" ");
              switch (command?.toUpperCase()) {
                case "CAPABILITY":
                  socket.write(`* CAPABILITY IMAP4rev1 ID\r\n${tag} OK done\r\n`);
                  break;
                case "ID":
                  socket.write(`* ID NIL\r\n${tag} OK done\r\n`);
                  break;
                case "LOGIN":
                  onLogin(socket);
                  break;
                default:
                  socket.write(`${tag} OK done\r\n`);
              }
            }
          },
        },
      });

    // ImapFlow rejects connect() first and then fails the pending LOGIN with an 'error' event. Without a listener
    // that event throws inside ImapFlow and ends Mail as an unhandled rejection; bun test fails the test on one.
    // Waiting for the next macrotask lets the microtasks of the close, including that event, run first.
    const afterClose = () => new Promise<void>((resolve) => setImmediate(resolve));

    test("an aborted operation rejects without crashing the process", async () => {
      const controller = new AbortController();
      // The abort handler closes the client, like a lost sync lease while LOGIN is still unanswered.
      const server = loginServer(() => controller.abort());
      const session = sessionFor(server.port);
      let ran = false;
      try {
        const operation = runImapSession(
          session,
          async () => {
            ran = true;
          },
          controller.signal,
        );
        await expect(operation).rejects.toMatchObject({ code: "ClosedAfterConnectText" });
        await afterClose();
        expect(ran).toBe(false);
        expect(session.failure()).toMatchObject({ code: "NoConnection" });
        expect(session.client.usable).toBe(false);
      } finally {
        server.stop(true);
      }
    });

    test("a change listener rejects without crashing the process", async () => {
      // The provider drops the connection instead of answering LOGIN.
      const server = loginServer((socket) => socket.end());
      const session = sessionFor(server.port);
      try {
        await expect(
          listenOnImapSession(session, { folderPath: "INBOX", uidValidity: "1", highestModseq: null, maxPendingHints: 8 }),
        ).rejects.toMatchObject({ code: "ClosedAfterConnectText" });
        await afterClose();
        expect(session.failure()).toMatchObject({ code: "NoConnection" });
        expect(session.client.usable).toBe(false);
      } finally {
        server.stop(true);
      }
    });
  });

  test("are tracked on every ImapFlow client Mail creates", async () => {
    // The tests above drive trackImapSession directly; this keeps every production client on that path.
    const root = `${import.meta.dir}/../..`;
    const untracked: string[] = [];
    let tracked = 0;
    for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
      if (/\.test\.tsx?$/u.test(file)) continue;
      const source = await Bun.file(`${root}/${file}`).text();
      const created = source.match(/new ImapFlow\(/gu)?.length ?? 0;
      const wrapped = source.match(/trackImapSession\(\s*new ImapFlow\(/gu)?.length ?? 0;
      tracked += wrapped;
      if (created !== wrapped) untracked.push(file);
    }

    expect(tracked).toBeGreaterThan(0);
    expect(untracked).toEqual([]);
  });
});

describe("Shared IMAP sessions", () => {
  const MESSAGE_ID = "<shared-session@example.test>";
  const CAPABILITIES = "IMAP4rev1 MOVE UIDPLUS";

  // INBOX (UIDVALIDITY 10) holds UID 7, Archive (UIDVALIDITY 20) starts empty. Answers what a message
  // action sends: LIST, SELECT and EXAMINE, UID FETCH, UID SEARCH, and UID MOVE with COPYUID.
  // `dropAfter` ends the connection right after that command was answered; `onLogin` runs before LOGIN is answered.
  const mailServer = (options: { dropAfter?: string; onLogin?: () => void } = {}) => {
    const stats = { connections: 0, logins: 0, logouts: 0, commands: [] as string[] };
    const server = Bun.listen<{ selected: "INBOX" | "Archive" | null }>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (socket) => {
          stats.connections += 1;
          socket.data = { selected: null };
          socket.write(`* OK [CAPABILITY ${CAPABILITIES}] fixture ready\r\n`);
        },
        data: (socket, data) => {
          for (const line of data.toString().split("\r\n").filter(Boolean)) {
            const [tag, ...words] = line.split(" ");
            const command = (words[0] === "UID" ? `UID ${words[1]}` : (words[0] ?? "")).toUpperCase();
            const name = (words.at(-1) ?? "").replaceAll('"', "");
            const folder = name === "Archive" ? "Archive" : "INBOX";
            const uids = folders[socket.data.selected ?? "INBOX"];
            stats.commands.push(command);
            if (command === "LOGIN") {
              stats.logins += 1;
              options.onLogin?.();
              socket.write(`${tag} OK [CAPABILITY ${CAPABILITIES}] logged in\r\n`);
            } else if (command === "LIST") {
              // An empty name asks for the hierarchy delimiter only.
              socket.write(`* LIST (${name ? "" : "\\Noselect"}) "/" ${name ? folder : '""'}\r\n${tag} OK done\r\n`);
            } else if (command === "SELECT" || command === "EXAMINE") {
              socket.data.selected = folder;
              const access = command === "SELECT" ? "READ-WRITE" : "READ-ONLY";
              socket.write(
                `* FLAGS (\\Seen)\r\n* ${folders[folder].length} EXISTS\r\n* OK [UIDVALIDITY ${folder === "INBOX" ? 10 : 20}] ok\r\n` +
                  `* OK [UIDNEXT 100] ok\r\n${tag} OK [${access}] done\r\n`,
              );
            } else if (command === "UID FETCH") {
              const uid = Number(words[2]);
              const seq = uids.indexOf(uid) + 1;
              const found =
                seq > 0
                  ? `* ${seq} FETCH (UID ${uid} FLAGS () ENVELOPE (NIL "Shared" NIL NIL NIL NIL NIL NIL NIL "${MESSAGE_ID}"))\r\n`
                  : "";
              socket.write(`${found}${tag} OK done\r\n`);
            } else if (command === "UID SEARCH") {
              socket.write(`* SEARCH ${uids.join(" ")}\r\n${tag} OK done\r\n`);
            } else if (command === "UID MOVE") {
              const uid = Number(words[2]);
              const seq = uids.indexOf(uid) + 1;
              uids.splice(seq - 1, 1);
              folders.Archive.push(3);
              socket.write(`* OK [COPYUID 20 ${uid} 3] moved\r\n* ${seq} EXPUNGE\r\n${tag} OK done\r\n`);
            } else if (command === "LOGOUT") {
              stats.logouts += 1;
              socket.write(`* BYE\r\n${tag} OK done\r\n`);
              socket.end();
            } else {
              socket.write(`${tag} OK done\r\n`);
            }
            if (command === options.dropAfter) socket.end();
          }
        },
      },
    });
    const folders = { INBOX: [7], Archive: [] as number[] };
    return { server, stats };
  };

  const config: ProviderConnectionInput = {
    name: "Shared session fixture",
    email: "shared@example.test",
    username: "shared@example.test",
    imap: { host: "imap.example.test", port: 993, tlsMode: "implicit" },
    smtp: { host: "smtp.example.test", port: 587, tlsMode: "starttls" },
    secret: { kind: "password", password: "fixture" },
  };
  const sessionFor =
    (port: number, socketTimeout = 1_000, created: ImapSession[] = []) =>
    async () => {
      const session = trackImapSession(
        new ImapFlow({
          host: "127.0.0.1",
          port,
          secure: false,
          doSTARTTLS: false,
          auth: { user: "fixture", pass: "fixture" },
          logger: false,
          disableAutoIdle: true,
          socketTimeout,
        }),
      );
      created.push(session);
      return session;
    };
  const inboxMessage = { folderPath: "INBOX", uidValidity: "10", uid: 7 };

  test("run the steps of a move over one connection and close it afterwards", async () => {
    const { server, stats } = mailServer();
    try {
      const steps = await withSharedImapSession(config, sessionFor(server.port), async (session) => {
        const identity = await imapSmtpConnector.getMessageState(session, inboxMessage);
        const baseline = await imapSmtpConnector.findMessageById(session, "Archive", MESSAGE_ID);
        await imapSmtpConnector.getMessageState(session, inboxMessage);
        const moved = await imapSmtpConnector.move(session, inboxMessage, "Archive");
        const source = await imapSmtpConnector.getMessageState(session, inboxMessage);
        return { identity: identity.messageId, baseline, moved, sourceExists: source.exists };
      });
      expect(steps).toEqual({
        identity: MESSAGE_ID,
        baseline: [],
        moved: { destinationUidValidity: "20", destinationUid: 3 },
        sourceExists: false,
      });
      expect({ connections: stats.connections, logins: stats.logins, logouts: stats.logouts }).toEqual({
        connections: 1,
        logins: 1,
        logouts: 1,
      });
    } finally {
      server.stop(true);
    }
  });

  test("open a new connection for a step after the provider closed the connection", async () => {
    const { server, stats } = mailServer({ dropAfter: "UID MOVE" });
    const created: ImapSession[] = [];
    try {
      const sourceExists = await withSharedImapSession(config, sessionFor(server.port, 1_000, created), async (session) => {
        await imapSmtpConnector.getMessageState(session, inboxMessage);
        await imapSmtpConnector.move(session, inboxMessage, "Archive");
        // The runtime checks its lease between the steps; by then the close has arrived.
        const client = created[0]!.client;
        if (client.usable) await new Promise((resolve) => client.once("close", resolve));
        // The source check runs as it would on its own connection and proves the move in the same run.
        return (await imapSmtpConnector.getMessageState(session, inboxMessage)).exists;
      });
      expect(sourceExists).toBe(false);
      expect({ connections: stats.connections, logins: stats.logins }).toEqual({ connections: 2, logins: 2 });
      expect(stats.commands.filter((command) => command === "UID MOVE")).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  test("open a new connection when the idle connection timed out between two steps", async () => {
    const { server, stats } = mailServer();
    const created: ImapSession[] = [];
    try {
      const sourceExists = await withSharedImapSession(config, sessionFor(server.port, 200, created), async (session) => {
        await imapSmtpConnector.getMessageState(session, inboxMessage);
        // The caller works elsewhere, such as on database row locks, until the socket timeout ends the connection.
        const client = created[0]!.client;
        await new Promise((resolve) => client.once("error", resolve));
        return (await imapSmtpConnector.getMessageState(session, inboxMessage)).exists;
      });
      expect(sourceExists).toBe(true);
      expect(created[0]!.failure()).toMatchObject({ code: "ETIMEOUT" });
      expect(stats.connections).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("run no operation whose signal aborted while the shared connection was connecting", async () => {
    const controller = new AbortController();
    const { server, stats } = mailServer({ onLogin: () => controller.abort() });
    try {
      const run = withSharedImapSession(config, sessionFor(server.port), (session) =>
        imapSmtpConnector.findMessageById(session, "Archive", MESSAGE_ID, controller.signal),
      );
      await expect(run).rejects.toMatchObject({ code: "ClosedAfterConnectText" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stats.commands).not.toContain("EXAMINE");
      expect(stats.commands).not.toContain("UID SEARCH");
    } finally {
      server.stop(true);
    }
  });

  test("open no connection when no step reaches the provider", async () => {
    let created = 0;
    const result = await withSharedImapSession(
      config,
      async () => {
        created += 1;
        throw new Error("no connection may open");
      },
      async () => "decided without the provider",
    );
    expect(result).toBe("decided without the provider");
    expect(created).toBe(0);
  });

  test("leave a caller's own configuration on separate connections", async () => {
    const { server, stats } = mailServer();
    // A loopback provider address passes the shared fixture session but not the endpoint policy of a connection of its own.
    const own: ProviderConnectionInput = { ...config, imap: { host: "127.0.0.1", port: server.port, tlsMode: "implicit" } };
    try {
      await withSharedImapSession(own, sessionFor(server.port), async (session) => {
        expect(session).not.toBe(own);
        expect(session).toEqual(own);
        await imapSmtpConnector.getMessageState(session, inboxMessage);
        await expect(imapSmtpConnector.getMessageState(own, inboxMessage)).rejects.toThrow("non-public address");
      });
      expect(stats.connections).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});

describe("SMTP message transfer", () => {
  // Mail treats a send that failed with its message still unread as not transmitted at all.
  const sendRaw = async (port: number) => {
    const source = Readable.from([Buffer.from("Subject: Fixture\r\n\r\nBody\r\n")]);
    const transport = nodemailer.createTransport({
      host: "127.0.0.1",
      port,
      secure: false,
      ignoreTLS: true,
      connectionTimeout: 2_000,
      greetingTimeout: 2_000,
      socketTimeout: 2_000,
    });
    try {
      const error = await transport.sendMail({ raw: source, envelope: { from: "owner@example.test", to: ["customer@example.test"] } }).then(
        () => null,
        (failure: unknown) => failure,
      );
      return { error, unread: source.readableFlowing === null && !source.readableDidRead };
    } finally {
      transport.close();
    }
  };

  test("leaves the message unread when the server cannot be reached", async () => {
    const closed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => undefined } });
    const port = closed.port;
    closed.stop(true);
    const { error, unread } = await sendRaw(port);
    expect(error).toMatchObject({ command: "CONN" });
    expect(unread).toBe(true);
  });

  test("reads the message once the server takes it, even when the connection drops afterwards", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (socket) => {
          socket.write("220 fixture ESMTP\r\n");
        },
        data: (socket, data) => {
          const text = data.toString();
          if (/^(EHLO|HELO)/iu.test(text)) socket.write("250 fixture\r\n");
          else if (/^(MAIL|RCPT)/iu.test(text)) socket.write("250 OK\r\n");
          else if (/^DATA/iu.test(text)) socket.write("354 Go ahead\r\n");
          // The message arrived; the connection drops before the server confirms it.
          else socket.end();
        },
      },
    });
    try {
      const { error, unread } = await sendRaw(server.port);
      expect(error).toMatchObject({ command: "CONN" });
      expect(unread).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});

describe("IMAP provider keywords", () => {
  test("accepts arbitrary keywords when the provider advertises wildcard support", () => {
    expect(() => assertProviderKeywordsSupported(new Set(["\\Seen", "\\*"]), ["Cloud/Follow-up"])).not.toThrow();
  });

  test("accepts an explicitly advertised keyword", () => {
    expect(() => assertProviderKeywordsSupported(new Set(["\\Seen", "Approved"]), ["approved"])).not.toThrow();
  });

  test("fails clearly when a folder rejects custom keywords", () => {
    expect(() => assertProviderKeywordsSupported(new Set(["\\Seen", "\\Answered"]), ["Cloud/Follow-up"])).toThrow(
      "The provider does not allow custom keywords in this folder",
    );
  });
});

const sparseSearch = (uids: number[], probes: Array<[number, number]>) => async (lowUid: number, highUid: number) => {
  probes.push([lowUid, highUid]);
  return uids.filter((uid) => uid >= lowUid && uid <= highUid);
};

const listedFolder = (path: string, subscribed: boolean): ListResponse => ({
  path,
  pathAsListed: path,
  name: path,
  delimiter: "/",
  flags: new Set(),
  listed: true,
  subscribed,
  parent: [],
  parentPath: "",
});

describe("IMAP envelope UID batching", () => {
  test("finds existing messages without scanning every sparse UID window", async () => {
    const probes: Array<[number, number]> = [];
    const first = await selectUidBatch({
      lowUid: 1,
      highUid: 10_000_000,
      limit: 2,
      search: sparseSearch([3, 100, 9_999_999], probes),
    });
    expect(first).toEqual({ uids: [100, 9_999_999], nextHighUid: 99 });
    expect(probes.length).toBeLessThanOrEqual(12);

    const second = await selectUidBatch({
      lowUid: 1,
      highUid: first.nextHighUid!,
      limit: 2,
      search: sparseSearch([3, 100, 9_999_999], []),
    });
    expect(second).toEqual({ uids: [3], nextHighUid: null });
  });

  test("returns the newest dense batch and a stable continuation", async () => {
    const all = Array.from({ length: 1_000 }, (_, index) => index + 1);
    const result = await selectUidBatch({
      lowUid: 1,
      highUid: 1_000,
      limit: 200,
      search: sparseSearch(all, []),
    });
    expect(result.uids).toEqual(Array.from({ length: 200 }, (_, index) => index + 801));
    expect(result.nextHighUid).toBe(800);
  });
});

describe("IMAP source downloads", () => {
  const requests = [1, 2, 3].map((uid) => ({ key: `message-${uid}`, uidValidity: "10", uid }));
  const source = (uid: number) => ({ meta: { expectedSize: 1, contentType: "message/rfc822" }, content: Readable.from([String(uid)]) });

  test("skip a UID the provider no longer has and keep streaming the rest of the batch", async () => {
    const consumed: string[] = [];
    await downloadSelectedSources(
      {
        usable: true,
        mailbox: { uidValidity: 10n } as never,
        // FETCH for an expunged UID returns no message; imapflow then resolves an empty object.
        download: async (uid) => (uid === 2 ? {} : source(uid)),
      },
      requests,
      async (download) => {
        consumed.push(download.key);
      },
    );
    expect(consumed).toEqual(["message-1", "message-3"]);
  });

  test("fail the batch instead of skipping the rest when the connection closed between downloads", async () => {
    const client = { usable: true, mailbox: { uidValidity: 10n } as never, download: async (uid: number) => source(uid) };
    const consumed: string[] = [];
    const batch = downloadSelectedSources(client, requests, async (download) => {
      consumed.push(download.key);
      // The server drops the connection after the first message; imapflow then answers every download with {}.
      Object.assign(client, { usable: false, mailbox: false, download: async () => ({}) });
    });
    await expect(batch).rejects.toMatchObject({ code: "IMAP_CONNECTION_LOST" });
    expect(consumed).toEqual(["message-1"]);
  });

  test("report no expected size when the FETCH response carried none", async () => {
    const sizes: Array<number | null> = [];
    await downloadSelectedSources(
      {
        usable: true,
        mailbox: { uidValidity: 10n } as never,
        download: async (uid) => ({ meta: { contentType: "message/rfc822" }, content: Readable.from([String(uid)]) }),
      },
      requests.slice(0, 1),
      async (download) => {
        sizes.push(download.expectedSize);
      },
    );
    expect(sizes).toEqual([null]);
  });
});

describe("IMAP message state", () => {
  // Like imapflow against a server with X-GM-EXT-1: labels come back only when the query asks for them.
  const gmailMessage = (query: { labels?: boolean }): FetchMessageObject => ({
    seq: 1,
    uid: 7,
    flags: new Set(["\\Seen", "$Forwarded"]),
    ...(query.labels ? { labels: new Set(["\\Important", "Projects"]) } : {}),
    envelope: { date: new Date("2026-07-13T12:00:00.000Z"), messageId: "<state@example.test>" },
  });

  test("reports Gmail labels among the keywords exactly as sync stores them", async () => {
    const state = await fetchRemoteMessageState({ fetchOne: async (_uid, query) => gmailMessage(query) }, 7);
    const synced = await mapFetchedEnvelope(gmailMessage({ labels: true }), {
      folderPath: "INBOX",
      folderStableKey: "inbox",
      uidValidity: "10",
      highUid: 7,
      limit: 1,
    });
    // An automation freezes the stored keywords as its precondition; a state read without the
    // labels would make every action on a labeled Gmail message fail as changed.
    expect(state).toMatchObject({ exists: true, flags: ["\\Seen"], messageId: "<state@example.test>" });
    expect(state.keywords).toEqual(synced.labels);
    expect(state.keywords).toEqual(["$Forwarded", "Projects", "\\Important"]);
  });

  test("reports a message the folder no longer has as missing", async () => {
    expect(await fetchRemoteMessageState({ fetchOne: async () => false }, 7)).toEqual({
      exists: false,
      flags: [],
      keywords: [],
      messageId: null,
      modseq: null,
    });
  });
});

describe("IMAP envelope mapping", () => {
  const request = { folderPath: "INBOX", folderStableKey: "inbox", uidValidity: "10", highUid: 1, limit: 1 };

  test("keep a Date header imapflow could not parse out of the sent time", async () => {
    const mapped = await mapFetchedEnvelope(
      { seq: 1, uid: 1, envelope: { date: "not a real date", subject: "Hello" } } satisfies FetchMessageObject,
      request,
    );
    expect(mapped.sentAt).toBeNull();
    expect(mapped.internalDate).toEqual(new Date(0));
  });

  test("use a parsed Date header as the sent time and internal date fallback", async () => {
    const date = new Date("2026-07-13T12:00:00.000Z");
    const mapped = await mapFetchedEnvelope({ seq: 1, uid: 1, envelope: { date } } satisfies FetchMessageObject, request);
    expect(mapped.sentAt).toEqual(date);
    expect(mapped.internalDate).toEqual(date);
  });

  test("fall back to the sent time when imapflow could not parse the INTERNALDATE", async () => {
    const date = new Date("2026-07-13T12:00:00.000Z");
    const mapped = await mapFetchedEnvelope(
      { seq: 1, uid: 1, internalDate: "not a real date", envelope: { date } } satisfies FetchMessageObject,
      request,
    );
    expect(mapped.internalDate).toEqual(date);
  });

  test("use a parsed INTERNALDATE as the internal date", async () => {
    const internalDate = new Date("2026-07-14T08:30:00.000Z");
    const mapped = await mapFetchedEnvelope(
      { seq: 1, uid: 1, internalDate, envelope: { date: new Date("2026-07-13T12:00:00.000Z") } } satisfies FetchMessageObject,
      request,
    );
    expect(mapped.internalDate).toEqual(internalDate);
  });

  test("drop NUL characters that decoded header words would put into stored text", async () => {
    const mapped = await mapFetchedEnvelope(
      {
        seq: 1,
        uid: 1,
        envelope: {
          subject: "Hel\u0000lo",
          from: [{ name: "Sen\u0000der", address: "sender@example.test" }],
          to: [{ name: "\u0000", address: "recipient@example.test" }],
        },
        bodyStructure: {
          type: "application/pdf",
          parameters: { name: "re\u0000port.pdf" },
          dispositionParameters: { "file\u0000name": "report.pdf" },
        },
      } satisfies FetchMessageObject,
      request,
    );
    expect(mapped.subject).toBe("Hello");
    expect(mapped.addresses.from).toEqual([{ name: "Sender", address: "sender@example.test" }]);
    expect(mapped.addresses.to).toEqual([{ name: null, address: "recipient@example.test" }]);
    expect(mapped.mimeStructure).toMatchObject({ parameters: { name: "report.pdf" }, dispositionParameters: { filename: "report.pdf" } });
  });

  test("drop NUL characters from Message-IDs, References, and raw protocol headers", async () => {
    const mapped = await mapFetchedEnvelope(
      {
        seq: 1,
        uid: 1,
        envelope: { messageId: "<id\u0000@example.test>", inReplyTo: "<\u0000parent@example.test>" },
        // `PGIAY0BleGFtcGxlLnRlc3Q+` decodes to `<b\0c@example.test>`.
        headers: Buffer.from(
          "References: <a@example.test> =?UTF-8?B?PGIAY0BleGFtcGxlLnRlc3Q+?=\r\nList-ID: Li\u0000st <list.example.test>\r\n\r\n",
        ),
      } satisfies FetchMessageObject,
      request,
    );
    expect(mapped.messageId).toBe("<id@example.test>");
    expect(mapped.inReplyTo).toBe("<parent@example.test>");
    expect(mapped.references).toEqual(["<a@example.test>", "<bc@example.test>"]);
    expect(mapped.protocolFacts?.list.id).toBe("List <list.example.test>");
  });
});

describe("IMAP References parsing", () => {
  test("completes for an empty header block", async () => {
    expect(await parseReferences(Buffer.from("\r\n"))).toEqual([]);
  });

  test("returns every referenced Message-ID", async () => {
    expect(await parseReferences(Buffer.from("References: <first@example.com> <second@example.com>\r\n\r\n"))).toEqual([
      "<first@example.com>",
      "<second@example.com>",
    ]);
  });

  test("freezes protocol facts used by automatic reply guards", async () => {
    const parsed = await parseEnvelopeHeaders(
      Buffer.from(
        [
          "References: <first@example.com>",
          "Return-Path: <sender@example.com>",
          "Auto-Submitted: no",
          "Precedence: bulk",
          "List-ID: Example list <list.example.com>",
          "List-Unsubscribe: <mailto:leave@example.com>, <https://example.com/unsubscribe>",
          "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
          "X-Auto-Response-Suppress: OOF, AutoReply",
          "Importance: high",
          "Disposition-Notification-To: sender@example.com",
          "X-Spam-Flag: NO",
          "Content-Type: multipart/report; report-type=delivery-status",
          "",
          "",
        ].join("\r\n"),
      ),
    );
    expect(parsed.references).toEqual(["<first@example.com>"]);
    expect(parsed.protocolFacts).toMatchObject({
      version: 1,
      returnPath: "<sender@example.com>",
      autoSubmitted: "no",
      precedence: "bulk",
      autoResponseSuppress: "OOF, AutoReply",
      contentType: "multipart/report; report-type=delivery-status",
      deliveryStatus: true,
      list: {
        id: "Example list <list.example.com>",
        unsubscribe: ["mailto:leave@example.com", "https://example.com/unsubscribe"],
        unsubscribePost: "List-Unsubscribe=One-Click",
      },
      priority: { importance: "high" },
      receipts: { dispositionNotificationTo: "sender@example.com" },
      spam: { flag: "NO" },
    });
  });
});

describe("IMAP quota normalization", () => {
  test("accepts the documented ImapFlow response shape", () => {
    expect(
      normalizeImapQuotaEvidence({
        storage: { used: 1_024, limit: 4_096 },
        messages: { used: 2, limit: 10 },
      }),
    ).toEqual({
      status: "supported",
      storage: { used: 1_024, limit: 4_096 },
      messages: { used: 2, limit: 10 },
    });
  });

  test("accepts the current runtime response shape and zero limits", () => {
    expect(
      normalizeImapQuotaEvidence({
        path: "INBOX",
        storage: { usage: 0, limit: 0 },
        message: { usage: 3, limit: 20 },
      }),
    ).toEqual({
      status: "supported",
      storage: { used: 0, limit: 0 },
      messages: { used: 3, limit: 20 },
    });
  });

  test("rejects malformed provider evidence", () => {
    expect(
      normalizeImapQuotaEvidence({
        storage: { limit: 4_096 },
      }),
    ).toBeNull();
  });
});

describe("IMAP folder rename", () => {
  test("restores a subscription that the provider drops during rename", async () => {
    const calls: string[] = [];
    await renameImapFolder(
      {
        list: async () => [listedFolder("Cloud Source", true)],
        mailboxRename: async (path, newPath) => {
          calls.push(`rename:${String(path)}:${String(newPath)}`);
          return { path: String(newPath), newPath: String(newPath) };
        },
        mailboxSubscribe: async (path) => {
          calls.push(`subscribe:${String(path)}`);
          return true;
        },
      },
      "Cloud Source",
      "Cloud Renamed",
    );

    expect(calls).toEqual(["rename:Cloud Source:Cloud Renamed", "subscribe:Cloud Renamed"]);
  });

  test("does not add a subscription to an unsubscribed folder", async () => {
    let subscribed = false;
    await renameImapFolder(
      {
        list: async () => [listedFolder("Cloud Source", false)],
        mailboxRename: async () => ({ path: "Cloud Renamed", newPath: "Cloud Renamed" }),
        mailboxSubscribe: async () => {
          subscribed = true;
          return true;
        },
      },
      "Cloud Source",
      "Cloud Renamed",
    );

    expect(subscribed).toBe(false);
  });

  test("reports a partial failure when the rename succeeded but resubscribe did not", async () => {
    await expect(
      renameImapFolder(
        {
          list: async () => [listedFolder("Cloud Source", true)],
          mailboxRename: async () => ({ path: "Cloud Renamed", newPath: "Cloud Renamed" }),
          mailboxSubscribe: async () => false,
        },
        "Cloud Source",
        "Cloud Renamed",
      ),
    ).rejects.toMatchObject({ code: "REMOTE_RENAME_SUBSCRIBE_PARTIAL" });
  });
});

describe("IMAP UIDVALIDITY fencing", () => {
  test("rejects stale or unavailable selected mailbox identities", () => {
    expect(() => assertUidValidity("42", "42")).not.toThrow();
    expect(() => assertUidValidity("43", "42")).toThrow(expect.objectContaining({ code: "UIDVALIDITY_CHANGED" }));
    expect(() => assertUidValidity(null, "42")).toThrow(expect.objectContaining({ code: "UIDVALIDITY_CHANGED" }));
  });

  test("treats a dropped connection as a transport failure instead of an empty result", () => {
    const selected = { uidValidity: 42n } as never;
    expect(() => assertSelectedMailbox({ usable: true, mailbox: selected }, "42")).not.toThrow();
    expect(() => assertSelectedMailbox({ usable: true, mailbox: false }, "42")).toThrow(
      expect.objectContaining({ code: "IMAP_CONNECTION_LOST" }),
    );
    expect(() => assertSelectedMailbox({ usable: false, mailbox: selected }, "42")).toThrow(
      expect.objectContaining({ code: "IMAP_CONNECTION_LOST" }),
    );
    expect(() => assertSelectedMailbox({ usable: true, mailbox: { uidValidity: 43n } as never }, "42")).toThrow(
      expect.objectContaining({ code: "UIDVALIDITY_CHANGED" }),
    );
  });
});

describe("SMTP capability connection", () => {
  const listen = (handlers: { open(socket: Socket): void; data?(socket: Socket, data: Buffer): void }) =>
    Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: handlers.open, data: handlers.data ?? (() => undefined) } });
  const connectionTo = (port: number) =>
    new SMTPConnection({
      host: "127.0.0.1",
      port,
      secure: false,
      ignoreTLS: true,
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 5_000,
    });

  test("connects after the server's greeting and EHLO response", async () => {
    const server = listen({
      open: (socket) => {
        socket.write("220 fixture ESMTP\r\n");
      },
      data: (socket, data) => {
        if (data.toString().startsWith("EHLO")) socket.write("250-fixture\r\n250 SIZE 1000\r\n");
      },
    });
    const connection = connectionTo(server.port);
    try {
      await expect(connectSmtpConnection(connection)).resolves.toBeUndefined();
    } finally {
      connection.close();
      server.stop(true);
    }
  });

  test("fails instead of waiting forever when the server closes before its greeting", async () => {
    const server = listen({
      open: (socket) => {
        socket.end();
      },
    });
    const connection = connectionTo(server.port);
    try {
      await expect(connectSmtpConnection(connection)).rejects.toMatchObject({ code: "ECONNECTION" });
    } finally {
      connection.close();
      server.stop(true);
    }
  });

  test("settles with the abort reason while the server withholds its greeting", async () => {
    const opened = Promise.withResolvers<void>();
    const server = listen({
      open: () => {
        opened.resolve();
      },
    });
    const connection = connectionTo(server.port);
    const controller = new AbortController();
    const reason = new Error("rediscovery deadline passed");
    try {
      const connecting = connectSmtpConnection(connection, controller.signal);
      await opened.promise;
      controller.abort(reason);
      await expect(connecting).rejects.toBe(reason);
    } finally {
      connection.close();
      server.stop(true);
    }
  });
});
