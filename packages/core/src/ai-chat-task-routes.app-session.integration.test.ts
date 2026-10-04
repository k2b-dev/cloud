import { afterAll, expect, test } from "bun:test";
import { createTestAppSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import { aiChatTaskRoutes } from "./ai-chat-task-routes";

const suite = suiteFor("database", "nats", "valkey");
const users: string[] = [];

suite("scheduled tasks and the mobile app", () => {
  afterAll(async () => {
    for (const id of users) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  // A scheduled task holds a background mandate, which would keep acting after the phone is removed.
  test("an app session cannot create, change or resume a scheduled task", async () => {
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${`task-app-${crypto.randomUUID()}`}, 'local', 'user', 'Task Phone') RETURNING id`;
    users.push(user!.id);
    const { token } = await createTestAppSession(user!.id);
    const send = (method: string, path: string, body?: unknown) =>
      aiChatTaskRoutes.request(path, {
        method,
        headers: {
          cookie: `pwa_session=${token}`,
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
          "x-forwarded-for": uniqueCallerAddress(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const taskId = "tSk234";
    for (const response of [
      await send("POST", "/tasks", { chatId: "cHt234", prompt: "Remind me.", schedule: { kind: "cron", cron: "0 9 * * 1" } }),
      await send("PATCH", `/tasks/${taskId}`, { prompt: "Wider." }),
      await send("POST", `/tasks/${taskId}/resume`),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "FORBIDDEN", message: "Use Cloud on the web for this." });
    }
  });
});
