import { beforeAll, expect, spyOn, test } from "bun:test";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { sql } from "../runtime/clients";
import { useRegisteredTestApp } from "../services/identity/application.test-fixture";
import { createTestSession } from "../services/session/session.test-fixture";
import { migrateCloudAi } from "./migrate";
import * as places from "./place-assistant";
import { aiRoutes } from "./routes";
import { aiConversations } from "./store";

databaseSuite()("place chat creation route", () => {
  useRegisteredTestApp("core", { kind: "signedIn" });
  beforeAll(migrateCloudAi);

  test("the first message binds the personal chat, reuses it, and restart creates a fresh one", async () => {
    const users: string[] = [];
    const load = spyOn(places, "loadPlaceAssistant");
    const ref = { type: "place-fixture.conversation", id: "marta" };
    const available: places.PlaceAssistantState = {
      state: "available",
      ref,
      title: "Marta Example",
      typeTitle: "Conversation",
      app: { id: "place-fixture", name: "Fixture", icon: null },
      tools: [],
      skills: [],
      starters: [],
      conversationId: null,
      conversation: null,
    };
    load.mockResolvedValue(available);
    try {
      for (const name of ["Lea", "Ben"]) {
        const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
          VALUES (${`place-route-${name}-${crypto.randomUUID()}`}, 'local', 'user', ${name}) RETURNING id`;
        users.push(user!.id);
      }
      const token = await createTestSession(users[0]!);
      const ben = await createTestSession(users[1]!);
      const post = (body: unknown, credential = token) =>
        aiRoutes.request("/conversations", {
          method: "POST",
          headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      expect((await post({ place: ref })).status).toBe(400);
      expect(await aiConversations.findPlaceConversation({ ownerUserId: users[0]!, ref })).toBeNull();
      const body = { place: ref, draft: { content: [{ type: "text", text: "Shorten the reply." }] } };
      load.mockResolvedValueOnce({ state: "consent_required" });
      expect((await post(body)).status).toBe(403);
      expect(await aiConversations.findPlaceConversation({ ownerUserId: users[0]!, ref })).toBeNull();
      const first = await post(body);
      expect(first.status).toBe(201);
      const chat = await first.json();
      expect(chat.place).toEqual({ ref, title: "Marta Example" });
      expect((await (await post(body)).json()).id).toBe(chat.id);
      expect((await (await post(body, ben)).json()).id).not.toBe(chat.id);
      const archived = await aiRoutes.request(`/conversations/${chat.id}/archive`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(archived.status).toBe(200);
      expect((await (await post(body)).json()).id).not.toBe(chat.id);
    } finally {
      load.mockRestore();
      for (const user of users) {
        await sql`DELETE FROM ai.conversations WHERE created_by_user_id = ${user}::uuid`;
        await sql`DELETE FROM auth.users WHERE id = ${user}::uuid`;
      }
    }
  });
});
