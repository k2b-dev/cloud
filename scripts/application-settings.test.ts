import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import "../packages/assistant/src/config";
import "../packages/pulse/src/config";
import "../packages/filesv2/src/config";
import "../packages/notebooks/src/config";
import "../packages/gateway-ops/src/config";
import "../packages/mail/src/config";
import { createSettingsOpsRoutes } from "../packages/cloud/src/api/settings-ops";
import type { AuthContext } from "../packages/cloud/src/server";
import { buildProjectedUser } from "../packages/cloud/src/services/session/user";
import { settingsService } from "../packages/cloud/src/services/settings/app";

const ownerKeys = [
  "geo.api_key",
  "freeipa.ca_cert",
  "freeipa.sync_guard.max_user_changes",
  "freeipa.sync_guard.max_group_deletions",
  "user.category.guest.enabled",
  "user.category.guest.visible",
  "user.category.login.enabled",
  "user.category.login.visible",
  "user.category.login.label",
  "user.category.freeipa.enabled",
  "user.category.freeipa.visible",

  "assistant.rsql_url",
  "assistant.rsql_api_token",
  "assistant.rsql_allowed_targets",
  "assistant.storage_file_mib",
  "assistant.storage_total_mib",
  "pulse.clickhouse_connection",
  "pulse.max_bases",
  "pulse.max_raw_retention_days",
  "pulse.default_values_per_minute",
  "pulse.default_bytes_per_minute",
  "pulse.default_storage_bytes",
  "pulse.default_max_series",
  "pulse.default_max_event_kinds",
  "pulse.default_queries_per_hour",
  "pulse.default_max_state_keys",
  "pulse.base_creation",
  "pulse.default_profile",
  "filesv2.configuration",
  "notebooks.reindex_cron",
  "notebooks.snapshot_cron",
  "gateway.health_check_schedule",
  "mail.contact_directory.app",
  "mail.contact_directory.suggest",
  "mail.contact_directory.resolve",
  "mail.contact_directory.read",
  "mail.contact_directory.list_writable_books",
  "mail.contact_directory.create",
];

test("application-owned settings retain their owning write paths through the generic settings route", async () => {
  const update = spyOn(settingsService.entry, "update").mockResolvedValue({ ok: true, data: undefined });
  try {
    const user = buildProjectedUser({
      id: "11111111-1111-4111-8111-111111111111",
      provider: "local",
      profile: "user",
      effective_admin: true,
    });
    const app = new Hono<AuthContext>()
      .use("*", async (c, next) => {
        c.set("user", user);
        c.set("credentialKind", "session");
        return next();
      })
      .route("/", createSettingsOpsRoutes(ownerKeys));
    for (const key of ownerKeys) {
      const response = await app.request(`/${key}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "unvalidated" }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ message: "This setting must be changed through its application API" });
    }
    expect(update).not.toHaveBeenCalled();
  } finally {
    update.mockRestore();
  }
});
