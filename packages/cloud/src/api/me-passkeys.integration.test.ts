import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { Hono } from "hono";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import type { AuthContext } from "../server";
import { session } from "../services/session";
import * as settings from "../services/settings";
import meRoutes from "./me";

const suite = databaseSuite();
let router: Hono<AuthContext>;
let issueFor = "";

const insertUser = async (label: string) => {
  const id = crypto.randomUUID();
  await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${id}::uuid, ${`${label}-${id}`}, 'local', 'user')`;
  return id;
};
/** A real signed browser session through the production session service, past first-login consent. */
const signIn = async (userId: string) => {
  issueFor = userId;
  const token = (await (await router.request("/issue", { method: "POST" })).json()).token as string;
  await sql`UPDATE auth.session_families SET legal_pending = false WHERE user_id = ${userId}::uuid`;
  return token;
};
/** Stored exactly as registration stores it: the primary key comes from the database default. */
const insertPasskey = async (userId: string, name: string) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.webauthn_credentials (user_id, name, credential_id, public_key)
    VALUES (${userId}::uuid, ${name}, ${crypto.randomUUID()}, ${Buffer.from("fixture-key")})
    RETURNING id`;
  return row!.id;
};
const remove = (token: string, id: string) =>
  router.request(`/api/me/passkeys/${id}`, { method: "DELETE", headers: { Cookie: `session_token=${token}` } });
const exists = async (id: string) => (await sql`SELECT 1 FROM auth.webauthn_credentials WHERE id = ${id}::uuid`).length > 0;
const deleteAudits = (id: string) =>
  sql<{ outcome: string; error_code: string | null }[]>`
    SELECT outcome, error_code FROM audit.events
    WHERE action = 'webauthn_credential.delete' AND target_id = ${id} ORDER BY id`;

suite("DELETE /api/me/passkeys/:id (isolated Postgres and Valkey)", () => {
  beforeAll(async () => {
    await settings.set("security.rate_limit_per_second", 1000);
    router = new Hono<AuthContext>()
      .post("/issue", async (c) => c.json({ token: await session.create(c, issueFor) }))
      .route("/api/me", meRoutes);
  });

  test("deletes an owned passkey by the id the list returns, and audits it", async () => {
    const userId = await insertUser("owner");
    const token = await signIn(userId);
    const kept = await insertPasskey(userId, "Phone");
    const removed = await insertPasskey(userId, "Laptop");
    const list = await router.request("/api/me/passkeys", { headers: { Cookie: `session_token=${token}` } });
    const listedId = ((await list.json()) as { items: { id: string; name: string }[] }).items.find((item) => item.name === "Laptop")?.id;
    expect(listedId).toBe(removed);

    const response = await remove(token, listedId!);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "Passkey deleted." });
    expect(await exists(removed)).toBe(false);
    expect(await exists(kept)).toBe(true);
    expect(await deleteAudits(removed)).toEqual([{ outcome: "allowed", error_code: null }]);

    const again = await remove(token, removed);
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ message: "Passkey not found", code: "NOT_FOUND" });
  });

  test("a foreign passkey stays 404 and untouched", async () => {
    const owner = await insertUser("victim");
    const foreign = await insertPasskey(owner, "Victim key");
    const token = await signIn(await insertUser("other"));

    const response = await remove(token, foreign);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Passkey not found", code: "NOT_FOUND" });
    expect(await exists(foreign)).toBe(true);
    expect(await deleteAudits(foreign)).toEqual([{ outcome: "failed", error_code: "NOT_FOUND" }]);
  });

  test("a malformed id is 404 without reaching the database cast", async () => {
    const token = await signIn(await insertUser("malformed"));
    const response = await remove(token, "not-a-uuid");
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("NOT_FOUND");
  });

  test("an unauthenticated request is 401", async () => {
    const response = await router.request(`/api/me/passkeys/${crypto.randomUUID()}`, { method: "DELETE" });
    expect(response.status).toBe(401);
  });
});
