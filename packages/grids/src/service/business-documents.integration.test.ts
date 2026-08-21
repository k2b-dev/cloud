import { describe, expect } from "bun:test";
import type { User } from "@valentinkolb/cloud/contracts";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { sql } from "bun";
import Decimal from "decimal.js";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { migrate as migrateCoreWorkflows } from "../../../core/src/migrate/core/workflows";
import { createBusinessDocumentsApi } from "../api/business-documents";
import { type BusinessDocumentProfile, exactDecimalSchema } from "../business-document-profiles";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { createBusinessDocumentService } from "./business-documents";

const encoder = new TextEncoder();
const snapshotSchema = z
  .object({
    title: z.string().min(1),
    net: exactDecimalSchema({ scale: 2, nonnegative: true }),
    tax: exactDecimalSchema({ scale: 2, nonnegative: true }),
  })
  .strict();

const profile: BusinessDocumentProfile<z.infer<typeof snapshotSchema>> = {
  id: "test.statement",
  version: 1,
  title: "Test statement",
  description: "Deterministic integration-test profile.",
  rendererVersion: "test-pdf-v1",
  validatorVersion: "test-validator-v1",
  input: snapshotSchema,
  formatNumber: ({ value }) => `STAT-${String(value).padStart(4, "0")}`,
  issue: (snapshot, { number }) => {
    const total = new Decimal(snapshot.net).plus(snapshot.tax).toFixed(2);
    return {
      artifacts: [
        {
          key: "pdf",
          filename: `${number}.pdf`,
          mediaType: "application/pdf",
          bytes: encoder.encode(`%PDF-1.7\n${number}\n${snapshot.title}\n${total}`),
        },
        {
          key: "structured",
          filename: `${number}.json`,
          mediaType: "application/json",
          bytes: encoder.encode(JSON.stringify({ number, ...snapshot, total })),
        },
      ],
      validationStatus: "valid",
      validationReport: { total, arithmetic: "decimal.js" },
    };
  },
};

const source = {
  appId: "native-orders",
  resourceType: "order",
  resourceId: "ORD-42",
};
const sourceRevision = {
  id: "order-version-7",
  observedAt: "2026-08-22T10:00:00.000Z",
  evidence: { version: 7 },
};

