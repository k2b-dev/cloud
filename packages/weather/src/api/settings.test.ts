import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { SettingUnreadableError } from "@k2b/cloud/services";
import { session } from "@k2b/cloud/services/session";
import { buildProjectedUser } from "@k2b/cloud/services/session/user";
import { SQL, sql } from "bun";
import { app } from "../config";
import { weatherSettingsRouter } from "./settings";

const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-02T03:04:05Z"));
const user = buildProjectedUser({
  id: "00000000-0000-4000-8000-000000000001",
  provider: "local",
  profile: "user",
  effective_admin: true,
});
const authenticate = spyOn(session, "authenticateRequest").mockResolvedValue({
  user,
  data: { userId: user.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: "2026-01-03T03:04:05.000Z" },
});
const key = "weather.default_lat";
const write = spyOn(app.settings, "set");
const tx = Object.assign(new SQL("postgres://localhost/unused_test"), {
  savepoint: () => {
    throw new Error("Unexpected savepoint");
  },
});
const begin = spyOn(sql, "begin").mockImplementation(async (run) => {
  if (typeof run !== "function") throw new Error("Expected transaction callback");
  await run(tx);
});
const request = (body: unknown) =>
  weatherSettingsRouter.request("/", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: "session_token=test" },
    body: JSON.stringify(body),
  });

beforeEach(() => write.mockReset().mockResolvedValue(undefined));
afterAll(async () => {
  for (const spy of [begin, write, authenticate, clock]) spy.mockRestore();
  await tx.close();
});

for (const explicit of [false, true]) {
  test(`Weather preserves unreadable conflicts for ${explicit ? "object" : "legacy record"} saves`, async () => {
    const error = new SettingUnreadableError(key);
    write.mockRejectedValue(error);
    const response = await request(explicit ? { updates: { [key]: 52 }, replaceUnreadable: [key] } : { [key]: 52 });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "setting_unreadable", message: error.message });
    expect(write).toHaveBeenCalledWith(key, 52, { replaceUnreadable: explicit });
  });
}

test("Weather replaces only the keys explicitly included in replaceUnreadable", async () => {
  const response = await request({ updates: { [key]: 52, "weather.default_lon": 13 }, replaceUnreadable: [key] });
  expect(response.status).toBe(204);
  expect(write).toHaveBeenCalledWith(key, 52, { replaceUnreadable: true });
  expect(write).toHaveBeenCalledWith("weather.default_lon", 13, { replaceUnreadable: false });
});

for (const body of [
  { updates: {}, replaceUnreadable: [key] },
  { updates: { [key]: 52 }, replaceUnreadable: ["grids.foreign"] },
  { updates: { "weather.unknown": 52 }, replaceUnreadable: ["weather.unknown"] },
  { updates: { [key]: 52 }, replaceUnreadable: [key], extra: true },
  { updates: { [key]: 52 }, replaceUnreadable: true },
  { updates: {}, replaceUnreadable: ["__proto__"] },
  { "grids.foreign": 52 },
]) {
  test(`Weather rejects invalid replacement input: ${JSON.stringify(body)}`, async () => {
    expect((await request(body)).status).toBe(400);
    expect(write).not.toHaveBeenCalled();
  });
}

test("Weather still accepts legacy record updates without replacement", async () => {
  expect((await request({ [key]: 52 })).status).toBe(204);
  expect(write).toHaveBeenCalledWith(key, 52, { replaceUnreadable: false });
});
