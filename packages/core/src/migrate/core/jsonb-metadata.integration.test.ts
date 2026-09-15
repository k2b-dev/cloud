import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate as audit } from "./audit";
import { migrate as auth } from "./auth";
import { repairEncodedMetadata } from "./jsonb-metadata";
import { migrate as notifications } from "./notifications";

// Only run against a disposable migrated database, never an installation.
describe.skipIf(process.env.CLOUD_JSONB_UPGRADE_TEST !== "1")("JSONB startup upgrade", () => {
  beforeAll(async () => {
    await auth();
    await audit();
    await notifications();
  });

  test("repairs metadata in timestamp batches without losing content or malformed originals", async () => {
    const request = crypto.randomUUID();
    const legacy = '{"big":9007199254740993,"nested":{"ok":true}}';
    const invalid = ["broken", '{"bad":"\\u0000"}', '{"bad":"\\ud800"}', '{"big":1e999999}', "[1,2]", "null"];
    const timestamp = "2026-06-23 12:00:00.123456+00";
    try {
      for (const value of [legacy, ...invalid, legacy]) {
        await sql`INSERT INTO audit.events(action,outcome,request_id,created_at,metadata)
          VALUES('test','allowed',${request},${timestamp}::timestamptz,${value}::jsonb)`;
      }
      const deleted = crypto.randomUUID();
      await sql`INSERT INTO auth.deleted_accounts(id,deleted_user_id,uid,reason,meta)
        VALUES(${deleted}::uuid,${deleted}::uuid,${request},'manual_delete',${legacy}::jsonb)`;
      const totals = await repairEncodedMetadata("audit.events", sql, 2);
      expect(totals).toEqual({ inspected: 8, repaired: 2, preserved: 6 });
      const rows = await sql`SELECT jsonb_typeof(metadata) AS kind, metadata->>'big' AS big,
        metadata->'nested'->>'ok' AS nested FROM audit.events WHERE request_id=${request} ORDER BY id`;
      expect(rows[0]).toEqual({ kind: "object", big: "9007199254740993", nested: "true" });
      expect(rows.at(-1)).toEqual(rows[0]);
      const originals = await sql<{ value: string }[]>`SELECT metadata #>> '{}' AS value FROM audit.events
        WHERE request_id=${request} AND jsonb_typeof(metadata)='string' ORDER BY id`;
      expect(originals.map((row) => row.value)).toEqual(invalid);
      expect(await repairEncodedMetadata("auth.deleted_accounts", sql, 2)).toEqual({ inspected: 1, repaired: 1, preserved: 0 });
      const [saved] = await sql`SELECT uid,meta->>'big' AS big FROM auth.deleted_accounts WHERE id=${deleted}::uuid`;
      expect(saved).toEqual({ uid: request, big: "9007199254740993" });
      // Execute actual owning startup functions again, not just the decoder.
      await auth();
      await audit();
      expect(await repairEncodedMetadata("audit.events", sql, 2)).toEqual({ inspected: 6, repaired: 0, preserved: 6 });
      expect(await repairEncodedMetadata("auth.deleted_accounts", sql, 2)).toEqual({ inspected: 0, repaired: 0, preserved: 0 });
      const [count] = await sql`SELECT count(*)::int AS n FROM audit.events WHERE request_id=${request}`;
      expect(count.n).toBe(8);
    } finally {
      await sql`DELETE FROM audit.events WHERE request_id=${request}`;
      await sql`DELETE FROM auth.deleted_accounts WHERE uid=${request}`;
    }
  });

  test("cancels old selections before senders start and preserves new batches on restart", async () => {
    const subject = crypto.randomUUID();
    try {
      for (const status of ["draft", "ready", "running", "completed"]) {
        await sql`INSERT INTO notifications.batches(subject,body_markdown,body_html,selection,selection_hash,status)
          VALUES(${subject},'body','body',${'{"userIds":["old"]}'}::jsonb,'old',${status})`;
      }
      await notifications();
      const old = await sql<
        { status: string; kind: string }[]
      >`SELECT status,jsonb_typeof(selection) AS kind FROM notifications.batches WHERE subject=${subject}`;
      expect(old.filter((row) => row.status === "cancelled")).toHaveLength(3);
      expect(old.filter((row) => row.status === "completed")).toHaveLength(1);
      expect(old.every((row) => row.kind === "object")).toBe(true);
      await sql`INSERT INTO notifications.batches(subject,body_markdown,body_html,selection,selection_hash,status)
        VALUES(${subject},'new','new',${{ userIds: ["new"] }}::jsonb,'new','ready')`;
      await notifications();
      const [fresh] =
        await sql`SELECT status,selection->'userIds'->>0 AS user FROM notifications.batches WHERE subject=${subject} AND selection_hash='new'`;
      expect(fresh).toEqual({ status: "ready", user: "new" });
    } finally {
      await sql`DELETE FROM notifications.batches WHERE subject=${subject}`;
    }
  });
});
