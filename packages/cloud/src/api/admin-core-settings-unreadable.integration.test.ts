import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { redis, sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { session } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
import * as settings from "../services/settings";
import { encryptValue } from "../services/settings/crypto";
import { registerSettings } from "../services/settings/defaults";
import routes from "./admin-core-settings";

const suite = suiteFor("database", "valkey");
const key = `test.bulk_unreadable_${crypto.randomUUID().replaceAll("-", "")}`;
const otherKey = `${key}.other`;
registerSettings([
  { key, kind: "url", default: "", description: "Test only.", label: "Bulk unreadable probe", group: "test" },
  { key: otherKey, kind: "string", default: "", description: "Test only.", label: "Readable bulk probe", group: "test" },
]);

suite("bulk save unreadable settings", () => {
  const restores: Array<{ mockRestore(): void }> = [];
  let ciphertext: string;
  const stamp = "2026-01-02T03:04:05.000Z";
  beforeEach(async () => {
    restores.push(spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-02T03:04:05Z")));
    ciphertext = await encryptValue("invalid url");
    await sql`INSERT INTO settings.entries (key, value, updated_at) VALUES (${key}, ${ciphertext}, ${stamp}::timestamptz)
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at`;
    await sql`INSERT INTO settings.entries (key,value,updated_at) VALUES (${otherKey},${await encryptValue("before")},${stamp}::timestamptz)
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at`;
    await redis.del(`settings:${key}`, `settings:${otherKey}`);
    const user = buildProjectedUser({
      id: "00000000-0000-4000-8000-000000000003",
      provider: "local",
      profile: "user",
      effective_admin: true,
    });
    restores.push(
      spyOn(session, "authenticateRequest").mockResolvedValue({
        user,
        data: { userId: user.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00.000Z" },
      }),
    );
  });
  afterEach(() => {
    for (const spy of restores.splice(0)) spy.mockRestore();
  });
  afterAll(async () => {
    await settings.remove(key);
    await settings.remove(otherKey);
  });
  const save = (body: unknown, locale = "en") =>
    routes.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Accept-Language": locale, Cookie: "session_token=test" },
      body: JSON.stringify(body),
    });
  test.each(["en", "de"])("refuses the whole save with a localized field error (%s)", async (locale) => {
    const response = await save({ updates: { [key]: "https://replacement.test", [otherKey]: "after" } }, locale);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("setting_unreadable");
    expect(body.errors[key]).toContain(locale === "de" ? "nicht gelesen" : "cannot be read");
    const [row] = await sql<{ value: string; updated_at: Date }[]>`SELECT value, updated_at FROM settings.entries WHERE key=${key}`;
    expect(row?.value).toBe(ciphertext);
    expect(row?.updated_at.toISOString()).toBe(stamp);
    expect(await settings.get<string>(otherKey)).toBe("before");
  });
  test("explicit replacement saves a readable value", async () => {
    expect((await save({ updates: { [key]: "https://replacement.test" }, replaceUnreadable: [key] })).status).toBe(204);
    expect(await settings.read(key)).toEqual({ stored: "readable", value: "https://replacement.test" });
  });
  test("an unreadable setting can be reset without explicit replacement", async () => {
    expect((await save({ resets: [key] })).status).toBe(204);
    expect(await settings.read(key)).toEqual({ stored: "none", value: "" });
  });
  test("replacement must name an update", async () => {
    const response = await save({ replaceUnreadable: [key] });
    expect(response.status).toBe(400);
    expect((await response.json()).errors[key]).toContain("updates");
  });
});
