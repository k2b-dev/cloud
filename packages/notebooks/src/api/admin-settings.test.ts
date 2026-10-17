import { expect, spyOn, test } from "bun:test";
import { settingsService, SettingUnreadableError } from "@k2b/cloud/services";
import { session } from "@k2b/cloud/services/session";
import { buildProjectedUser } from "@k2b/cloud/services/session/user";
import { ok } from "@k2b/stdlib";

// Match the Book API tests: isolate import-time middleware and the SSR plugin.
if (process.env.NOTEBOOKS_ADMIN_SETTINGS_TEST !== "1") {
  test("Notebooks admin settings replacement contract", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, NOTEBOOKS_ADMIN_SETTINGS_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await child.exited;
      }
    }
  }, 30_000);
} else {
  await import("../frontend/[id]/_components/detail/ssr-test-plugin");
  const server = await import("@k2b/cloud/server");
  const limit = spyOn(server, "rateLimit").mockReturnValue(async (_c, next) => next());
  const { default: router } = await import("./index");
  const { snapshotRuntime } = await import("../service/backup");
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
  const update = spyOn(settingsService.entry, "update");
  const reschedule = spyOn(snapshotRuntime, "reschedule").mockResolvedValue(undefined);

  test("Notebooks forwards replacement through ordinary and snapshot-cron writes without swallowing 409", async () => {
    try {
      for (const [key, value] of [
        ["notebooks.max_attachment_size_mb", 50],
        ["notebooks.snapshot_cron", "0 3 * * *"],
      ] as const) {
        const request = (replaceUnreadable?: boolean) =>
          router.request(`/admin/settings/${key}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", Cookie: "session_token=test" },
            body: JSON.stringify({ value, replaceUnreadable }),
          });
        const error = new SettingUnreadableError(key);
        update.mockRejectedValue(error);
        const response = await request();
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ code: "setting_unreadable", message: error.message });
        expect(update).toHaveBeenLastCalledWith({ key, value, replaceUnreadable: undefined });
        expect(reschedule).not.toHaveBeenCalled();

        update.mockResolvedValue(ok(undefined));
        expect((await request(true)).status).toBe(200);
        expect(update).toHaveBeenLastCalledWith({ key, value, replaceUnreadable: true });
        if (key === "notebooks.snapshot_cron") expect(reschedule).toHaveBeenCalledWith(value);
      }
    } finally {
      for (const spy of [reschedule, update, authenticate, clock, limit]) spy.mockRestore();
    }
  });
}
