import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { oauthTokens } from "@k2b/cloud/services";
import { ok } from "@k2b/stdlib";
import { generateSpecs } from "hono-openapi";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { focus, mailboxAccess, mailboxPreferences, publicResources } from "../service";
import * as workspace from "../service/workspace";
import app from ".";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "mail-focus-api-test",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Mail",
  sn: "Focus",
  displayName: "Mail Focus",
  mail: "mail-focus@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;

afterEach(() => mock.restore());

// These API contracts exercise the real services behind the routes, so they need the test database.
const suite = databaseSuite();

suite("Mail focus API", () => {
  test("publishes the authenticated cross-mailbox route", async () => {
    const spec = await generateSpecs(app);
    const operation = spec.paths?.["/overview/conversations"]?.get;
    expect(operation?.tags).toContain("Mail:Conversations");
    expect(operation?.security?.length).toBe(1);
    expect(operation?.responses?.["200"]).toBeDefined();
  });

  test("projects conversation and mailbox IDs independently", async () => {
    const conversationId = "22222222-2222-4222-8222-222222222222";
    const mailboxId = "33333333-3333-4333-8333-333333333333";
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: [] });
    spyOn(mailboxAccess, "requireMailboxPermission").mockResolvedValue(ok("admin"));
    spyOn(mailboxAccess, "getMailboxPermission").mockResolvedValue("admin");
    spyOn(focus, "listFocusConversations").mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            id: conversationId,
            mailboxId,
            mailboxName: "Support",
            subject: "Release update",
            participantSummary: "Ada",
            latestMessageAt: "2026-08-19T10:00:00.000Z",
            workStatus: "needs_action",
            assigneeUserId: user.id,
            revision: 1,
            sourceFolderId: null,
            unread: true,
            flagged: false,
            hasAttachments: false,
            preview: "Ready to ship",
          },
        ],
        counts: { mine: 1, unassigned: 0, waiting: 0, all: 1 },
        mailboxCounts: [{ mailboxId, unread: 1, needsAction: 1 }],
        nextCursor: null,
      },
    });
    spyOn(publicResources, "publicIds").mockImplementation(async (table) =>
      table === "conversations" ? new Map([[conversationId, "Convo1"]]) : new Map([[mailboxId, "Mail01"]]),
    );

    const response = await app.request("/overview/conversations?view=mine&limit=25", {
      headers: { authorization: "Bearer mail-focus-api-test" },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      items: [{ id: "Convo1", mailboxId: "Mail01", mailboxName: "Support" }],
      counts: { mine: 1, unassigned: 0, waiting: 0, all: 1 },
      mailboxCounts: [{ mailboxId: "Mail01", unread: 1, needsAction: 1 }],
    });
    expect(JSON.stringify(body)).not.toContain(conversationId);
    expect(JSON.stringify(body)).not.toContain(mailboxId);
  });

  test("passes mailboxes hidden in the overview as internal IDs and rejects malformed ones", async () => {
    const mailboxId = "33333333-3333-4333-8333-333333333333";
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: [] });
    const resolve = spyOn(publicResources, "resolveExistingPublicIds").mockResolvedValue([mailboxId]);
    const list = spyOn(focus, "listFocusConversations").mockResolvedValue({
      ok: true,
      data: { items: [], counts: { mine: 0, unassigned: 0, waiting: 0, all: 0 }, mailboxCounts: [], nextCursor: null },
    });

    const response = await app.request("/overview/conversations?view=all&excludeMailboxIds=Mail01,Mail02", {
      headers: { authorization: "Bearer mail-focus-api-test" },
    });
    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledWith("mailboxes", ["Mail01", "Mail02"]);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ view: "all", excludedMailboxIds: [mailboxId] }));

    const malformed = await app.request("/overview/conversations?excludeMailboxIds=not-an-id", {
      headers: { authorization: "Bearer mail-focus-api-test" },
    });
    expect(malformed.status).toBe(400);
    expect(list).toHaveBeenCalledTimes(1);
  });

  test("saves a pin or hide for the signed-in person on the mailbox's internal ID", async () => {
    const mailboxId = "33333333-3333-4333-8333-333333333333";
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: [] });
    spyOn(publicResources, "resolvePublicId").mockResolvedValue(mailboxId);
    const save = spyOn(mailboxPreferences, "setMailboxPreference").mockResolvedValue(ok({ pinned: false, hidden: true }));
    const request = (body: unknown) =>
      app.request("/mailboxes/Mail01/preference", {
        method: "PATCH",
        headers: { authorization: "Bearer mail-focus-api-test", "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const response = await request({ hidden: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pinned: false, hidden: true });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ actor: expect.anything() }), mailboxId, { hidden: true });

    // A change must say what to change.
    expect((await request({})).status).toBe(400);
    expect(save).toHaveBeenCalledTimes(1);

    const spec = await generateSpecs(app);
    expect(spec.paths?.["/mailboxes/{mailboxId}/preference"]?.patch?.tags).toContain("Mail:Mailboxes");
    expect(spec.paths?.["/mailboxes/preferences"]?.get?.tags).toContain("Mail:Mailboxes");
  });

  test("resolves public mailbox and conversation IDs for overview details", async () => {
    const mailboxId = "33333333-3333-4333-8333-333333333333";
    const conversationId = "22222222-2222-4222-8222-222222222222";
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: [] });
    spyOn(mailboxAccess, "requireMailboxPermission").mockResolvedValue(ok("admin"));
    spyOn(mailboxAccess, "getMailboxPermission").mockResolvedValue("admin");
    spyOn(publicResources, "publicIds").mockImplementation(
      async (_table, ids) => new Map(ids.flatMap((id) => (typeof id === "string" ? [[id, id] as const] : []))),
    );
    spyOn(publicResources, "resolvePublicId").mockResolvedValue(mailboxId);
    spyOn(publicResources, "resolveMailboxPublicId").mockResolvedValue(conversationId);
    const loadDetail = spyOn(workspace, "loadMailboxConversationDetail").mockResolvedValue(null);

    const response = await app.request("/mailboxes/Mail01/workspace-detail/Convo1", {
      headers: { authorization: "Bearer mail-focus-api-test" },
    });

    expect(response.status).toBe(404);
    expect(publicResources.resolvePublicId).toHaveBeenCalledWith("mailboxes", "Mail01");
    expect(publicResources.resolveMailboxPublicId).toHaveBeenCalledWith("conversations", mailboxId, "Convo1");
    expect(loadDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        mailboxId,
        conversationId,
      }),
    );
  });
});
