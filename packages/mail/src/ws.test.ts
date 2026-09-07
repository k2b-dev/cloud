import { describe, expect, test } from "bun:test";
import { err, fail, ok } from "@k2b/stdlib";
import { UserSchema } from "@valentinkolb/cloud/contracts";
import type { MailInvalidation } from "./live-events";
import type { MailRequestContext } from "./service/auth";
import { evaluateMailLiveAccess, type MailLiveAccessDependencies, parseMailLiveReplayEvent, resolveMailLiveCursor } from "./ws";

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
      await resolveMailLiveCursor(MAILBOX_ID, "s6t.mailtest.82", async () => {
        latestReads++;
        return "s6t.mailtest.91";
      }),
    ).toBe("s6t.mailtest.82");
    expect(latestReads).toBe(0);
  });

  test("uses the current stream tail and the empty-stream baseline", async () => {
    expect(await resolveMailLiveCursor(MAILBOX_ID, null, async () => "s6t.mailtest.91")).toBe("s6t.mailtest.91");
    expect(await resolveMailLiveCursor(MAILBOX_ID, null, async () => "s6t.mailtest.0")).toBe("s6t.mailtest.0");
  });

  test("rejects malformed cursors returned by the replay log", async () => {
    await expect(resolveMailLiveCursor(MAILBOX_ID, null, async () => "")).rejects.toThrow();
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
