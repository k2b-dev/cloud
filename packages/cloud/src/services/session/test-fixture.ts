import { Hono } from "hono";
import { session } from "./index";

/** Integration fixture: run with an isolated Core authority and its public JWKS endpoint. */
export const createTestSession = async (userId: string): Promise<string> => {
  const app = new Hono().post("/login", async (c) => c.json({ token: await session.create(c, userId) }));
  const response = await app.request("/login", { method: "POST" });
  if (response.status !== 200) throw new Error(`Session fixture login failed: ${response.status}`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("token" in body) || typeof body.token !== "string") {
    throw new Error("Session fixture did not return a token");
  }
  return body.token;
};
