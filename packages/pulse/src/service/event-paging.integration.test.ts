import { expect } from "bun:test";
import { sql } from "bun";
import { collectPages, descending } from "../../../../scripts/fixtures/stable-paging";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { ingestBatch } from "./ingest-writer";
import { listRecentEvents, listResourceEvents } from "./signal-catalog";

const dbTest = testFor("database");

dbTest(
  "event pages list a batch that shares ts and recorded_at exactly once, newest id first",
  async () => {
    const baseId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const [user] =
      await sql`INSERT INTO auth.users(uid,provider,profile,display_name) VALUES(${`pulse-event-paging-${baseId}`},'local','user','Event paging test') RETURNING id`;
    const [access] = await sql`INSERT INTO auth.access(user_id,permission) VALUES(${user.id}::uuid,'admin') RETURNING id`;
    try {
      await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${baseId}::uuid,${newShortId()},'Event paging test')`;
      await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${baseId}::uuid,${access.id}::uuid)`;
      await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name) VALUES(${sourceId}::uuid,${newShortId()},${baseId}::uuid,'http_ingest','Paging source')`;
      // One batch is one transaction: every event ties on ts and on recorded_at.
      const ts = new Date(Date.now() - 60_000).toISOString();
      const resource = { type: "website", id: "tied", label: "Tied" };
      const ingested = await ingestBatch({
        baseId,
        sourceId,
        batch: { events: Array.from({ length: 12 }, () => ({ kind: "page.viewed", ts, resource })) },
      });
      expect(ingested.ok).toBe(true);
      const rows = await sql<{ id: string }[]>`SELECT id::text AS id FROM pulse.events WHERE base_id = ${baseId}::uuid`;
      expect(rows).toHaveLength(12);
      const expected = descending(rows.map((row) => row.id));

      const recent = await collectPages(async ({ offset, limit }) => {
        const result = await listRecentEvents(baseId, { id: user.id }, { limit, offset });
        if (!result.ok) throw Error(result.error.message);
        return result.data.map((event) => event.id);
      });
      expect(recent).toEqual(expected);

      const byResource = await collectPages(async ({ offset, limit }) => {
        const result = await listResourceEvents(baseId, { id: user.id }, { resourceKey: "website:tied", limit, offset });
        if (!result.ok) throw Error(result.error.message);
        return result.data.map((event) => event.id);
      });
      expect(byResource).toEqual(expected);
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
      await sql`DELETE FROM auth.access WHERE id=${access.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${user.id}::uuid`;
    }
  },
  30_000,
);
