import { beforeAll, expect, test } from "bun:test";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { sql } from "../runtime/clients";
import { useRegisteredTestApp } from "../services/identity/application.test-fixture";
import { session } from "../services/session";
import { createTestSession } from "../services/session/session.test-fixture";
import { migrateCloudAi } from "./migrate";
import { aiRoutes } from "./routes";
import { aiConversations } from "./store";

suiteFor("database", "valkey")("place chat list API", () => {
  useRegisteredTestApp("core", { kind: "signedIn" });
  beforeAll(migrateCloudAi);
  test("list and page default to ordinary chats; exact place filters, counts and streams stay personal", async () => {
    const users: string[] = [];
    const tokens: string[] = [];
    try {
      for (const name of ["Lea", "Ben"]) {
        const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name)
          VALUES (${`place-routes-${name}-${crypto.randomUUID()}`}, 'local', 'user', ${name}) RETURNING id`;
        users.push(row!.id);
        tokens.push(await createTestSession(row!.id));
      }
      const lea = users[0]!;
      const ben = users[1]!;
      const headers = (index: number) => ({ Authorization: `Bearer ${tokens[index]}` });
      const place = { ref: { type: "fixture.conversation", id: "Marta1" }, title: "Marta" };
      const chat = await aiConversations.createPlaceConversation({ ownerUserId: lea, place, draft: [{ type: "text", text: "Help" }] });
      const normal = await aiConversations.createConversation({ ownerUserId: lea, title: "Ordinary" });
      await sql`UPDATE ai.conversations SET background_received_at='2026-11-08T00:00:00Z' WHERE id=${chat.id}::uuid`;
      for (const endpoint of ["/conversations", "/conversations/page"]) {
        const ordinary = await aiRoutes.request(endpoint, { headers: headers(0) });
        expect(ordinary.status).toBe(200);
        const ordinaryBody = await ordinary.json();
        expect(endpoint.endsWith("page") ? ordinaryBody.items : ordinaryBody).toMatchObject([{ id: normal.shortId, place: null }]);
        for (const filter of ["any", "fixture.conversation:Marta1"]) {
          const response = await aiRoutes.request(`${endpoint}?place=${filter}`, { headers: headers(0) });
          expect(response.status).toBe(200);
          const body = await response.json();
          expect(endpoint.endsWith("page") ? body.items : body).toMatchObject([{ id: chat.shortId, place }]);
          if (endpoint.endsWith("page")) expect(body.total).toBe(1);
          const denied = await aiRoutes.request(`${endpoint}?place=${filter}`, { headers: headers(1) });
          const deniedBody = await denied.json();
          expect(endpoint.endsWith("page") ? deniedBody.items : deniedBody).toEqual([]);
          if (endpoint.endsWith("page")) expect(deniedBody.total).toBe(0);
        }
        expect((await aiRoutes.request(`${endpoint}?place=invalid`, { headers: headers(0) })).status).toBe(400);
      }
      const count = await aiRoutes.request("/conversations/counts", { headers: headers(0) });
      expect(await count.json()).toMatchObject({ unread: 1, places: { total: 1, unread: 1 } });
      const benCount = await aiRoutes.request("/conversations/counts", { headers: headers(1) });
      expect(await benCount.json()).toEqual({ unread: 0, needsAttention: 0, places: { total: 0, unread: 0, needsAttention: 0 } });
      const deniedStream = await aiRoutes.request(`/conversations/${chat.shortId}/stream`, { headers: headers(1) });
      expect(deniedStream.status).toBe(404);
      expect(deniedStream.headers.get("Content-Type")).not.toContain("text/event-stream");
      expect(await aiConversations.findPlaceConversation({ ownerUserId: ben, ref: place.ref })).toBeNull();
    } finally {
      for (const token of tokens) await session.revoke(token);
      for (const user of users) {
        await sql`DELETE FROM ai.conversations WHERE created_by_user_id=${user}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${user}::uuid`;
      }
    }
  });
});
