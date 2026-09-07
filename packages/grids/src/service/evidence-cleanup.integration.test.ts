import { expect, test } from "bun:test";
import { SQL } from "bun";

const enabled = process.env.GRIDS_EVIDENCE_CLEANUP_DB_TEST === "1";
const databaseName = process.env.GRIDS_EVIDENCE_CLEANUP_DB_CHILD;

if (!databaseName) {
  (enabled ? test : test.skip)(
    "evidence retention drains a backlog in isolated Postgres",
    async () => {
      const url = new URL(process.env.DATABASE_URL!);
      if (!["localhost", "127.0.0.1", "ipa_postgres"].includes(url.hostname)) throw new Error("Requires local Postgres");
      const database = `grids_cleanup_${crypto.randomUUID().replaceAll("-", "")}`;
      const target = new URL(url);
      target.pathname = `/${database}`;
      url.pathname = "/postgres";
      const admin = new SQL(url);
      let created = false;
      try {
        await admin.unsafe(`CREATE DATABASE "${database}"`);
        created = true;
        const child = Bun.spawn([process.execPath, "test", import.meta.path], {
          env: { ...process.env, DATABASE_URL: target.toString(), GRIDS_EVIDENCE_CLEANUP_DB_CHILD: database },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
      } finally {
        if (created) await admin.unsafe(`DROP DATABASE "${database}"`);
        await admin.close({ timeout: 5 });
      }
    },
    60_000,
  );
} else {
  test("scheduled cleanup drains more than 100 exports; UI stays bounded and cancellation preserves remaining work", async () => {
    if (!enabled || !/^grids_cleanup_[a-f0-9]{32}$/.test(databaseName)) throw new Error("Unexpected isolated database");
    const { sql } = await import("bun");
    try {
      const [database] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
      expect(database?.name).toBe(databaseName);
      await sql`CREATE SCHEMA auth`.simple();
      await sql`CREATE TABLE auth.users (id UUID PRIMARY KEY)`.simple();
      await sql`CREATE TABLE auth.access (id UUID PRIMARY KEY)`.simple();
      await sql`CREATE TABLE auth.service_accounts (id UUID PRIMARY KEY)`.simple();
      const { migrate: migrateWorkflows } = await import("../../../core/src/migrate/core/workflows");
      const { migrate } = await import("../migrate");
      await migrateWorkflows();
      await migrate();
      const { cleanupExpiredEvidenceExports, expireCompletedExports } = await import("./evidence-exports");
      const baseId = crypto.randomUUID();
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, 'cln001', 'Cleanup fixture')`;
      const seed = async () => {
        await sql`DELETE FROM grids.evidence_exports`;
        await sql`
          INSERT INTO grids.evidence_exports (
            id, short_id, base_id, sections, status, requested_at, expires_at, package_filename, package_size_bytes,
            package_sha256, manifest_sha256, manifest
          )
          SELECT gen_random_uuid(), lpad(position::text, 6, '0'), ${baseId}::uuid, ARRAY['records'], 'completed',
            now() - ((207 - position) * interval '1 hour'),
            CASE WHEN position = 206 THEN now() + interval '1 day' ELSE now() - ((206 - position) * interval '1 hour') END,
            'fixture.tar', 3, repeat('a', 64), repeat('b', 64), '{}'::jsonb
          FROM generate_series(1, 206) AS position
        `;
        await sql`
          INSERT INTO grids.evidence_export_chunks (export_id, sequence, bytes)
          SELECT id, 0, ${new TextEncoder().encode("tar")} FROM grids.evidence_exports
        `;
      };
      const remaining = async () => {
        const [row] = await sql<{ expired: number; remaining: number; chunks: number }[]>`
          SELECT count(*) FILTER (WHERE status = 'expired')::int AS expired,
            count(*) FILTER (WHERE status = 'completed' AND expires_at <= now())::int AS remaining,
            (SELECT count(*)::int FROM grids.evidence_export_chunks) AS chunks
          FROM grids.evidence_exports
        `;
        return row;
      };
      await seed();
      let heartbeats = 0;
      await cleanupExpiredEvidenceExports({
        signal: new AbortController().signal,
        heartbeat: async () => {
          heartbeats++;
        },
      });
      expect(await remaining()).toEqual({ expired: 205, remaining: 0, chunks: 1 });
      expect(heartbeats).toBeGreaterThan(0);

      await seed();
      await expireCompletedExports(baseId);
      expect(await remaining()).toEqual({ expired: 100, remaining: 105, chunks: 106 });
      const expired = await sql<
        { short_id: string }[]
      >`SELECT short_id FROM grids.evidence_exports WHERE status = 'expired' ORDER BY short_id`;
      expect(expired.map((row) => row.short_id)).toEqual(Array.from({ length: 100 }, (_, index) => String(index + 1).padStart(6, "0")));

      const controller = new AbortController();
      await expect(
        cleanupExpiredEvidenceExports({
          signal: controller.signal,
          heartbeat: async () => {
            controller.abort();
          },
        }),
      ).rejects.toThrow();
      expect(await remaining()).toEqual({ expired: 101, remaining: 104, chunks: 105 });
      await cleanupExpiredEvidenceExports({ signal: new AbortController().signal, heartbeat: async () => undefined });
      expect(await remaining()).toEqual({ expired: 205, remaining: 0, chunks: 1 });
    } finally {
      await sql.close({ timeout: 5 });
    }
  }, 60_000);
}
