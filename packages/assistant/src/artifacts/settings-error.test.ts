import { expect, spyOn, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { SettingUnreadableError } from "@k2b/cloud/services";
import { Hono } from "hono";
import { createArtifactServiceRoutes } from "./api";
import { artifactDatabase } from "./database";
import { storageSettings } from "./storage-settings";
import { testIdentity } from "./test-identity";

test("storage and database settings preserve unreadable 409 errors through the Assistant API", async () => {
  const identity = testIdentity("00000000-0000-4000-8000-000000000001");
  const storageError = new SettingUnreadableError("assistant.storage_file_mib");
  const databaseError = new SettingUnreadableError("assistant.rsql_url");
  const storage = spyOn(storageSettings, "write").mockRejectedValue(storageError);
  const database = spyOn(artifactDatabase, "configure").mockRejectedValue(databaseError);
  const api = new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("actor", identity.actor);
      c.set("accessSubject", identity.accessSubject);
      c.set("credentialKind", "session");
      await next();
    })
    .route("/", createArtifactServiceRoutes());
  try {
    for (const [path, value, error] of [
      ["/admin/storage/settings", { fileMiB: 50, totalMiB: 250 }, storageError],
      ["/admin/database/settings", { url: "http://rsql.test", token: "test-token" }, databaseError],
    ] as const) {
      const response = await api.request(path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "setting_unreadable", message: error.message });
    }
  } finally {
    storage.mockRestore();
    database.mockRestore();
  }
});
