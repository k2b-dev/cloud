import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import { audit } from "./audit";

const suite = databaseSuite();
const now = new Date("2026-11-03T12:00:00.000Z");

suite("automatic rows in administrator lists", () => {
  beforeEach(() => setSystemTime(now));
  afterEach(() => setSystemTime());

  test("audit hides only system app-workload entries and counts within the selected time and filters", async () => {
    const marker = crypto.randomUUID();
    const metadata = [
      {},
      { provenance: "system" },
      { service: "app-workload" },
      { provenance: "user", service: "app-workload" },
      { provenance: "system", service: "another-service" },
      { provenance: "system", service: "app-workload" },
    ];
    try {
      for (const entry of metadata) {
        await audit.record({
          action: "service_account_credential.create",
          outcome: "allowed",
          target: { id: marker },
          requestId: marker,
          metadata: entry,
        });
      }
      await sql`
        INSERT INTO audit.events (action, outcome, target_id, request_id, metadata, created_at)
        VALUES ('service_account_credential.create', 'allowed', ${marker}, ${marker},
          '{"provenance":"system","service":"app-workload"}'::jsonb, now() - interval '31 days'),
          ('service_account_credential.revoke', 'allowed', ${marker}, ${marker},
          '{"provenance":"system","service":"app-workload"}'::jsonb, now()),
          ('service_account_credential.create', 'denied', ${marker}, ${marker},
          '{"provenance":"system","service":"app-workload"}'::jsonb, now())
      `;
      const filter = { target: marker, days: 30, action: "service_account_credential.create", outcome: "allowed" } as const;
      const hidden = await audit.list({ filter: { ...filter, automatic: "hide" }, pagination: { perPage: 2 } });
      expect(hidden).toMatchObject({ total: 5, hiddenAutomaticCount: 1, hasNext: true });
      expect(hidden.items).toHaveLength(2);
      const included = await audit.list({ filter: { ...filter, automatic: "include" } });
      expect(included.total).toBe(6);
      const allHidden = await audit.list({ filter: { ...filter, automatic: "hide" } });
      expect(allHidden.items.map((item) => item.id)).toEqual(
        included.items
          .filter((item) => !(item.metadata.provenance === "system" && item.metadata.service === "app-workload"))
          .map((item) => item.id),
      );
      expect(allHidden.items).toHaveLength(5);
      expect(included).not.toHaveProperty("hiddenAutomaticCount");
      expect(await audit.list({ filter })).toEqual(included);
      expect(await audit.list({ filter: { ...filter, target: `missing-${marker}`, automatic: "hide" } })).toMatchObject({
        total: 0,
        hiddenAutomaticCount: 0,
      });
    } finally {
      await sql`DELETE FROM audit.events WHERE request_id = ${marker}`;
    }
  });
});
