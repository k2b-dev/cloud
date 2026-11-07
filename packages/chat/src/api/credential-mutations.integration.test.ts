import { afterAll, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { createAccess } from "@k2b/cloud/server";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { prepareIdentitySigner } from "@k2b/cloud/services/identity/key-ring";
import { getIdentityRuntimeConfig } from "@k2b/cloud/services/identity/runtime-config";
import { SignJWT } from "jose";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { MessageViewSchema } from "../service/contracts";
import { messageFixtures, type Person } from "./messages.test-fixture";

setDefaultTimeout(30_000);
suiteFor(
  "database",
  "nats",
  "valkey",
)("Chat credential mutation parity", () => {
  const f = messageFixtures();
  afterAll(() => setSystemTime());
  const accounts: string[] = [];
  afterAll(async () => {
    for (const id of accounts) {
      await sql`DELETE FROM events.outbox WHERE app_id = 'chat' AND ordering_key = ${`p:service_account:${id}`}`;
      await sql`DELETE FROM audit.events WHERE actor_uid = ${id} OR target_id = ${id} OR metadata->>'serviceAccountId' = ${id}`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    }
  });
  const apiKey = async (person: Person, kind: "user_delegated" | "agent" | "standalone", scope: string) => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts(name,kind,delegated_user_id)
      VALUES(${`chat-credential-${crypto.randomUUID()}`},${kind},${kind === "user_delegated" ? person.id : null}::uuid) RETURNING id`;
    accounts.push(row!.id);
    const result = await serviceAccountCredentials.createApiToken({
      serviceAccountId: row!.id,
      name: "credential regression",
      scopes: scope ? [scope] : [],
    });
    if (!result.ok) throw new Error(result.error.message);
    return { id: row!.id, headers: { authorization: `Bearer ${result.data.token}` } };
  };
  const oauth = async (person: Person, scope: string) => {
    const [clock] = await sql<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    setSystemTime(clock!.now);
    const signer = await prepareIdentitySigner("oauth");
    const { issuer } = await getIdentityRuntimeConfig();
    const [user] = await sql<{ auth_epoch: string }[]>`SELECT auth_epoch FROM auth.users WHERE id=${person.id}::uuid`;
    const token = await new SignJWT({
      token_use: "access",
      client_id: "cloud-cli",
      id: person.id,
      auth_epoch: Number(user!.auth_epoch),
      scope,
    })
      .setProtectedHeader({ alg: "RS256", kid: signer.kid, typ: "JWT" })
      .setIssuer(issuer)
      .setAudience("cloud")
      .setSubject(person.id)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signer.key);
    return { authorization: `Bearer ${token}` };
  };
  for (const kind of ["session", "personal-api", "oauth", "agent", "standalone"] as const) {
    for (const scope of kind === "session" ? ["session"] : kind === "personal-api" ? ["", "read", "write"] : ["read", "write", "admin"]) {
      test(`${kind}/${scope || "empty"}: send edit react delete members`, async () => {
        const owner = await f.person();
        const newcomer = await f.person();
        const target = await f.person();
        const chat = await f.fixture(owner, [{ person: target, permission: "write" }]);
        const machine = kind === "agent" || kind === "standalone";
        const key =
          kind === "personal-api" || machine ? await apiKey(owner, kind === "personal-api" ? "user_delegated" : kind, scope) : null;
        const headers = key?.headers ?? (kind === "oauth" ? await oauth(owner, scope) : owner.headers);
        if (machine && key) {
          const grant = await createAccess({ principal: { type: "service_account", serviceAccountId: key.id }, permission: "admin" });
          if (!grant.ok) throw new Error(grant.error.message);
          await sql`INSERT INTO chat.conversation_access(conversation_id,access_id,role,added_by_type,added_by_id)
            VALUES(${chat.id}::uuid,${grant.data.id}::uuid,'member','user',${owner.id}::uuid)`;
          await sql`INSERT INTO chat.participants(conversation_id,principal_type,principal_id,origin,joined_seq)
            VALUES(${chat.id}::uuid,'service_account',${key.id}::uuid,'direct',0)`;
        }
        expect((await f.request(headers, `/${chat.shortId}`)).status).toBe(200);
        const scopeDenied = scope === "read" && kind !== "personal-api";
        const sent = await f.request(headers, `/${chat.shortId}/messages`, "POST", {
          clientId: crypto.randomUUID(),
          body: "credential regression",
        });
        expect(sent.status).toBe(scopeDenied ? 403 : 201);
        const seeded = scopeDenied
          ? await f.request(owner.headers, `/${chat.shortId}/messages`, "POST", { clientId: crypto.randomUUID(), body: "seed" })
          : sent;
        const message = MessageViewSchema.parse(await seeded.json());
        const path = `/${chat.shortId}/messages/${message.id}`;
        const edited = await f.request(headers, path, "PATCH", {
          clientId: crypto.randomUUID(),
          revision: message.contentRevision ?? 0,
          body: "edited",
        });
        expect(edited.status).toBe(scopeDenied ? 403 : 200);
        const view = edited.ok ? MessageViewSchema.parse(await edited.json()) : message;
        const reaction = await f.request(headers, `${path}/reactions/${encodeURIComponent("👍")}`, "PUT");
        expect(reaction.status).toBe(scopeDenied ? 403 : 204);
        const removed = await f.request(headers, path, "DELETE", { clientId: crypto.randomUUID(), revision: view.contentRevision ?? 0 });
        expect(removed.status).toBe(scopeDenied ? 403 : 200);
        // Machine admin grant still needs admin scope to manage members.
        const memberDenied = scopeDenied || (machine && scope !== "admin");
        const added = await f.request(headers, `/${chat.shortId}/members`, "POST", { members: [{ type: "user", userId: newcomer.id }] });
        expect(added.status).toBe(memberDenied ? 403 : 200);
        const permission = await f.request(headers, `/${chat.shortId}/members/${chat.entries.get(target.id)}`, "PATCH", {
          permission: "read",
        });
        expect(permission.status).toBe(memberDenied ? 403 : 200);
        const revoked = await f.request(headers, `/${chat.shortId}/members/${chat.entries.get(target.id)}`, "DELETE");
        expect(revoked.status).toBe(memberDenied ? 403 : 200);
      });
    }
  }
  for (const scopes of [[], ["read"], ["write"]]) {
    test(`personal key/${scopes.join() || "empty"}: write grants permit edits and deletions; read grants retain reactions`, async () => {
      const owner = await f.person();
      const writer = await f.person();
      const chat = await f.fixture(owner, [{ person: writer, permission: "write" }]);
      const key = await apiKey(writer, "user_delegated", scopes[0] ?? "");
      const sent = await f.request(key.headers, `/${chat.shortId}/messages`, "POST", {
        clientId: crypto.randomUUID(),
        body: "own message",
      });
      expect(sent.status).toBe(201);
      const message = MessageViewSchema.parse(await sent.json());
      const path = `/${chat.shortId}/messages/${message.id}`;
      const edited = await f.request(key.headers, path, "PATCH", {
        clientId: crypto.randomUUID(),
        revision: message.contentRevision ?? 0,
        body: "edited",
      });
      expect(edited.status).toBe(200);
      const view = MessageViewSchema.parse(await edited.json());
      expect((await f.request(key.headers, `${path}/reactions/${encodeURIComponent("👍")}`, "PUT")).status).toBe(204);
      await sql`UPDATE auth.access SET permission = 'read' WHERE id = ${chat.entries.get(writer.id)}::uuid`;
      expect(
        (await f.request(key.headers, `/${chat.shortId}/messages`, "POST", { clientId: crypto.randomUUID(), body: "denied" })).status,
      ).toBe(403);
      expect(
        (
          await f.request(key.headers, path, "PATCH", {
            clientId: crypto.randomUUID(),
            revision: view.contentRevision ?? 0,
            body: "denied",
          })
        ).status,
      ).toBe(403);
      expect((await f.request(key.headers, `${path}/reactions/${encodeURIComponent("👍")}`, "PUT")).status).toBe(204);
      expect((await f.request(key.headers, `${path}/reactions/${encodeURIComponent("👍")}`, "DELETE")).status).toBe(204);
      expect(
        (await f.request(key.headers, path, "DELETE", { clientId: crypto.randomUUID(), revision: view.contentRevision ?? 0 })).status,
      ).toBe(403);
      await sql`UPDATE auth.access SET permission = 'write' WHERE id = ${chat.entries.get(writer.id)}::uuid`;
      expect(
        (await f.request(key.headers, path, "DELETE", { clientId: crypto.randomUUID(), revision: view.contentRevision ?? 0 })).status,
      ).toBe(200);
    });
  }
  test("an agent write scope never creates a conversation grant", async () => {
    const owner = await f.person();
    const chat = await f.fixture(owner);
    const key = await apiKey(owner, "agent", "write");
    const sent = await f.request(key.headers, `/${chat.shortId}/messages`, "POST", { clientId: crypto.randomUUID(), body: "no grant" });
    expect(sent.status).toBe(404);
  });
});
