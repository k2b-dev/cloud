import { expect, test } from "bun:test";
import { SQL } from "bun";

// This suite never migrates the configured development database. The parent
// creates a unique database and runs the real global Bun.sql migration there.
const enabled = process.env.NOTEBOOKS_SCRIPT_REMOVAL_DB_TEST === "1";
const scenario = process.env.NOTEBOOKS_SCRIPT_REMOVAL_SCENARIO;
const databasePrefix = "notebooks_script_removal_";

if (!scenario) {
  const postgresTest = enabled ? test : test.skip;
  for (const mode of ["fresh", "upgrade"] as const) {
    postgresTest(
      `script removal migration: isolated ${mode} schema`,
      async () => {
        const source = process.env.DATABASE_URL;
        if (!source) throw new Error("DATABASE_URL is required");
        const url = new URL(source);
        if (!["localhost", "127.0.0.1", "ipa_postgres"].includes(url.hostname)) {
          throw new Error("Migration regression requires the local development Postgres server");
        }
        const databaseName = `${databasePrefix}${crypto.randomUUID().replaceAll("-", "")}`;
        const databaseUrl = new URL(url);
        databaseUrl.pathname = `/${databaseName}`;
        url.pathname = "/postgres";
        const admin = new SQL(url);
        let created = false;
        try {
          await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
          created = true;
          const child = Bun.spawn([process.execPath, "test", import.meta.path], {
            env: {
              ...process.env,
              DATABASE_URL: databaseUrl.toString(),
              NOTEBOOKS_SCRIPT_REMOVAL_SCENARIO: mode,
              NOTEBOOKS_SCRIPT_REMOVAL_DATABASE: databaseName,
            },
            stdout: "pipe",
            stderr: "pipe",
          });
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          // Do not include connection configuration in failures.
          expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
        } finally {
          if (created) {
            await admin.unsafe(`DROP DATABASE "${databaseName}"`);
            const remaining = await admin<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname = ${databaseName}`;
            expect(remaining).toEqual([]);
          }
          await admin.close({ timeout: 5 });
        }
      },
      60_000,
    );
  }
} else {
  test(`${scenario}: removes only the execution flag and is repeatable`, async () => {
    const { sql } = await import("bun");
    const databaseName = process.env.NOTEBOOKS_SCRIPT_REMOVAL_DATABASE;
    if (!enabled || !databaseName || !new RegExp(`^${databasePrefix}[a-f0-9]{32}$`).test(databaseName)) {
      throw new Error("Isolated migration child requires an exact generated database name");
    }
    const [database] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
    if (database?.name !== databaseName) throw new Error("Refusing to migrate an unexpected database");
    try {
      await sql`CREATE SCHEMA auth`.simple();
      await sql`CREATE TABLE auth.users (id UUID PRIMARY KEY)`.simple();
      await sql`CREATE TABLE auth.access (id UUID PRIMARY KEY)`.simple();
      const { migrate } = await import("../migrate");
      await migrate();

      if (scenario === "upgrade") {
        // Reconstruct the preceding schema's only removed column on the complete
        // migrated schema, then seed both flag values and authored historical data.
        await sql`ALTER TABLE notebooks.notebooks ADD COLUMN scripts_enabled BOOLEAN NOT NULL DEFAULT FALSE`.simple();
        const Y = await import("yjs");
        const markdown = '# Legacy source\n\n```script\nui.text("Grüße 👋").show();\n```\n\n@status\n:::data\nready: true\n:::';
        const doc = new Y.Doc();
        doc.getText("codemirror").insert(0, markdown);
        doc.getMap("kit:state").set("retained", { count: 3, label: "Preserve this value" });
        const bytes = Y.encodeStateAsUpdate(doc);
        doc.destroy();
        const snapshotHex = Buffer.from(bytes).toString("hex");
        const timestamp = "2026-09-03T10:00:00.000Z";

        for (const [index, scriptsEnabled] of [false, true].entries()) {
          const notebookId = crypto.randomUUID();
          const noteId = crypto.randomUUID();
          await sql`
            INSERT INTO notebooks.notebooks (id, short_id, name, scripts_enabled)
            VALUES (${notebookId}::uuid, ${`book0${index}`}, 'Legacy notebook', ${scriptsEnabled})
          `;
          await sql`
            INSERT INTO notebooks.notes (id, short_id, notebook_id, title, content_md, yjs_snapshot, yjs_snapshot_at, yjs_stream_ms, yjs_stream_seq)
            VALUES (${noteId}::uuid, ${`note0${index}`}, ${notebookId}::uuid, 'Legacy source', ${markdown}, decode(${snapshotHex}, 'hex'), ${timestamp}::timestamptz, 123, 4)
          `;
          await sql`
            INSERT INTO notebooks.note_versions (note_id, content_md, yjs_snapshot)
            VALUES (${noteId}::uuid, ${markdown}, decode(${snapshotHex}, 'hex'))
          `;
        }

        for (let run = 0; run < 2; run++) {
          await migrate();
          const rows = await sql<{ content_md: string; snapshot: string; stream_ms: string; stream_seq: string; snapshot_at: Date }[]>`
            SELECT content_md, encode(yjs_snapshot, 'hex') AS snapshot, yjs_stream_ms::text AS stream_ms,
              yjs_stream_seq::text AS stream_seq, yjs_snapshot_at AS snapshot_at
            FROM notebooks.notes ORDER BY short_id
          `;
          expect(rows).toHaveLength(2);
          for (const row of rows) {
            expect(row.content_md).toBe(markdown);
            expect(row.snapshot).toBe(snapshotHex);
            expect(row.stream_ms).toBe("123");
            expect(row.stream_seq).toBe("4");
            expect(row.snapshot_at.toISOString()).toBe(timestamp);
            const restored = new Y.Doc();
            Y.applyUpdate(restored, Buffer.from(row.snapshot, "hex"));
            expect(restored.getText("codemirror").toString()).toBe(markdown);
            expect(restored.getMap("kit:state").toJSON()).toEqual({ retained: { count: 3, label: "Preserve this value" } });
            restored.destroy();
          }
          const versions = await sql<{ content_md: string; snapshot: string }[]>`
            SELECT content_md, encode(yjs_snapshot, 'hex') AS snapshot FROM notebooks.note_versions
          `;
          expect(versions).toHaveLength(2);
          for (const version of versions) expect(version).toEqual({ content_md: markdown, snapshot: snapshotHex });
        }
      } else {
        expect(scenario).toBe("fresh");
        await migrate();
        const [rows] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM notebooks.notebooks`;
        expect(rows?.count).toBe(0);
      }
      const columns = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'notebooks' AND table_name = 'notebooks' AND column_name = 'scripts_enabled'
      `;
      expect(columns).toEqual([]);
    } finally {
      await sql.close({ timeout: 5 });
    }
  }, 60_000);
}
