import { afterAll, beforeAll, describe, expect } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { sql } from "bun";
import type { MiddlewareHandler } from "hono";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { startControlledDestructionJobs, stopControlledDestructionJobs } from "../service/controlled-destruction";
import { createBasesApi } from "./bases";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") {
    await migrate();
    await startControlledDestructionJobs();
  }
});
afterAll(() => stopControlledDestructionJobs());

describe("controlled destruction routes", () => {
  postgresTest("requires Base admin, accepts only public IDs, and starts an exact preview", async () => {
    const userId = testUuid();
    const baseId = testUuid();
    const accessId = testUuid();
    const tableId = testUuid();
    const fileId = testUuid();
    const baseShortId = testShortId("B");
    const tableShortId = testShortId("T");
    const fileShortId = testShortId("F");
    const user: User = {
      id: userId,
      uid: `destruction-${userId}`,
      roles: ["user"],
      provider: "local",
      profile: "user",
      givenname: "Destruction",
      sn: "Admin",
      displayName: "Destruction Admin",
      mail: null,
      avatarHash: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
      ipa: null,
    };
    const auth: MiddlewareHandler<AuthContext> = async (c, next) => {
      c.set("actor", { kind: "user", user });
      c.set("accessSubject", { type: "user", userId });
      c.set("user", user);
      await next();
    };
    const app = createBasesApi({ requireAuthenticated: auth });
    try {
      await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn) VALUES (${userId}::uuid, ${user.uid}, 'local', 'user', ${user.displayName}, ${user.givenname}, ${user.sn})`;
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'Destroy me exactly')`;
      await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Cases')`;
      await sql`INSERT INTO auth.access (id, user_id, permission) VALUES (${accessId}::uuid, ${userId}::uuid, 'read')`;
      await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${accessId}::uuid)`;
      await sql`INSERT INTO grids.retention_policies (base_id, minimum_days) VALUES (${baseId}::uuid, 30)`;
      await sql`
        INSERT INTO grids.files (id, short_id, filename, mime_type, size_bytes, sha256, bytes)
        VALUES (${fileId}::uuid, ${fileShortId}, 'orphan.txt', 'text/plain', 6, ${"a".repeat(64)}, ${new TextEncoder().encode("orphan")})
      `;
      await sql`
        INSERT INTO grids.file_retention_candidates (file_id, base_id, table_id, table_short_id, table_name, unreferenced_at)
        VALUES (${fileId}::uuid, ${baseId}::uuid, ${tableId}::uuid, ${tableShortId}, 'Cases', now() - interval '40 days')
      `;
      const path = `/${baseShortId}/controlled-destruction`;
      expect((await app.request(path)).status).toBe(403);
      await sql`UPDATE auth.access SET permission = 'admin' WHERE id = ${accessId}::uuid`;
      const overview = await app.request(path);
      expect(overview.status).toBe(200);
      const preview = (await overview.json()) as { preview: { observedAt: string; items: Array<{ fileId: string }> } };
      expect(preview.preview.items).toEqual([expect.objectContaining({ fileId: fileShortId })]);
      const wrong = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fileIds: [fileShortId],
          confirmation: "wrong",
        }),
      });
      expect(wrong.status).toBe(400);
      const started = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fileIds: [fileShortId],
          confirmation: "Destroy me exactly",
        }),
      });
      expect(started.status).toBe(201);
      const run = (await started.json()) as { id: string; baseId: string };
      expect(run.id).toMatch(/^[A-Za-z0-9]{6}$/);
      expect(run.baseId).toBe(baseShortId);
      const [storedRun] = await sql<Array<{ short_id: string; base_id: string }>>`
        SELECT short_id, base_id::text FROM grids.controlled_destruction_runs WHERE short_id = ${run.id}
      `;
      expect(storedRun).toMatchObject({ short_id: run.id, base_id: baseId });
      let status = "queued";
      for (let attempt = 0; attempt < 100 && ["queued", "running", "cancel_requested"].includes(status); attempt++) {
        const response = await app.request(`${path}/${run.id}`);
        if (response.status !== 200) throw new Error(`Run status returned ${response.status}: ${await response.text()}`);
        status = ((await response.json()) as { status: string }).status;
        if (["queued", "running", "cancel_requested"].includes(status)) await Bun.sleep(10);
      }
      expect(status).toBe("completed");
      expect((await app.request(`/${baseId}/controlled-destruction`)).status).toBe(404);
      expect((await app.request(`${path}/${testUuid()}`)).status).toBe(404);
    } finally {
      await sql`DELETE FROM grids.controlled_destruction_runs WHERE base_id = ${baseId}::uuid`;
      await sql`DELETE FROM grids.file_retention_candidates WHERE base_id = ${baseId}::uuid`;
      await sql`DELETE FROM grids.audit_log WHERE base_id = ${baseId}::uuid`;
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
      await sql`DELETE FROM grids.files WHERE id = ${fileId}::uuid`;
    }
  });
});
