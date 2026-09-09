import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { oauthTokens } from "@k2b/cloud/services";
import { generateSpecs } from "hono-openapi";
import { conversationContext, publicResources } from "../service";
import app from ".";

const base = "/mailboxes/{mailboxId}/conversations/{conversationId}";
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "related-mail-test",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Related",
  sn: "Mail",
  displayName: "Related Mail",
  mail: "related-mail@example.test",
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

describe("Mail conversation context OpenAPI contract", () => {
  test("publishes authenticated Contacts and Spaces context routes", async () => {
    const spec = await generateSpecs(app);
    const history = spec.paths?.[`${base}/contacts/{bookId}/{contactId}/history`]?.get;
    const operations = [
      spec.paths?.[`${base}/context`]?.get,
      spec.paths?.[`${base}/related`]?.get,
      history,
      spec.paths?.[`${base}/spaces/items`]?.get,
      spec.paths?.[`${base}/spaces/items`]?.post,
      spec.paths?.[`${base}/spaces/link`]?.post,
      spec.paths?.[`${base}/spaces/unlink`]?.post,
    ];

    expect(operations.every((operation) => operation?.tags?.includes("Mail:Context"))).toBe(true);
    expect(operations.every((operation) => operation?.security?.length === 1)).toBe(true);
    expect(operations.every((operation) => operation?.responses?.["200"])).toBe(true);
    expect(history?.responses?.["503"]).toBeDefined();
  });

  test("projects related conversation identities at the public route", async () => {
    const internalMailboxId = "22222222-2222-4222-8222-222222222222";
    const internalConversationId = "33333333-3333-4333-8333-333333333333";
    const internalRelatedId = "44444444-4444-4444-8444-444444444444";
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: [] });
    spyOn(publicResources, "resolvePublicId").mockResolvedValue(internalMailboxId);
    spyOn(publicResources, "resolveMailboxPublicId").mockResolvedValue(internalConversationId);
    spyOn(publicResources, "publicIds").mockResolvedValue(new Map([[internalRelatedId, "rel123"]]));
    spyOn(conversationContext, "listRelatedConversations").mockResolvedValue({
      ok: true,
      data: [
        {
          id: internalRelatedId,
          subject: "Re: Release update",
          participantSummary: "Ada",
          latestMessageAt: "2026-08-18T12:00:00.000Z",
          preview: "Earlier context",
          reasons: [{ kind: "participant", value: "ada@example.test" }],
        },
      ],
    });

    const response = await app.request("/mailboxes/mbx123/conversations/cnv123/related?limit=5", {
      headers: { authorization: "Bearer related-mail-test" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        id: "rel123",
        subject: "Re: Release update",
        participantSummary: "Ada",
        latestMessageAt: "2026-08-18T12:00:00.000Z",
        preview: "Earlier context",
        reasons: [{ kind: "participant", value: "ada@example.test" }],
      },
    ]);
  });

  test("returns the structured Contacts dependency failure from the public route", async () => {
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: [] });
    spyOn(conversationContext, "listRelatedMail").mockResolvedValue({
      ok: false,
      code: "INVALID_APP_RESPONSE",
      message: "Contacts returned an invalid response",
      status: 503,
    });
    spyOn(publicResources, "resolvePublicId").mockResolvedValue("22222222-2222-4222-8222-222222222222");
    spyOn(publicResources, "resolveMailboxPublicId").mockResolvedValue("33333333-3333-4333-8333-333333333333");

    const response = await app.request("/mailboxes/mbx123/conversations/cnv123/contacts/system/cnt123/history", {
      headers: { authorization: "Bearer related-mail-test" },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "INVALID_APP_RESPONSE",
      message: "Contacts returned an invalid response",
    });
  });

  test("rejects legacy UUID resource URLs", async () => {
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: [] });
    const relatedMail = spyOn(conversationContext, "listRelatedMail");

    const response = await app.request(
      "/mailboxes/22222222-2222-4222-8222-222222222222/conversations/33333333-3333-4333-8333-333333333333/contacts/system/44444444-4444-4444-8444-444444444444/history",
      { headers: { authorization: "Bearer related-mail-test" } },
    );

    expect(response.status).toBe(404);
    expect(relatedMail).not.toHaveBeenCalled();
  });
});
