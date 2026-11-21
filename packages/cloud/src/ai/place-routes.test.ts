import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { AuthContext } from "../server/middleware/auth";
import { buildProjectedUser } from "../services/session/user";
import * as place from "./place-assistant";
import { placeAssistantRoutes } from "./place-routes";

afterEach(() => mock.restore());

test("the navigation route validates the selector and calls the shared SSR loader", async () => {
  const load = spyOn(place, "loadPlaceAssistant").mockResolvedValue({ state: "none" });
  const user = buildProjectedUser({
    id: "00000000-0000-4000-8000-000000000001",
    provider: "local",
    profile: "user",
    effective_admin: false,
  });
  const app = new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("actor", { kind: "user", user });
      c.set("accessSubject", { type: "user", userId: user.id });
      await next();
    })
    .route("/api/ai/places", placeAssistantRoutes);
  const response = await app.request("/api/ai/places/place-fixture.conversation/marta");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ state: "none" });
  expect(load).toHaveBeenCalledTimes(1);
  expect(load.mock.calls[0]![1]).toEqual({ type: "place-fixture.conversation", id: "marta" });
  expect((await app.request("/api/ai/places/invalid/marta")).status).toBe(400);
  expect(load).toHaveBeenCalledTimes(1);
});
