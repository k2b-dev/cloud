import { describe, expect, test } from "bun:test";
import type { RequestActor } from "@k2b/cloud/server";
import { Hono } from "hono";
import { draftDocumentAccountMatches, requireDraftDocumentAccount } from "./draft-document-identity";
import type { MailApiContext } from "./public-resource-boundary";

const actor = (id: string): RequestActor => ({
  kind: "user",
  user: {
    id,
    uid: id,
    provider: "local",
    profile: "user",
    roles: ["user"],
    displayName: id,
    givenname: "",
    sn: "",
    mail: null,
    avatarHash: null,
    accountExpires: null,
    lastLoginLocal: null,
    ipa: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  },
});

describe("Mail document account binding", () => {
  test("only the authenticated direct user can satisfy an explicit binding", () => {
    expect(draftDocumentAccountMatches(actor("A"), true, ["A"])).toBe(true);
    expect(draftDocumentAccountMatches(actor("B"), true, ["A"])).toBe(false);
    expect(draftDocumentAccountMatches(undefined, true, ["A"])).toBe(false);
    expect(draftDocumentAccountMatches(actor("A"), true, undefined)).toBe(false);
    for (const expected of [[], [""], ["A", "A"], ["A", "B"]]) {
      expect(draftDocumentAccountMatches(actor("A"), true, expected)).toBe(false);
    }
  });

  test("unbound non-session clients remain supported; supplied bindings are enforced", () => {
    expect(draftDocumentAccountMatches(actor("B"), false, undefined)).toBe(true);
    expect(draftDocumentAccountMatches(actor("B"), false, ["A"])).toBe(false);
    expect(draftDocumentAccountMatches(actor("A"), false, ["A"])).toBe(true);
  });

  test("a delegated service account cannot impersonate its user for an explicit binding", () => {
    const user = actor("A");
    if (user.kind !== "user") throw new Error("User fixture missing");
    const delegated: RequestActor = {
      kind: "service_account",
      delegatedUser: user.user,
      scopes: [],
      serviceAccount: {
        id: "27aff9bc-2800-4435-ac5d-cd48b0910b83",
        name: "Delegated",
        kind: "user_delegated",
        status: "active",
        delegatedUserId: "A",
        appId: null,
        resourceType: null,
        resourceId: null,
        createdBy: null,
        createdAt: "2026-10-04T10:00:00.000Z",
      },
    };
    expect(draftDocumentAccountMatches(delegated, false, undefined)).toBe(true);
    expect(draftDocumentAccountMatches(delegated, false, ["A"])).toBe(false);
  });

  test("session requests reject missing, empty and repeated query bindings", async () => {
    const app = new Hono<MailApiContext>()
      .use("*", async (c, next) => {
        c.set("actor", actor("A"));
        c.set("credentialKind", "session");
        await next();
      })
      .use("*", requireDraftDocumentAccount)
      .get("*", (c) => c.json({ allowed: true }));
    for (const query of ["", "?expectedUserId=", "?expectedUserId=A&expectedUserId=A", "?expectedUserId=A&expectedUserId=B"])
      expect((await app.request(`http://localhost/${query}`)).status).toBe(403);
  });

  test.each(["", "/updates", "/snapshot", "/rest", "/table-action", "/socket"])(
    "same-request mismatch rejects %s before reading its body or reaching document work",
    async (suffix) => {
      let current = "A";
      let admitted = 0;
      const path = "/mailboxes/:mailboxId/drafts/:draftId/document";
      const app = new Hono<MailApiContext>()
        .use("*", async (c, next) => {
          c.set("actor", actor(current));
          c.set("credentialKind", "session");
          await next();
        })
        .use(path, requireDraftDocumentAccount)
        .use(`${path}/*`, requireDraftDocumentAccount)
        .all(`${path}${suffix}`, async (c) => {
          // Both accounts are allowed through this simulated domain access boundary.
          admitted++;
          if (c.req.method === "POST") await c.req.json();
          return c.json({ allowed: true });
        });
      const url = `http://localhost/mailboxes/Box001/drafts/Draft1/document${suffix}?expectedUserId=A`;
      const get = suffix === "" || suffix === "/socket";
      const first = await app.request(url, get ? undefined : { method: "POST", body: "{}" });
      expect(first.status).toBe(200);
      expect(first.headers.get("Cache-Control")).toBe("no-store");
      current = "B";
      const request = new Request(url, get ? undefined : { method: "POST", body: "not even valid JSON" });
      const denied = await app.request(request);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "DRAFT_ACCOUNT_MISMATCH" });
      expect(request.bodyUsed).toBe(false);
      expect(admitted).toBe(1);
    },
  );
});
