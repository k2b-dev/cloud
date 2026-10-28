import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { SQL, sql } from "bun";
import { session } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
import * as settings from "../services/settings";
import routes from "./admin-core-settings";

const key = "app.name";
const restores: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  restores.push(spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-02T03:04:05Z")));
  const user = buildProjectedUser({
    id: "00000000-0000-4000-8000-000000000003",
    provider: "local",
    profile: "user",
    effective_admin: true,
  });
  restores.push(
    spyOn(session, "authenticateRequest").mockResolvedValue({
      user,
      data: { userId: user.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: "2026-01-03T03:04:05.000Z" },
    }),
  );
});
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore.mockRestore();
});
const save = (body: unknown, locale = "en") =>
  routes.request("/", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Accept-Language": locale, Cookie: "session_token=test" },
    body: JSON.stringify(body),
  });
test.each(["en", "de"])("unreadable preflight rejects before any transaction (%s)", async (locale) => {
  const read = spyOn(settings, "readStates").mockResolvedValue(new Map([[key, { stored: "unreadable", value: "fallback" }]]));
  const write = spyOn(settings, "set").mockRejectedValue(new Error("Must not write"));
  const begin = spyOn(sql, "begin").mockRejectedValue(new Error("Must not begin"));
  restores.push(read, write, begin);
  const response = await save({ updates: { [key]: "New name" } }, locale);
  expect(response.status).toBe(409);
  const body = await response.json();
  expect(body.code).toBe("setting_unreadable");
  expect(body.errors[key]).toContain(locale === "de" ? "nicht gelesen" : "cannot be read");
  expect(read).toHaveBeenCalledWith([key]);
  expect(write).not.toHaveBeenCalled();
  expect(begin).not.toHaveBeenCalled();
});
test.each([key, "constructor"])("replacement %s must name an own update even on an empty save", async (replacementKey) => {
  const read = spyOn(settings, "readStates").mockRejectedValue(new Error("Must not read"));
  restores.push(read);
  const response = await save({ replaceUnreadable: [replacementKey] });
  expect(response.status).toBe(400);
  expect((await response.json()).errors[replacementKey]).toContain("updates");
  expect(read).not.toHaveBeenCalled();
});
test("a row becoming unreadable after preflight keeps its field-level 409", async () => {
  const tx = Object.assign(new SQL("postgres://localhost/unused_test"), {
    savepoint: () => {
      throw new Error("Unexpected savepoint");
    },
  });
  const read = spyOn(settings, "readStates").mockResolvedValue(new Map([[key, { stored: "readable", value: "Old name" }]]));
  const write = spyOn(settings, "set").mockRejectedValue(new settings.SettingUnreadableError(key));
  const begin = spyOn(sql, "begin").mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected callback");
    await run(tx);
  });
  restores.push(read, write, begin);
  try {
    const response = await save({ updates: { [key]: "New name" } });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("setting_unreadable");
    expect(body.errors[key]).toContain("cannot be read");
    expect(write).toHaveBeenCalledWith(key, "New name", tx, { replaceUnreadable: false });
  } finally {
    await tx.close();
  }
});

// Version preconditions describe exactly the settings being saved.
test.each(["legacy.setting", "ai.firecrawl_api_key", "app.locale"])(
  "rejects unrelated version key %s before reading settings",
  async (versionKey) => {
    const read = spyOn(settings, "readStates").mockRejectedValue(new Error("Must not read"));
    restores.push(read);
    for (const updates of [{}, { [key]: "New name" }]) {
      const response = await save({ updates, expectedUpdatedAt: { [versionKey]: null } });
      expect(response.status).toBe(400);
      expect((await response.json()).errors[versionKey]).toContain("updates or resets");
    }
    expect(read).not.toHaveBeenCalled();
  },
);
