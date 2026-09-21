import { expect } from "bun:test";
import { sql } from "bun";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { ingestBatch } from "./ingest-writer";
import { listResources } from "./signal-catalog";

const dbTest = testFor("database");

dbTest(
  "complete, filtered and paginated resources retain exact event counts",
  async () => {
    const baseId = crypto.randomUUID();
    const sources = [crypto.randomUUID(), crypto.randomUUID()];
    const [user] =
      await sql`INSERT INTO auth.users(uid,provider,profile,display_name) VALUES(${`pulse-resource-counts-${baseId}`},'local','user','Resource counts test') RETURNING id`;
    const [access] = await sql`INSERT INTO auth.access(user_id,permission) VALUES(${user.id}::uuid,'admin') RETURNING id`;
    try {
      await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${baseId}::uuid,${newShortId()},'Resource counts test')`;
      await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${baseId}::uuid,${access.id}::uuid)`;
      for (const source of sources)
        await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name) VALUES(${source}::uuid,${newShortId()},${baseId}::uuid,'http_ingest','Count source')`;
      const ts = new Date(Date.now() - 60_000).toISOString();
      const alpha = { type: "website", id: "alpha", label: "Alpha" };
      const beta = { type: "website", id: "beta", label: "Beta" };
      const first = await ingestBatch({
        baseId,
        sourceId: sources[0]!,
        batch: {
          events: [
            { kind: "page.viewed", ts, resource: alpha },
            { kind: "page.viewed", ts, resource: alpha },
            { kind: "page.viewed", ts, resource: beta },
            { kind: "page.viewed", ts },
          ],
          metrics: [{ name: "cpu", value: 1, ts, resource: { type: "host", id: "silent", label: "Silent" } }],
        },
      });
      expect(first.ok).toBe(true);
      const second = await ingestBatch({
        baseId,
        sourceId: sources[1]!,
        batch: { events: [{ kind: "page.viewed", ts, resource: alpha }] },
      });
      expect(second.ok).toBe(true);
      const read = async (params: Parameters<typeof listResources>[2] = {}) => {
        const result = await listResources(baseId, { id: user.id }, params);
        if (!result.ok) throw Error(result.error.message);
        return Object.fromEntries(result.data.map((row) => [row.key, row.eventCount]));
      };
      const all = { "website:alpha": 3, "website:beta": 1, "host:silent": 0 };
      expect(await read()).toEqual(all);
      expect(await read({ limit: 3 })).toEqual(all);
      expect(await read({ q: "Beta" })).toEqual({ "website:beta": 1 });
      expect(await read({ ref: "website:alpha" })).toEqual({ "website:alpha": 3 });
      expect(await read({ type: "website" })).toEqual({ "website:alpha": 3, "website:beta": 1 });
      expect(await read({ sourceId: sources[1] })).toEqual({ "website:alpha": 3 });
      const pages = await Promise.all([0, 1, 2].map((offset) => read({ limit: 1, offset })));
      expect(pages.map((page) => Object.keys(page).length)).toEqual([1, 1, 1]);
      expect(Object.assign({}, ...pages)).toEqual(all);
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
      await sql`DELETE FROM auth.access WHERE id=${access.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${user.id}::uuid`;
    }
  },
  30_000,
);
