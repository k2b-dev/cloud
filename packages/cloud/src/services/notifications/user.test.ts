import { expect, test } from "bun:test";

test("preferences expose localized exclusions, discard older selections, and reject excluded channels", async () => {
  const script = `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    import { UserNotificationPreferencesResponseSchema } from ${JSON.stringify(new URL("../../contracts/user-notifications.ts", import.meta.url).pathname)};
    const row = {
      id: "inventory.update", app_id: "inventory", kind: "update", label: "Update", description: "Updates.",
      recommended_channels: ["browser"], required_channels: [], excluded_channels: ["email"],
      excluded_reason: "Email for every update would be too much.",
      presentation: { baseLocale: "en", translations: { de: { excludedReason: "Jede Aktualisierung als E-Mail wäre zu viel." } } },
      customized: true, channels: ["email", "browser"],
    };
    let writes = 0;
    const sql = async (parts) => {
      const query = parts.join("?");
      if (query.includes("LEFT JOIN notifications.preferences")) {
        assert.ok(query.includes("d.excluded_channels"));
        assert.ok(query.includes("d.excluded_reason"));
        return [row];
      }
      if (query.includes("SELECT required_channels")) {
        assert.ok(query.includes("excluded_channels"));
        return [row];
      }
      if (query.includes("INSERT INTO notifications.preferences")) { writes++; return []; }
      if (query.includes("DELETE FROM notifications.preferences")) { row.customized = false; row.channels = null; return []; }
      throw new Error("Unexpected SQL: " + query);
    };
    globalThis.notificationUserSql = sql;
    Bun.plugin({ name: "notification-user-sql", setup(build) {
      build.onLoad({ filter: /[\\/]notifications[\\/]user\\.ts$/ }, async ({ path }) => ({
        contents: (await Bun.file(path).text()).replace('import { sql } from "bun";', 'const sql = globalThis.notificationUserSql;'), loader: "ts",
      }));
    }});
    mock.module(${JSON.stringify(new URL("./channels.ts", import.meta.url).pathname)}, () => ({ listNotificationChannels: () => ["browser", "email"] }));
    mock.module(${JSON.stringify(new URL("./quiet.ts", import.meta.url).pathname)}, () => ({ userQuietTimes: {} }));
    const { userNotifications } = await import(${JSON.stringify(new URL("./user.ts", import.meta.url).pathname)});
    for (const [locale, reason] of [["de-CH", "Jede Aktualisierung als E-Mail wäre zu viel."], ["fr", row.excluded_reason]]) {
      const response = UserNotificationPreferencesResponseSchema.parse(await userNotifications.preferences.list("user", locale));
      assert.deepEqual(response.availableChannels, ["browser", "email"]);
      assert.deepEqual(response.definitions[0].excludedChannels, ["email"]);
      assert.equal(response.definitions[0].excludedReason, reason);
      assert.deepEqual(response.definitions[0].selectedChannels, ["browser"]);
      assert.deepEqual(response.definitions[0].effectiveChannels, ["browser"]);
    }
    const rejected = await userNotifications.preferences.set({ userId: "user", definitionId: row.id, channels: [" browser ", " email "] });
    assert.deepEqual(rejected, { ok: false, status: 400, error: "Excluded notification channel: email" });
    assert.equal(writes, 0);
    assert.equal((await userNotifications.preferences.set({ userId: "user", definitionId: row.id, channels: ["browser"] })).ok, true);
    assert.equal(writes, 1);
    const reset = await userNotifications.preferences.reset({ userId: "user", definitionId: row.id, locale: "de" });
    assert.equal(reset.ok, true);
    assert.equal(reset.data.customized, false);
    assert.deepEqual(reset.data.selectedChannels, ["browser"]);
    row.excluded_channels = [];
    row.excluded_reason = null;
    row.presentation = null;
    assert.equal((await userNotifications.preferences.list("user")).definitions[0].excludedReason, null);
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
