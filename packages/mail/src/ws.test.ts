import { describe, expect, test } from "bun:test";
import { err, fail, ok } from "@k2b/stdlib";
import { CursorMismatchError } from "@k2b/sync";
import { UserSchema } from "@valentinkolb/cloud/contracts";
import { MAIL_LIVE_WS_TYPE, type MailInvalidation, type MailLiveServerMessage, parseMailLiveServerMessage } from "./live-events";
import type { MailRequestContext } from "./service/auth";
import {
  createMailLiveConnection,
  evaluateMailLiveAccess,
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

    expect(parseMailLiveReplayEvent(MAILBOX_ID, event)).toEqual({ cursor: event.cursor, event: event.data });
    expect(parseMailLiveReplayEvent("Box002", event)).toBeNull();
    expect(parseMailLiveReplayEvent(MAILBOX_ID, { ...event, cursor: "" })).toBeNull();
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
});
