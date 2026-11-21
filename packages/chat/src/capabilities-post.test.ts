import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { assertCapabilityReview, compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { type CapabilityExecutionContext, ServiceAccountSchema, type User } from "@k2b/cloud/contracts";
import { chatCapabilities } from "./capabilities";
import * as access from "./service/access";
import { messages } from "./service/messages";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "lea",
  provider: "local",
  profile: "user",
  roles: ["user"],
  givenname: "Lea",
  sn: "Example",
  displayName: "Lea Example",
  mail: "lea@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;
const context: CapabilityExecutionContext = {
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  user,
  locale: "en",
  requestId: "post-test",
  origin: "http",
  via: null,
  signal: new AbortController().signal,
  idempotencyKey: "stable-post-key",
};
const conversation: access.AuthorizedConversation = {
  id: "22222222-2222-4222-8222-222222222222",
  short_id: "Chat01",
  kind: "chat",
  resource_type: null,
  resource_id: null,
  name: "Results",
  icon: null,
  purpose: null,
  member_count: 1,
  seq_head: "0",
  rev: "0",
  changed_rev: "0",
  created_at: new Date("2026-11-06T10:00:00Z"),
  last_activity_at: new Date("2026-11-06T10:00:00Z"),
  permission: "write",
};
const action = chatCapabilities.actions["message.post"];
const input = { conversation: "Chat01", body: "Today's summary" };
afterEach(() => {
  mock.restore();
});

test("chat post declares explicit background policy, bounded content and required retry key", () => {
  const manifest = compileCapabilityManifest("chat", chatCapabilities);
  expect(action.policy).toEqual({ silent: "shared" });
  expect(manifest.actions.find((entry) => entry.localId === "message.post")?.approval).toBe("rememberable");
  expect(action.idempotency).toBe("required");
  expect(action.input.safeParse({ ...input, body: "🦋".repeat(20_000) }).success).toBeTrue();
  for (const body of [" ", "\u0000", "x".repeat(20_001)]) expect(action.input.safeParse({ ...input, body }).success).toBeFalse();
  expect(action.input.safeParse({ ...input, via: "assistant" }).success).toBeFalse();
});

test("chat post reviews the full proposed text in English and German", async () => {
  const allowed = spyOn(access, "requireConversation").mockResolvedValue({ ok: true, data: conversation });
  for (const locale of ["en", "de-CH"]) {
    const result = await action.review({ ...input, body: "🦋".repeat(20_000) }, { ...context, locale });
    expect(result.ok).toBeTrue();
    if (!result.ok) continue;
    assertCapabilityReview(result.data, {
      inputSchema: { properties: { body: { type: "string" } } },
      policy: action.policy,
      queries: [],
      validateQueryInput: () => false,
      locales: ["en", "de"],
    });
    expect(result.data.locale).toBe(locale === "en" ? "en" : "de");
    expect(result.data.view?.blocks[0]).toMatchObject({ kind: "Draft", fields: [{ name: "body", value: "🦋".repeat(20_000) }] });
    expect(result.data.scope).toBe("conversation:Chat01");
    expect(result.data.ask).toBeUndefined();
  }
  expect(allowed).toHaveBeenCalledWith(
    expect.objectContaining({ conversationId: "Chat01", required: "write", accessSubject: context.accessSubject }),
  );
});

test("chat post refuses denied access in both review and execution, and cannot bypass item discussions", async () => {
  const allowed = spyOn(access, "requireConversation").mockResolvedValue({
    ok: false,
    error: { code: "FORBIDDEN", status: 403, message: "Denied" },
  });
  const send = spyOn(messages, "send");
  expect((await action.review(input, context)).ok).toBeFalse();
  expect((await action.run(input, context)).ok).toBeFalse();
  allowed.mockResolvedValue({ ok: true, data: { ...conversation, kind: "system" } });
  expect((await action.review(input, context)).ok).toBeFalse();
  expect((await action.run(input, context)).ok).toBeFalse();
  expect(send).not.toHaveBeenCalled();
});

test("chat post preserves service errors and gives the send service stable retry identity", async () => {
  spyOn(access, "requireConversation").mockResolvedValue({ ok: true, data: conversation });
  const send = spyOn(messages, "send").mockResolvedValue({
    ok: false,
    error: { code: "IDEMPOTENCY_CONFLICT", status: 409, message: "Changed body" },
  });
  expect(await action.run(input, { ...context, idempotencyKey: undefined })).toMatchObject({
    ok: false,
    error: { code: "IDEMPOTENCY_KEY_REQUIRED" },
  });
  expect(send).not.toHaveBeenCalled();
  expect(await action.run(input, context)).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
  await action.run(input, context);
  expect(send.mock.calls[0]?.[0].input).toEqual(send.mock.calls[1]?.[0].input);
  await action.run({ ...input, body: "Changed" }, context);
  expect(send.mock.calls[0]?.[0].replayHash).not.toBe(send.mock.calls[2]?.[0].replayHash);
  send.mockResolvedValue({ ok: false, error: "Wait", code: "RATE_LIMITED", status: 429, retryAfter: 3 });
  expect(await action.run(input, context)).toMatchObject({ ok: false, error: { status: 429, details: { retryAfter: 3 } } });
});

test("chat post returns the stored message and a canonical open link", async () => {
  spyOn(access, "requireConversation").mockResolvedValue({ ok: true, data: conversation });
  spyOn(messages, "send").mockResolvedValue({
    ok: true,
    data: {
      created: true,
      message: {
        id: "Msg001",
        conversationId: "Chat01",
        seq: 1,
        rev: 1,
        kind: "text",
        author: { type: "user", id: user.id, name: user.displayName },
        body: input.body,
        system: null,
        systemText: null,
        createdAt: "2026-11-06T10:00:00.000Z",
        attachments: [],
        mentions: [],
        reactions: [],
        refs: [],
        thread: null,
        replyTo: null,
      },
    },
  });
  expect(await action.run(input, context)).toEqual({
    ok: true,
    data: {
      data: { id: "Msg001", conversation: "Chat01", createdAt: "2026-11-06T10:00:00.000Z" },
      links: [{ rel: "open", href: "/app/chat/c/Chat01/t/general/m/Msg001" }],
    },
  });
});

test("chat post checks a delegated credential before review or dispatch and carries framework provenance", async () => {
  const delegated = {
    ...context,
    actor: {
      kind: "service_account",
      serviceAccount: ServiceAccountSchema.parse({
        id: "33333333-3333-4333-8333-333333333333",
        kind: "user_delegated",
        name: "Delegate",
        status: "active",
        delegatedUserId: user.id,
        appId: null,
        resourceType: null,
        resourceId: null,
        createdBy: user.id,
        createdAt: "2026-11-06T10:00:00Z",
      }),
      delegatedUser: user,
      scopes: ["read"],
    },
  } satisfies CapabilityExecutionContext;
  const allowed = spyOn(access, "requireConversation");
  const send = spyOn(messages, "send");
  expect((await action.review(input, delegated)).ok).toBeFalse();
  expect((await action.run(input, delegated)).ok).toBeFalse();
  expect(allowed).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  allowed.mockResolvedValue({ ok: true, data: conversation });
  send.mockResolvedValue({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT", status: 409, message: "Changed" } });
  await action.run(input, { ...context, via: "assistant" });
  expect(send.mock.calls[0]?.[0].via).toBe("assistant");
});
