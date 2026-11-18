import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { AuthContext } from "../server";
import { userResourceContext } from "./projects.test-fixture";
import { aiWakeupRoutes } from "./wakeup-routes";
import { AiWakeupError, aiWakeups } from "./wakeups";

const owner = userResourceContext({ type: "user", userId: "5b000000-0000-4000-8000-000000000001" });
const id = "5b000000-0000-4000-8000-000000000002";
const path = "/Ab3dEf/wakeups";
const app = (credential: "session" | "api_key" = "session") =>
  new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("actor", owner.actor);
      c.set("accessSubject", owner.accessSubject);
      c.set("credentialKind", credential);
      await next();
    })
    .route("/", aiWakeupRoutes);
const request = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json", "x-cloud-locale": "de" },
  body: JSON.stringify(body),
});
afterEach(() => mock.restore());

test("list returns the UI snapshot directly and retains actor plus grant subject", async () => {
  const list = spyOn(aiWakeups, "list").mockResolvedValue({ items: [], limit: 5, paused: true });
  const response = await app().request(path, { headers: { "x-cloud-locale": "de" } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ items: [], limit: 5, paused: true });
  expect(list).toHaveBeenCalledWith("Ab3dEf", owner, "de");
});

test("mutation requires a browser session, before reaching the service", async () => {
  const create = spyOn(aiWakeups, "create");
  const response = await app("api_key").request(path, request("POST", { at: "2026-11-19T12:00:00Z", note: "Prüfen", timezone: "UTC" }));
  expect(response.status).toBe(403);
  expect(create).not.toHaveBeenCalled();
});

test("edit validates the alarm ID and revision at the HTTP boundary", async () => {
  const update = spyOn(aiWakeups, "update");
  expect((await app().request(`${path}/${id}`, request("PATCH", { note: "Neue Notiz" }))).status).toBe(400);
  expect((await app().request(`${path}/other`, request("PATCH", { revision: 0, note: "Neue Notiz" }))).status).toBe(400);
  expect(update).not.toHaveBeenCalled();
});

test("optimistic conflicts use a stable code and request-localized recovery text", async () => {
  spyOn(aiWakeups, "update").mockRejectedValue(new AiWakeupError("conflict", "Changed"));
  const response = await app().request(`${path}/${id}`, request("PATCH", { revision: 0, note: "Neue Notiz" }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    code: "wakeup_conflict",
    message: "Der Wecker wurde geändert. Öffne die Liste vor dem Speichern erneut.",
  });
});
