import { describe, expect, spyOn, test } from "bun:test";
import { err, fail, ok } from "@k2b/stdlib";
import { CursorMismatchError } from "@k2b/sync";
import { getProcessSync } from "@k2b/cloud";
import { UserSchema } from "@k2b/cloud/contracts";
import { MAIL_LIVE_WS_TYPE, type MailInvalidation, type MailLiveServerMessage, parseMailLiveServerMessage } from "./live-events";
import type { MailRequestContext } from "./service/auth";
import {
  createMailLiveConnection,
  evaluateMailLiveAccess,
  MAIL_LIVE_MAX_REPLAY_EVENTS,
  type MailLiveAccessDependencies,
  type MailLiveConnectionDependencies,
  type MailLiveSocket,
  parseMailLiveReplayEvent,
  resolveMailLiveCursor,
} from "./ws";

const MAILBOX_ID = "Box001";

const contextFor = (displayName: string): MailRequestContext => {
  const user = UserSchema.parse({
    id: crypto.randomUUID(),
    uid: displayName.toLowerCase(),
    roles: ["user"],
    provider: "local",
    profile: "user",
    givenname: displayName,
    sn: "Test",
    displayName,
    mail: `${displayName.toLowerCase()}@example.com`,
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  });
  return {
    actor: { kind: "user", user },
    accessSubject: { type: "user", userId: user.id },
    requestId: `mail-live-${user.uid}`,
  };
};

describe("Mail live access", () => {
  test("fails closed without a current session-backed context", async () => {
    let permissionChecks = 0;
    const dependencies: MailLiveAccessDependencies = {
      resolveContext: async () => null,
      requireRead: async () => {
        permissionChecks++;
        return ok("read");
      },
    };

    expect(await evaluateMailLiveAccess({ sessionToken: null, requestId: "request-1", mailboxId: MAILBOX_ID }, dependencies)).toEqual({
      ok: false,
      code: "login_required",
      message: "Login required",
    });
    expect(permissionChecks).toBe(0);
  });

  test("resolves a fresh canonical context for every permission check", async () => {
    const contexts = [contextFor("Alice"), contextFor("Bob")];
    const checkedActors: string[] = [];
    const dependencies: MailLiveAccessDependencies = {
      resolveContext: async () => contexts.shift() ?? null,
      requireRead: async (context) => {
        if (context.actor.kind === "user") checkedActors.push(context.actor.user.displayName);
        return ok("read");
      },
    };

    expect(await evaluateMailLiveAccess({ sessionToken: "session", requestId: "request-1", mailboxId: MAILBOX_ID }, dependencies)).toEqual({
      ok: true,
    });
    expect(await evaluateMailLiveAccess({ sessionToken: "session", requestId: "request-1", mailboxId: MAILBOX_ID }, dependencies)).toEqual({
      ok: true,
    });
    expect(checkedActors).toEqual(["Alice", "Bob"]);
  });

  test("maps Mail permission failures to typed revocations", async () => {
    const context = contextFor("Alice");
    const accessDenied = await evaluateMailLiveAccess(
      { sessionToken: "session", requestId: null, mailboxId: MAILBOX_ID },
      {
        resolveContext: async () => context,
        requireRead: async () => fail(err.forbidden("Access denied")),
      },
    );
    const missing = await evaluateMailLiveAccess(
      { sessionToken: "session", requestId: null, mailboxId: MAILBOX_ID },
      {
        resolveContext: async () => context,
        requireRead: async () => fail(err.notFound("Mailbox")),
      },
    );

    expect(accessDenied).toEqual({ ok: false, code: "access_denied", message: "Access denied" });
    expect(missing).toEqual({ ok: false, code: "not_found", message: "Mailbox not found" });
  });
});

