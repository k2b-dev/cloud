import { Hono } from "hono";
import { sql } from "bun";
import { session } from "./index";

/** Integration fixture: run with an isolated Core authority and its public JWKS endpoint. */
export const createTestSession = async (userId: string): Promise<string> => {
  // Most session fixtures represent established users, not first-use onboarding.
  await sql`INSERT INTO auth.legal_acceptances (user_id, session_id, document_version, documents)
    VALUES (${userId}::uuid, ${crypto.randomUUID()}::uuid, 'test-fixture', '[]'::jsonb) ON CONFLICT DO NOTHING`;
  const app = new Hono().post("/login", async (c) => c.json({ token: await session.create(c, userId) }));
  const response = await app.request("/login", { method: "POST" });
  if (response.status !== 200) throw new Error(`Session fixture login failed: ${response.status}`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("token" in body) || typeof body.token !== "string") {
    throw new Error("Session fixture did not return a token");
  }
  return body.token;
};
