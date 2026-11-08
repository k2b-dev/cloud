import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import { oauthTokens } from "@k2b/cloud/services";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { grantMailboxAccess } from "../service/access";
import type { MailRequestContext } from "../service/auth";
import { createMailbox } from "../service/mailboxes";
import app from ".";

// The production API stack includes the Valkey-backed rate limit, so these requests need all three services.
const suite = suiteFor("database", "nats", "valkey");

type Token = "owner" | "reader" | "outsider" | "admin";

/**
 * A Mail route answers a mailbox the caller cannot read like an unknown one, so no route tells whether the mailbox or an
 * ID inside it exists. A reader without the right for one route is still refused as forbidden, Cloud administrators
 * keep their administration routes, and mailbox administrators keep the lifecycle of their deleted mailboxes.
 */
suite("Mail API checks mailbox access before resolving IDs", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const tokens = new Map<Token, User>();
  let verifyAccessToken: { mockRestore: () => void } | undefined;
  let mailboxId = "";
  let mailboxShortId = "";
  let conversationShortId = "";
  let deletedMailboxId = "";
  let deletedMailboxShortId = "";

  const request = (token: Token, path: string, method = "GET") =>
    app.request(path, { method, headers: { authorization: `Bearer ${token}`, "x-forwarded-for": uniqueCallerAddress() } });
  /** Status and body of a response, the whole observable answer of a refusal. */
  const answer = async (response: Response | Promise<Response>) => {
    const resolved = await response;
    return { status: resolved.status, body: await resolved.json() };
  };
  const contextFor = (user: User): MailRequestContext => ({
    actor: { kind: "user", user },
    accessSubject: { type: "user", userId: user.id },
    requestId: null,
  });

  beforeAll(async () => {
    for (const token of ["owner", "reader", "outsider", "admin"] as const) {
      const admin = token === "admin";
      const [row] = await sql<{ id: string; uid: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name, admin)
        VALUES (${`mail-route-boundary-${token}-${suffix}`}, 'local', 'user', ${`Route boundary ${token}`}, ${admin})
        RETURNING id, uid
      `;
      tokens.set(token, {
        id: row!.id,
        uid: row!.uid,
        roles: admin ? ["admin", "user"] : ["user"],
        provider: "local",
        profile: "user",
        givenname: row!.uid,
        sn: "Test",
        displayName: row!.uid,
        mail: `${row!.uid}@example.test`,
        avatarHash: null,
        ipa: null,
        accountExpires: null,
        lastLoginLocal: null,
        memberofGroup: [],
        memberofGroupIds: [],
        manages: [],
        managesGroupIds: [],
      });
    }
    verifyAccessToken = spyOn(oauthTokens, "verifyAccessToken").mockImplementation(async (token: string) => {
      const user = tokens.get(token as Token);
      return user ? { kind: "user", payload: {}, user, scopes: ["read", "write"] } : null;
    });
    const owner = contextFor(tokens.get("owner")!);
    for (const deleted of [false, true]) {
      const mailbox = await createMailbox(owner, { name: `Route boundary ${suffix} ${deleted ? "deleted" : "active"}` });
      if (!mailbox.ok) throw new Error(mailbox.error.message);
      const grant = await grantMailboxAccess({
        context: owner,
        mailboxId: mailbox.data.id,
        principal: { type: "user", userId: tokens.get("reader")!.id },
        permission: "read",
      });
      if (!grant.ok) throw new Error(grant.error.message);
      const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailbox.data.id}::uuid`;
      if (deleted) {
        deletedMailboxId = mailbox.data.id;
        deletedMailboxShortId = row!.short_id;
      } else {
        mailboxId = mailbox.data.id;
        mailboxShortId = row!.short_id;
      }
    }
    const [conversation] = await sql<{ short_id: string }[]>`INSERT INTO mail.conversations
      (short_id, mailbox_id, subject, participant_summary, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Release', 'lea@outside.test', now()) RETURNING short_id`;
    conversationShortId = conversation!.short_id;
    expect((await request("owner", `/mailboxes/${deletedMailboxShortId}`, "DELETE")).status).toBe(200);
  }, 30_000);

  afterAll(async () => {
    verifyAccessToken?.mockRestore();
    for (const id of [mailboxId, deletedMailboxId].filter(Boolean)) {
      const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${id}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${id}::uuid`;
      await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${access.map((entry) => entry.access_id)}::jsonb))`;
    }
    const userIds = [...tokens.values()].map((user) => user.id);
    await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
  }, 30_000);

  test("mailbox routes answer an unreadable mailbox like an unknown one", async () => {
    const unknown = newShortId();
    const existing = await answer(request("outsider", `/mailboxes/${mailboxShortId}`));
    expect(existing.status).toBe(404);
    expect(await answer(request("outsider", `/mailboxes/${unknown}`))).toEqual(existing);

    const comments = (mailbox: string, conversation: string) => `/mailboxes/${mailbox}/conversations/${conversation}/comments`;
    const existingConversation = await answer(request("outsider", comments(mailboxShortId, conversationShortId)));
    expect(existingConversation).toEqual(existing);
    expect(await answer(request("outsider", comments(mailboxShortId, newShortId())))).toEqual(existing);
    expect(await answer(request("outsider", comments(unknown, conversationShortId)))).toEqual(existing);

    expect((await request("reader", comments(mailboxShortId, conversationShortId))).status).toBe(200);
    expect((await request("reader", `/mailboxes/${mailboxShortId}/access`)).status).toBe(403);
    expect((await request("owner", `/mailboxes/${mailboxShortId}/access`)).status).toBe(200);
  });

  test("every mounted mailbox route conceals unreadable mailbox and child IDs", async () => {
    const routes = app.routes.filter((route) => route.path.includes(":mailboxId") && route.method !== "ALL");
    expect(routes.length).toBeGreaterThan(100);
    for (const route of routes) {
      const path = (mailbox: string, conversation: string) =>
        route.path.replace(/:([A-Za-z]+)/g, (_match, name: string) =>
          name === "mailboxId" ? mailbox : name === "conversationId" ? conversation : "Missing1",
        );
      const existing = await answer(request("outsider", path(mailboxShortId, conversationShortId), route.method));
      const missingChild = await answer(request("outsider", path(mailboxShortId, newShortId()), route.method));
      const missingMailbox = await answer(request("outsider", path(newShortId(), conversationShortId), route.method));
      expect({ route: `${route.method} ${route.path}`, answer: missingChild }).toEqual({
        route: `${route.method} ${route.path}`,
        answer: existing,
      });
      expect({ route: `${route.method} ${route.path}`, answer: missingMailbox }).toEqual({
        route: `${route.method} ${route.path}`,
        answer: existing,
      });
      expect(existing.status).toBeGreaterThanOrEqual(400);
    }
  }, 30_000);

  test("administration routes stay with Cloud administrators and tell nothing to anyone else", async () => {
    const unknown = newShortId();
    for (const token of ["outsider", "reader"] as const) {
      const known = await answer(request(token, `/admin/mailboxes/${mailboxShortId}/access`));
      expect(known.status).toBe(403);
      expect(await answer(request(token, `/admin/mailboxes/${unknown}/access`))).toEqual(known);
      expect(await answer(request(token, `/admin/kept/${mailboxShortId}/${conversationShortId}`))).toEqual(
        await answer(request(token, `/admin/kept/${unknown}/${newShortId()}`)),
      );
    }

    expect((await request("admin", `/admin/mailboxes/${mailboxShortId}/access`)).status).toBe(200);
    expect((await request("admin", `/admin/mailboxes/${unknown}/access`)).status).toBe(404);
    // A Cloud administrator without a mailbox grant repairs access through the mailbox's own route too.
    expect((await request("admin", `/mailboxes/${mailboxShortId}/access`)).status).not.toBe(404);
  });

  test("a deleted mailbox keeps its lifecycle for its administrators and answers like an unknown one otherwise", async () => {
    expect((await request("owner", `/mailboxes/${deletedMailboxShortId}/deleted`)).status).toBe(200);
    const unknown = await answer(request("reader", `/mailboxes/${newShortId()}/deleted`));
    expect(unknown.status).toBe(404);
    expect(await answer(request("reader", `/mailboxes/${deletedMailboxShortId}/deleted`))).toEqual(unknown);
    expect(await answer(request("reader", `/mailboxes/${deletedMailboxShortId}/restore`, "POST"))).toEqual(unknown);
  });
});