describe("Mail live cursors", () => {
  test("preserves explicit replay cursors without reading the stream tail", async () => {
    let latestReads = 0;
    expect(
      await resolveMailLiveCursor("s6t.mailtest.82", async () => {
        latestReads++;
        return "s6t.mailtest.91";
      }),
    ).toBe("s6t.mailtest.82");
    expect(latestReads).toBe(0);
  });

  test("uses the current stream tail and the empty-stream baseline", async () => {
    expect(await resolveMailLiveCursor(null, async () => "s6t.mailtest.91")).toBe("s6t.mailtest.91");
    expect(await resolveMailLiveCursor(null, async () => "s6t.mailtest.0")).toBe("s6t.mailtest.0");
  });

  test("rejects malformed cursors returned by the replay log", async () => {
    await expect(resolveMailLiveCursor(null, async () => "")).rejects.toThrow();
  });

  test("validates replay cursors, payloads, and mailbox isolation", () => {
    const event = {
      cursor: "s6t.mailtest.102",
      data: {
        type: "mail.invalidated",
        mailboxId: MAILBOX_ID,
        conversationId: "Conv01",
        changeId: crypto.randomUUID(),
        at: "2026-07-16T20:00:00.000Z",
      },
    } satisfies { cursor: string; data: MailInvalidation };

    expect(parseMailLiveReplayEvent(MAILBOX_ID, event)).toEqual({ kind: "event", cursor: event.cursor, event: event.data });
    expect(parseMailLiveReplayEvent("Box002", event)).toEqual({ kind: "foreign" });
    expect(parseMailLiveReplayEvent(MAILBOX_ID, { ...event, cursor: "" })).toEqual({ kind: "invalid" });
    expect(parseMailLiveReplayEvent(MAILBOX_ID, { cursor: event.cursor, data: { unexpected: true } })).toEqual({ kind: "invalid" });
  });
});

const invalidation = (mailboxId: string): MailInvalidation => ({
  type: "mail.invalidated",
  mailboxId,
  conversationId: null,
  changeId: crypto.randomUUID(),
  at: "2026-07-16T20:00:00.000Z",
});

const recordingSocket = () => {
  const messages: MailLiveServerMessage[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  const socket: MailLiveSocket = {
    send: (data) => {
      const message = parseMailLiveServerMessage(String(data));
      if (message) messages.push(message);
      return String(data).length;
    },
    close: (code, reason) => {
      closes.push({ code, reason });
    },
  };
  return { socket, messages, closes };
};

const sequenceOf = (cursor: string): number => {
  const sequence = Number(cursor.split(".").at(-1));
  if (!cursor.startsWith("s6t.") || Number.isNaN(sequence)) throw new CursorMismatchError("foreign cursor");
  return sequence;
};

const waitFor = async (condition: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the Mail live connection");
    await Bun.sleep(5);
  }
};

