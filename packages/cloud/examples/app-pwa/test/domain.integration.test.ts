// Uses the repository's isolated CLOUD_TEST_* database fixture.

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AppPwaCommandContext } from "@k2b/cloud/app-pwa";
import { SQL, type TransactionSQL } from "bun";
import { databaseSuite, requireDatabaseUrl } from "../../../../../scripts/fixtures/test-infra";
import { SUBJECT_ID } from "../src/constants";
import { readVisit, SignSchema, setupDomain, signDocument } from "../src/domain";

const suite = databaseSuite();
const visitId = "3c000000-0000-4000-8000-000000000001";
const rollback = new Error("rollback example domain fixture");
let db: SQL;
const signature = {
  kind: "typed",
  name: "Lea Muster",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 264 77" width="264" height="77"><text x="12" y="55" font-family="cursive" font-size="48" fill="currentColor">Lea Muster</text></svg>',
};
const context = (tx: TransactionSQL, onEnd: () => void): AppPwaCommandContext => ({
  tx,
  signal: new AbortController().signal,
  endVisit: onEnd,
  actor: {
    kind: "visit",
    appId: "visit-demo",
    deviceId: "3c000000-0000-4000-8000-000000000002",
    ownerUserId: "3c000000-0000-4000-8000-000000000003",
    visitId,
    subject: { customerId: SUBJECT_ID },
  },
});
suite("example domain with real Postgres", () => {
  beforeAll(async () => {
    db = new SQL(requireDatabaseUrl());
    await setupDomain(db);
  });
  afterAll(async () => {
    await db?.close();
  });
  const rollbackTest = async (run: (tx: TransactionSQL) => Promise<void>) => {
    await expect(
      db.begin(async (tx) => {
        await tx`DELETE FROM visit_demo.signatures WHERE visit_id = ${visitId}::uuid`;
        await run(tx);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  };
  const input = (documentId: "contract" | "receipt", revision = 1) => SignSchema.parse({ documentId, revision, signature, consent: true });

  test("domain transaction preserves revisions, rejects stale signing and completes only the final paid receipt", async () => {
    await rollbackTest(async (tx) => {
      let ended = 0;
      const c = context(tx, () => {
        ended++;
      });
      await tx`UPDATE visit_demo.payments SET state = 'paid' WHERE customer_id = ${SUBJECT_ID}::uuid`;
      await tx`UPDATE visit_demo.documents SET revision = 1 WHERE customer_id = ${SUBJECT_ID}::uuid`;
      const before = await readVisit(c);
      expect(before.documents).toHaveLength(2);
      expect(JSON.stringify(before)).not.toContain('"svg"');
      await expect(signDocument(c, input("receipt"), "receipt")).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(signDocument(c, input("contract", 2), "contract")).rejects.toMatchObject({ code: "APP_REVISION_CONFLICT" });
      expect(await signDocument(c, input("contract"), "contract")).toEqual({ completed: false });
      expect(ended).toBe(0);
      expect(await signDocument(c, input("receipt"), "receipt")).toEqual({ completed: true });
      expect(ended).toBe(1);
      const rows = await tx<{ revision: number }[]>`SELECT revision FROM visit_demo.signatures WHERE visit_id = ${visitId}::uuid`;
      expect(rows).toHaveLength(2);
      const view = await readVisit(c);
      expect(view.documents.every((document) => document.signed)).toBe(true);
      expect(JSON.stringify(view)).not.toContain('"signature"');
    });
    const rows = await db`SELECT 1 FROM visit_demo.signatures WHERE visit_id = ${visitId}::uuid`;
    expect(rows).toHaveLength(0);
  });

  test("unpaid receipts are neither offered nor signable; contract completion ends that offered set", async () => {
    await rollbackTest(async (tx) => {
      let ended = 0;
      const c = context(tx, () => {
        ended++;
      });
      await tx`UPDATE visit_demo.payments SET state = 'pending' WHERE customer_id = ${SUBJECT_ID}::uuid`;
      await tx`UPDATE visit_demo.documents SET revision = 1 WHERE customer_id = ${SUBJECT_ID}::uuid`;
      expect((await readVisit(c)).documents.map((document) => document.id)).toEqual(["contract"]);
      await expect(signDocument(c, input("receipt"), "receipt")).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await signDocument(c, input("contract"), "contract")).toEqual({ completed: true });
      expect(ended).toBe(1);
    });
  });

  test("a new offered revision leaves the previous signed content and signature intact", async () => {
    await rollbackTest(async (tx) => {
      const c = context(tx, () => {});
      await tx`UPDATE visit_demo.documents SET revision = 1 WHERE customer_id = ${SUBJECT_ID}::uuid`;
      await signDocument(c, input("contract"), "contract");
      await tx`INSERT INTO visit_demo.document_revisions SELECT customer_id,id,2,title,paragraphs FROM visit_demo.document_revisions WHERE customer_id = ${SUBJECT_ID}::uuid AND id = 'contract' AND revision = 1 ON CONFLICT DO NOTHING`;
      await tx`UPDATE visit_demo.documents SET revision = 2 WHERE customer_id = ${SUBJECT_ID}::uuid AND id = 'contract'`;
      await expect(signDocument(c, input("contract"), "contract")).rejects.toMatchObject({ code: "APP_REVISION_CONFLICT" });
      await signDocument(c, input("contract", 2), "contract");
      const rows = await tx<
        { revision: number }[]
      >`SELECT revision FROM visit_demo.signatures WHERE visit_id = ${visitId}::uuid AND document_id = 'contract' ORDER BY revision`;
      expect(rows.map((row) => row.revision)).toEqual([1, 2]);
    });
  });
});