describe("Business Document issuance", () => {
  postgresTest(
    "freezes one permission-safe public GQL result and replays it through the adapter",
    async () => {
      await migrateCoreWorkflows();
      await migrate();
      const [authUser] = await sql<Array<{ id: string }>>`SELECT id::text FROM auth.users ORDER BY id LIMIT 1`;
      if (!authUser) throw new Error("Business Document GQL integration test needs one auth user");
      const baseId = testUuid();
      const tableId = testUuid();
      const fieldId = testUuid();
      const recordId = testUuid();
      const baseShortId = testShortId("B");
      const tableShortId = testShortId("T");
      const fieldShortId = testShortId("F");
      const recordShortId = testShortId("R");
      let accessId: string | null = null;
      const gqlSnapshot = z
        .object({ columns: z.array(z.record(z.string(), z.unknown())), rows: z.array(z.record(z.string(), z.unknown())) })
        .strict();
      const gqlProfile: BusinessDocumentProfile<z.infer<typeof gqlSnapshot>> = {
        id: "test.gql-statement",
        version: 1,
        title: "GQL statement",
        description: "Permission-safe GQL adapter fixture.",
        rendererVersion: "test-pdf-v1",
        validatorVersion: "test-validator-v1",
        input: gqlSnapshot,
        formatNumber: ({ value }) => `GQL-${String(value).padStart(4, "0")}`,
        issue: (snapshot, { number }) => {
          const bytes = encoder.encode(JSON.stringify(snapshot));
          return {
            artifacts: [
              { key: "pdf", filename: `${number}.pdf`, mediaType: "application/pdf", bytes: encoder.encode(`%PDF-1.7\n${number}`) },
              { key: "structured", filename: `${number}.json`, mediaType: "application/json", bytes },
            ],
            validationStatus: "valid",
            validationReport: { rows: snapshot.rows.length },
          };
        },
      };
      try {
        await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'GQL issuance')`;
        await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Orders')`;
        await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config) VALUES (${fieldId}::uuid, ${fieldShortId}, ${tableId}::uuid, 'Total', 'number', '{}'::jsonb)`;
        await sql`INSERT INTO grids.records (id, short_id, table_id, data) VALUES (${recordId}::uuid, ${recordShortId}, ${tableId}::uuid, ${{ [fieldId]: "119.00" }}::jsonb)`;
        const [access] = await sql<Array<{ id: string }>>`
        INSERT INTO auth.access (user_id, permission) VALUES (${authUser.id}::uuid, 'write'::auth.permission_level) RETURNING id::text
      `;
        if (!access) throw new Error("Business Document access insert failed");
        accessId = access.id;
        await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${accessId}::uuid)`;
        const user: User = {
          id: authUser.id,
          uid: "business-document-gql",
          roles: ["admin"],
          provider: "local",
          profile: "user",
          givenname: "Business",
          sn: "Document",
          displayName: "Business Document",
          mail: "business-document@example.test",
          avatarHash: null,
          accountExpires: null,
          lastLoginLocal: null,
          memberofGroup: [],
          memberofGroupIds: [],
          manages: [],
          managesGroupIds: [],
          ipa: null,
        };
        const authenticate: MiddlewareHandler<AuthContext> = async (c, next) => {
          c.set("actor", { kind: "user", user });
          c.set("accessSubject", { type: "user", userId: user.id });
          c.set("user", user);
          await next();
        };
        const service = createBusinessDocumentService({ profiles: [gqlProfile] });
        const app = new Hono<AuthContext>().route(
          "/business-documents",
          createBusinessDocumentsApi({
            requireAuthenticated: authenticate,
            service,
            resolveId: async (resource, id) => (resource === "base" && id === baseShortId ? baseId : null),
          }),
        );
        const body = {
          profileId: gqlProfile.id,
          profileVersion: 1,
          idempotencyKey: "gql-orders-v1",
          relationship: "original",
          query: `from table {${tableShortId}}\nselect {${fieldShortId}}`,
          observedAt: "2026-08-22T10:00:00.000Z",
        };
        const issue = () =>
          app.request(`/business-documents/by-base/${baseShortId}/issue-from-gql`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        const first = await issue();
        expect(first.status).toBe(201);
        const issued = await first.json();
        expect(issued.document).toMatchObject({ baseId: baseShortId, number: "GQL-0001", validationReport: { rows: 1 } });
        expect(JSON.stringify(issued)).not.toContain(baseId);
        expect(JSON.stringify(issued)).not.toContain(tableId);
        expect(JSON.stringify(issued)).not.toContain(fieldId);
        expect(JSON.stringify(issued)).not.toContain(recordId);
        const [actorRow] = await sql<Array<{ issued_actor: unknown }>>`
          SELECT issued_actor FROM grids.business_documents WHERE short_id = ${issued.document.id}
        `;
        expect(actorRow?.issued_actor).toEqual({ kind: "user", userId: authUser.id });
        const replay = await issue();
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual({ ...issued, replayed: true });
        const stored = await service.getByShortId(issued.document.id);
        if (!stored) throw new Error("GQL-issued Business Document missing");
        const structuredArtifact = await service.artifact(stored.internalId, "structured");
        if (!structuredArtifact.ok) throw structuredArtifact.error;
        const structuredText = new TextDecoder().decode(structuredArtifact.data.bytes);
        expect(structuredText).toContain(tableShortId);
        expect(structuredText).toContain(fieldShortId);
        expect(structuredText).toContain(recordShortId);
        expect(structuredText).not.toContain(tableId);
        expect(structuredText).not.toContain(fieldId);
        expect(structuredText).not.toContain(recordId);
      } finally {
        await sql`DELETE FROM grids.business_document_artifacts WHERE document_id IN (SELECT id FROM grids.business_documents WHERE base_id = ${baseId}::uuid)`;
        await sql`DELETE FROM grids.business_documents WHERE base_id = ${baseId}::uuid`;
        await sql`DELETE FROM grids.business_document_counters WHERE base_id = ${baseId}::uuid`;
        await sql`DELETE FROM grids.base_access WHERE base_id = ${baseId}::uuid`;
        if (accessId) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
        await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      }
    },
    45_000,
  );

  postgresTest(
    "issues immutable artifacts atomically, replays exactly, numbers concurrently, and links corrections",
    async () => {
      await migrateCoreWorkflows();
      await migrate();
      const baseId = testUuid();
      const baseShortId = testShortId("B");
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'Business Documents')`;
      const service = createBusinessDocumentService({ profiles: [profile] });
      try {
        const firstInput = {
          baseId,
          profileId: profile.id,
          profileVersion: profile.version,
          idempotencyKey: "statement-42-v1",
          source,
          sourceRevision,
          snapshot: { tax: "19.00", title: "Order 42", net: "100.00" },
          relationship: "original" as const,
          actor: { kind: "system" as const },
          issuedAt: new Date("2026-08-22T10:00:00.000Z"),
        };
        const first = await service.issue(firstInput);
        if (!first.ok) throw new Error(first.error.message);
        expect(first.ok).toBe(true);
        expect(first.data.replayed).toBe(false);
        expect(first.data.document).toMatchObject({
          baseId: baseShortId,
          number: "STAT-0001",
          profileId: "test.statement",
          relationship: "original",
          predecessorId: null,
          validationReport: { total: "119.00", arithmetic: "decimal.js" },
        });
        expect(first.data.document.id).toMatch(/^[A-Za-z0-9]{6}$/);
        expect(JSON.stringify(first.data.document)).not.toContain(baseId);
        const [actorRow] = await sql<Array<{ issued_actor: unknown }>>`
          SELECT issued_actor FROM grids.business_documents WHERE short_id = ${first.data.document.id}
        `;
        expect(actorRow?.issued_actor).toEqual({ kind: "system" });

        const replay = await service.issue({ ...firstInput, snapshot: { title: "Order 42", net: "100.00", tax: "19.00" } });
        expect(replay).toEqual({ ok: true, data: { document: first.data.document, replayed: true } });
        const changedIssueTime = await service.issue({ ...firstInput, issuedAt: new Date("2026-08-22T10:00:01.000Z") });
        expect(changedIssueTime.ok).toBe(false);
        if (!changedIssueTime.ok) expect(changedIssueTime.error.code).toBe("CONFLICT");
        const conflict = await service.issue({ ...firstInput, snapshot: { title: "Changed", net: "100.00", tax: "19.00" } });
        expect(conflict.ok).toBe(false);
        if (!conflict.ok) expect(conflict.error.code).toBe("CONFLICT");
        const invalidRelationship = await service.issue({ ...firstInput, idempotencyKey: "invalid-original", predecessorId: testUuid() });
        expect(invalidRelationship.ok).toBe(false);
        if (!invalidRelationship.ok) expect(invalidRelationship.error.code).toBe("BAD_INPUT");
        const invalidActor = await service.issue({
          ...firstInput,
          idempotencyKey: "invalid-actor",
          actor: { kind: "user" as const, userId: "not-a-uuid" },
        });
        expect(invalidActor.ok).toBe(false);
        if (!invalidActor.ok) expect(invalidActor.error.code).toBe("BAD_INPUT");

        const internal = await service.getByShortId(first.data.document.id);
        if (!internal) throw new Error("issued document missing");
        const pdf = await service.artifact(internal.internalId, "pdf");
        expect(pdf.ok).toBe(true);
        if (pdf.ok) expect(new TextDecoder().decode(pdf.data.bytes)).toContain("119.00");

        const parallel = await Promise.all(
          Array.from({ length: 2 }, (_, index) =>
            service.issue({
              ...firstInput,
              idempotencyKey: `parallel-${index}`,
              source: { ...source, resourceId: `ORD-${index + 100}` },
              sourceRevision: { ...sourceRevision, id: `order-version-${index + 100}` },
            }),
          ),
        );
        expect(parallel.every((result) => result.ok)).toBe(true);
        const numbers = parallel.flatMap((result) => (result.ok ? [result.data.document.number] : []));
        expect(new Set(numbers).size).toBe(2);
        expect(numbers.sort()).toEqual(Array.from({ length: 2 }, (_, index) => `STAT-${String(index + 2).padStart(4, "0")}`));

        const correction = await service.issue({
          ...firstInput,
          idempotencyKey: "statement-42-correction-1",
          sourceRevision: { ...sourceRevision, id: "order-version-8" },
          snapshot: { title: "Order 42 correction", net: "90.00", tax: "17.10" },
          relationship: "correction",
          predecessorId: internal.internalId,
        });
        expect(correction.ok).toBe(true);
        if (correction.ok) {
          expect(correction.data.document.relationship).toBe("correction");
          expect(correction.data.document.predecessorId).toBe(first.data.document.id);
          expect(correction.data.document.number).toBe("STAT-0004");
        }

        const mutationErrors: unknown[] = [];
        try {
          await sql`UPDATE grids.business_documents SET document_number = 'MUTATED' WHERE id = ${internal.internalId}::uuid`;
        } catch (error) {
          mutationErrors.push(error);
        }
        try {
          await sql`UPDATE grids.business_document_artifacts SET bytes = ${encoder.encode("changed")} WHERE document_id = ${internal.internalId}::uuid`;
        } catch (error) {
          mutationErrors.push(error);
        }
        expect(mutationErrors).toHaveLength(2);
        expect(mutationErrors.every((error) => String(error).includes("immutable"))).toBe(true);
      } finally {
        await sql`DELETE FROM grids.business_document_artifacts WHERE document_id IN (SELECT id FROM grids.business_documents WHERE base_id = ${baseId}::uuid)`;
        await sql`DELETE FROM grids.business_documents WHERE base_id = ${baseId}::uuid`;
        await sql`DELETE FROM grids.business_document_counters WHERE base_id = ${baseId}::uuid`;
        await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      }
    },
    45_000,
  );

  postgresTest("rolls back the number and every row when profile issuance fails", async () => {
    await migrateCoreWorkflows();
    await migrate();
    const baseId = testUuid();
    await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Business rollback')`;
    const failing: BusinessDocumentProfile<z.infer<typeof snapshotSchema>> = {
      ...profile,
      issue: () => {
        throw new Error("renderer unavailable");
      },
    };
    try {
      const service = createBusinessDocumentService({ profiles: [failing] });
      const failed = service.issue({
        baseId,
        profileId: profile.id,
        profileVersion: 1,
        idempotencyKey: "failed-once",
        source,
        sourceRevision,
        snapshot: { title: "Failure", net: "1.00", tax: "0.19" },
        relationship: "original",
        actor: { kind: "system" },
      });
      await expect(failed).rejects.toThrow("renderer unavailable");
      const [counts] = await sql<Array<{ documents: number; artifacts: number; nextValue: number | null }>>`
        SELECT
          (SELECT count(*)::int FROM grids.business_documents WHERE base_id = ${baseId}::uuid) AS documents,
          (SELECT count(*)::int FROM grids.business_document_artifacts artifact
            JOIN grids.business_documents document ON document.id = artifact.document_id WHERE document.base_id = ${baseId}::uuid) AS artifacts,
          (SELECT next_value::int FROM grids.business_document_counters WHERE base_id = ${baseId}::uuid) AS "nextValue"
      `;
      expect(counts).toEqual({ documents: 0, artifacts: 0, nextValue: null });
    } finally {
      await sql`DELETE FROM grids.business_document_counters WHERE base_id = ${baseId}::uuid`;
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });
});