describe("Mail live connection", () => {
  test("resyncs a legacy ms-seq cursor and keeps only the subscribed mailbox's events", async () => {
    const context = contextFor("Alice");
    const { socket, messages, closes } = recordingSocket();
    const eventsCalls: string[] = [];
    const deps: MailLiveConnectionDependencies = {
      resolveMailboxId: async (publicId) => (publicId === MAILBOX_ID ? "internal-box-1" : null),
      access: { resolveContext: async () => context, requireRead: async () => ok("read") },
      latestCursor: async () => "s6t.mailtest.200",
      cursorSequence: sequenceOf,
      events: ({ after, signal }) => {
        eventsCalls.push(after);
        return (async function* () {
          // The pre-migration client cursor belongs to no NATS stream.
          if (after.includes("-")) throw new CursorMismatchError("foreign cursor");
          yield { cursor: "s6t.mailtest.201", data: invalidation("Box002") };
          yield { cursor: "s6t.mailtest.202", data: invalidation(MAILBOX_ID) };
          yield { cursor: "s6t.mailtest.203", data: { unexpected: true } };
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        })();
      },
    };
    const connection = createMailLiveConnection(socket, { sessionToken: "session", requestId: null, locale: "en" }, deps);

    connection.message(
      JSON.stringify({ type: MAIL_LIVE_WS_TYPE.subscribe, payload: { mailboxId: MAILBOX_ID, fromCursor: "1700000000000-1" } }),
    );
    await waitFor(() => messages.length === 3);
    await Bun.sleep(20);
    await connection.close();

    expect(eventsCalls).toEqual(["1700000000000-1", "s6t.mailtest.200"]);
    expect(messages).toEqual([
      { type: MAIL_LIVE_WS_TYPE.ready, payload: { mailboxId: MAILBOX_ID, cursor: "1700000000000-1" } },
      { type: MAIL_LIVE_WS_TYPE.ready, payload: { mailboxId: MAILBOX_ID, cursor: "s6t.mailtest.200" } },
      {
        type: MAIL_LIVE_WS_TYPE.event,
        payload: { mailboxId: MAILBOX_ID, cursor: "s6t.mailtest.202", event: expect.objectContaining({ mailboxId: MAILBOX_ID }) },
      },
    ]);
    expect(closes).toEqual([]);
  });

  test("starts at the head instead of replaying a cursor far behind it", async () => {
    const context = contextFor("Alice");
    const { socket, messages } = recordingSocket();
    const eventsCalls: string[] = [];
    const deps: MailLiveConnectionDependencies = {
      resolveMailboxId: async () => "internal-box-1",
      access: { resolveContext: async () => context, requireRead: async () => ok("read") },
      latestCursor: async () => `s6t.mailtest.${MAIL_LIVE_MAX_REPLAY_EVENTS + 101}`,
      cursorSequence: sequenceOf,
      events: ({ after, signal }) => {
        eventsCalls.push(after);
        return (async function* () {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        })();
      },
    };
    const connection = createMailLiveConnection(socket, { sessionToken: "session", requestId: null, locale: "en" }, deps);

    connection.message(
      JSON.stringify({ type: MAIL_LIVE_WS_TYPE.subscribe, payload: { mailboxId: MAILBOX_ID, fromCursor: "s6t.mailtest.100" } }),
    );
    await waitFor(() => messages.length === 2 && eventsCalls.length === 1);
    // Exactly at the bound the cursor is still replayed.
    connection.message(
      JSON.stringify({ type: MAIL_LIVE_WS_TYPE.subscribe, payload: { mailboxId: MAILBOX_ID, fromCursor: "s6t.mailtest.101" } }),
    );
    await waitFor(() => messages.length === 3 && eventsCalls.length === 2);
    await connection.close();

    const head = `s6t.mailtest.${MAIL_LIVE_MAX_REPLAY_EVENTS + 101}`;
    expect(eventsCalls).toEqual([head, "s6t.mailtest.101"]);
    expect(messages).toEqual([
      { type: MAIL_LIVE_WS_TYPE.ready, payload: { mailboxId: MAILBOX_ID, cursor: "s6t.mailtest.100" } },
      { type: MAIL_LIVE_WS_TYPE.ready, payload: { mailboxId: MAILBOX_ID, cursor: head } },
      { type: MAIL_LIVE_WS_TYPE.ready, payload: { mailboxId: MAILBOX_ID, cursor: "s6t.mailtest.101" } },
    ]);
  });

  test("warns about malformed subscribed-mailbox events without forwarding their payload", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    const { socket, messages } = recordingSocket();
    const connection = createMailLiveConnection(
      socket,
      { sessionToken: "session", requestId: null, locale: "en" },
      {
        resolveMailboxId: async () => "internal-box-1",
        access: { resolveContext: async () => contextFor("Alice"), requireRead: async () => ok("read") },
        latestCursor: async () => "s6t.mailtest.10",
        cursorSequence: sequenceOf,
        events: ({ signal }) =>
          (async function* () {
            yield { cursor: "s6t.mailtest.11", data: { mailboxId: MAILBOX_ID, secret: "never log this" } };
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          })(),
      },
    );
    try {
      connection.message(JSON.stringify({ type: MAIL_LIVE_WS_TYPE.subscribe, payload: { mailboxId: MAILBOX_ID, fromCursor: null } }));
      await waitFor(() => warning.mock.calls.length > 0);
      expect(warning.mock.calls).toEqual([
        [
          "[mail:websocket]",
          "Mail live event skipped: payload does not match the protocol",
          { mailboxId: MAILBOX_ID, cursor: "s6t.mailtest.11" },
        ],
      ]);
      expect(messages.map((message) => message.type)).toEqual([MAIL_LIVE_WS_TYPE.ready]);
    } finally {
      await connection.close();
      warning.mockRestore();
    }
  });

  test("fails without opening replay when the broker head cannot be read", async () => {
    const { socket, messages, closes } = recordingSocket();
    let opened = false;
    const connection = createMailLiveConnection(
      socket,
      { sessionToken: "session", requestId: null, locale: "en" },
      {
        resolveMailboxId: async () => "internal-box-1",
        access: { resolveContext: async () => contextFor("Alice"), requireRead: async () => ok("read") },
        latestCursor: async () => {
          throw new Error("broker unavailable");
        },
        cursorSequence: sequenceOf,
        events: () =>
          (async function* () {
            opened = true;
          })(),
      },
    );
    try {
      connection.message(
        JSON.stringify({ type: MAIL_LIVE_WS_TYPE.subscribe, payload: { mailboxId: MAILBOX_ID, fromCursor: "s6t.mailtest.1" } }),
      );
      await waitFor(() => closes.length === 1);
      expect(opened).toBe(false);
      expect(messages).toEqual([
        { type: MAIL_LIVE_WS_TYPE.error, payload: { mailboxId: MAILBOX_ID, code: "stream_failed", message: expect.any(String) } },
      ]);
    } finally {
      await connection.close();
    }
  });

  test("rechecks permission before a retention refresh and never exposes its new head after revocation", async () => {
    const { socket, messages, closes } = recordingSocket();
    let checks = 0;
    const connection = createMailLiveConnection(
      socket,
      { sessionToken: "session", requestId: null, locale: "en" },
      {
        resolveMailboxId: async () => "internal-box-1",
        access: {
          resolveContext: async () => contextFor("Alice"),
          requireRead: async () => (++checks === 1 ? ok("read") : fail(err.forbidden("revoked"))),
        },
        latestCursor: async () => "s6t.mailtest.100",
        cursorSequence: sequenceOf,
        events: () =>
          (async function* () {
            throw new CursorMismatchError("old stream");
          })(),
      },
    );
    try {
      connection.message(
        JSON.stringify({ type: MAIL_LIVE_WS_TYPE.subscribe, payload: { mailboxId: MAILBOX_ID, fromCursor: "1700000000000-1" } }),
      );
      await waitFor(() => closes.length === 1);
      expect(messages.map((message) => message.type)).toEqual([MAIL_LIVE_WS_TYPE.ready, MAIL_LIVE_WS_TYPE.revoked]);
      expect(messages[0]).toEqual({ type: MAIL_LIVE_WS_TYPE.ready, payload: { mailboxId: MAILBOX_ID, cursor: "1700000000000-1" } });
      expect(closes).toEqual([{ code: 1008, reason: "access_denied" }]);
    } finally {
      await connection.close();
    }
  });

  (process.env.MAIL_INTEGRATION_TESTS === "1" ? test : test.skip)(
    "bounds a real JetStream reconnect, refreshes coverage, and tails only authorized mailbox events",
    async () => {
      const topic = getProcessSync().topic<MailInvalidation>({
        id: "mail-ws-replay-bound-test",
        retention: { maxAgeMs: 300_000, maxBytes: 8 * 1024 * 1024 },
      });
      const initial = await topic.head();
      for (let count = 0; count < MAIL_LIVE_MAX_REPLAY_EVENTS + 1; count += 100) {
        await Promise.all(
          Array.from({ length: Math.min(100, MAIL_LIVE_MAX_REPLAY_EVENTS + 1 - count) }, () =>
            topic.publish({ data: invalidation("Box002") }),
          ),
        );
      }
      const head = await topic.head();
      const { socket, messages } = recordingSocket();
      const calls: string[] = [];
      let permissionChecks = 0;
      const connection = createMailLiveConnection(
        socket,
        { sessionToken: "session", requestId: null, locale: "en" },
        {
          resolveMailboxId: async () => "internal-box-1",
          access: {
            resolveContext: async () => contextFor("Alice"),
            requireRead: async () => {
              permissionChecks++;
              return ok("read");
            },
          },
          latestCursor: () => topic.head(),
          cursorSequence: (cursor) => topic.cursorSequence(cursor),
          events: ({ after, signal }) => {
            calls.push(after);
            return topic.hub().subscribe({ after, signal });
          },
        },
      );
      try {
        connection.message(JSON.stringify({ type: MAIL_LIVE_WS_TYPE.subscribe, payload: { mailboxId: MAILBOX_ID, fromCursor: initial } }));
        await waitFor(() => calls.length === 1);
        expect(calls).toEqual([head]);
        expect(messages).toEqual([
          { type: MAIL_LIVE_WS_TYPE.ready, payload: { mailboxId: MAILBOX_ID, cursor: initial } },
          { type: MAIL_LIVE_WS_TYPE.ready, payload: { mailboxId: MAILBOX_ID, cursor: head } },
        ]);
        await topic.publish({ data: invalidation("Box002") });
        const receipt = await topic.publish({ data: invalidation(MAILBOX_ID) });
        await waitFor(() => messages.some((message) => message.type === MAIL_LIVE_WS_TYPE.event));
        expect(messages.filter((message) => message.type === MAIL_LIVE_WS_TYPE.event)).toEqual([
          {
            type: MAIL_LIVE_WS_TYPE.event,
            payload: { mailboxId: MAILBOX_ID, cursor: receipt.cursor, event: expect.objectContaining({ mailboxId: MAILBOX_ID }) },
          },
        ]);
        expect(permissionChecks).toBe(2);
      } finally {
        await connection.close();
      }
    },
    30_000,
  );
});
