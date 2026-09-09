import { beforeAll, describe, expect } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { sql } from "bun";
import { Hono, type MiddlewareHandler } from "hono";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { enable as enableDurableHistory } from "../service/durable-history";
import { recordsRoutes } from "./records";
import { tablesRoutes } from "./tables";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

const user = (id: string, name: string): User => ({
  id,
  uid: `finalization-${id}`,
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: name,
  sn: "Reviewer",
  displayName: name,
  mail: null,
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
});

describe("Four-eyes Finalization routes", () => {
  postgresTest("uses public Record ids and enforces admin, Write, group, and different-actor boundaries", async () => {
    const requester = user(testUuid(), "Requester");
    const approver = user(testUuid(), "Approver");
    const outsider = user(testUuid(), "Outsider");
    const users = new Map([requester, approver, outsider].map((item) => [item.id, item]));
    const groupId = testUuid();
    const baseId = testUuid();
    const tableId = testUuid();
    const fieldId = testUuid();
    const recordId = testUuid();
    const baseShortId = testShortId("B");
    const tableShortId = testShortId("T");
    const fieldShortId = testShortId("F");
    const recordShortId = testShortId("R");
    const accessIds = [testUuid(), testUuid(), testUuid()];
    const auth: MiddlewareHandler<AuthContext> = async (c, next) => {
      const selected = users.get(c.req.header("x-test-user") ?? "") ?? requester;
      c.set("actor", { kind: "user", user: selected });
      c.set("accessSubject", { type: "user", userId: selected.id });
      c.set("user", selected);
      await next();
    };
    const app = new Hono<AuthContext>().use(auth).route("/tables", tablesRoutes).route("/records", recordsRoutes);
    const request = (path: string, actor: User, method = "GET", body?: unknown) =>
      app.request(path, {
        method,
        headers: { "x-test-user": actor.id, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      await sql`
        INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn) VALUES
          (${requester.id}::uuid, ${requester.uid}, 'local', 'user', ${requester.displayName}, ${requester.givenname}, ${requester.sn}),
          (${approver.id}::uuid, ${approver.uid}, 'local', 'user', ${approver.displayName}, ${approver.givenname}, ${approver.sn}),
          (${outsider.id}::uuid, ${outsider.uid}, 'local', 'user', ${outsider.displayName}, ${outsider.givenname}, ${outsider.sn})
      `;
      await sql`INSERT INTO auth.groups (id, cn, provider, name) VALUES (${groupId}::uuid, ${`final-reviewers-${groupId}`}, 'local', 'Route final reviewers')`;
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${approver.id}::uuid, ${groupId}::uuid)`;
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'Four-eyes routes')`;
      await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Cases')`;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position, presentable)
        VALUES (${fieldId}::uuid, ${fieldShortId}, ${tableId}::uuid, 'Name', 'text', '{}'::jsonb, 0, TRUE)
      `;
      await sql`
        INSERT INTO grids.records (id, short_id, table_id, data, created_by, updated_by)
        VALUES (${recordId}::uuid, ${recordShortId}, ${tableId}::uuid, ${{ [fieldId]: "Reviewed" }}::jsonb, ${requester.id}::uuid, ${requester.id}::uuid)
      `;
      await sql`
        INSERT INTO auth.access (id, user_id, permission) VALUES
          (${accessIds[0]}::uuid, ${requester.id}::uuid, 'admin'),
          (${accessIds[1]}::uuid, ${approver.id}::uuid, 'write'),
          (${accessIds[2]}::uuid, ${outsider.id}::uuid, 'write')
      `;
      await sql`
        INSERT INTO grids.base_access (base_id, access_id) VALUES
          (${baseId}::uuid, ${accessIds[0]}::uuid),
          (${baseId}::uuid, ${accessIds[1]}::uuid),
          (${baseId}::uuid, ${accessIds[2]}::uuid)
      `;
      const history = await enableDurableHistory(tableId, requester.id);
      if (!history.ok) throw history.error;
      const policy = await request(`/tables/${tableShortId}/finalization/enable`, requester, "POST", {
        mode: "fourEyes",
        approverGroupId: groupId,
      });
      expect(policy.status).toBe(200);
      expect(await policy.json()).toMatchObject({ mode: "fourEyes", approverGroupId: groupId, approverGroupName: "Route final reviewers" });

      const readiness = await request(`/records/${tableShortId}/${recordShortId}/finalization`, requester);
      expect(readiness.status).toBe(200);
      expect(await readiness.json()).toMatchObject({ enabled: true, mode: "fourEyes", policyRevision: 1 });

      const preview = await request(`/records/${tableShortId}/finalization/preview`, requester, "POST", {
        recordIds: [recordShortId],
      });
      expect(preview.status).toBe(200);
      expect(await preview.json()).toEqual({
        items: [
          {
            ok: true,
            recordId: recordShortId,
            enabled: true,
            mode: "fourEyes",
            policyRevision: 1,
            finalized: false,
            pendingRequest: false,
            missingFieldNames: [],
          },
        ],
      });

      expect((await request(`/records/${tableShortId}/${recordShortId}/finalize`, requester, "POST")).status).toBe(409);
      const submitted = await request(`/records/${tableShortId}/${recordShortId}/finalization/request`, requester, "POST", {
        comment: "Ready for another person",
      });
      expect(submitted.status).toBe(200);
      const submittedBody = (await submitted.json()) as { id: string; status: string; requestComment: string };
      expect(submittedBody.id).toMatch(/^[A-Za-z0-9]{6}$/);
      expect(submittedBody).toMatchObject({ status: "pending", requestComment: "Ready for another person" });
      expect(JSON.stringify(submittedBody)).not.toContain(recordId);

      expect(
        (
          await request(`/records/${tableShortId}/${recordShortId}/finalization/approve`, requester, "POST", {
            requestId: submittedBody.id,
          })
        ).status,
      ).toBe(403);
      expect(
        (await request(`/records/${tableShortId}/${recordShortId}/finalization/approve`, outsider, "POST", { requestId: submittedBody.id }))
          .status,
      ).toBe(403);
      const approved = await request(`/records/${tableShortId}/${recordShortId}/finalization/approve`, approver, "POST", {
        requestId: submittedBody.id,
        comment: "Approved",
      });
      expect(approved.status).toBe(200);
      expect(await approved.json()).toMatchObject({ id: recordShortId, tableId: tableShortId });
    } finally {
      await sql`UPDATE grids.records SET finalized_at = NULL, finalized_by = NULL, final_revision_id = NULL WHERE table_id = ${tableId}::uuid`;
      await sql`DELETE FROM grids.record_finalization_requests WHERE table_id = ${tableId}::uuid`;
      await sql`DELETE FROM grids.record_revisions WHERE table_id = ${tableId}::uuid`;
      await sql`DELETE FROM grids.table_finalization_activations WHERE table_id = ${tableId}::uuid`;
      await sql`DELETE FROM grids.durable_history_activations WHERE table_id = ${tableId}::uuid`;
      await sql`DELETE FROM grids.table_schema_revisions WHERE table_id = ${tableId}::uuid`;
      await sql`DELETE FROM grids.audit_log WHERE base_id = ${baseId}::uuid`;
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      await sql`DELETE FROM auth.access WHERE id IN (${accessIds[0]}::uuid, ${accessIds[1]}::uuid, ${accessIds[2]}::uuid)`;
      await sql`DELETE FROM auth.user_groups_v2 WHERE group_id = ${groupId}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id IN (${requester.id}::uuid, ${approver.id}::uuid, ${outsider.id}::uuid)`;
    }
  });
});
