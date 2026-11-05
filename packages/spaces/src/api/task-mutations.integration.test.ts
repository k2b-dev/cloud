import { expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { newShortId } from "../lib/short-id";
import spacesApi from ".";

const suite = databaseSuite();

suite("Spaces task mutation routes", () => {
  test("serializes assignment deltas, refuses stale titles and replays creates by actor", async () => {
    const [space] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, 'Task mutation routes') RETURNING id, short_id
    `;
    const accounts: string[] = [];
    const accessIds: string[] = [];
    try {
      const [column] = await sql<{ id: string; short_id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank) VALUES (${newShortId()}, ${space!.id}::uuid, 'Open', 1024) RETURNING id, short_id
      `;
      const [tag] = await sql<{ id: string; short_id: string }[]>`
        INSERT INTO spaces.tags (short_id, space_id, name, color) VALUES (${newShortId()}, ${space!.id}::uuid, 'Original tag', '#2563eb') RETURNING id, short_id
      `;
      const tokens: string[] = [];
      for (let index = 0; index < 3; index++) {
        const [account] = await sql<{ id: string }[]>`
          INSERT INTO auth.service_accounts (name, kind) VALUES (${`Task mutation ${newShortId()}`}, 'agent') RETURNING id
        `;
        accounts.push(account!.id);
        const [access] = await sql<{ id: string }[]>`
          INSERT INTO auth.access (service_account_id, permission) VALUES (${account!.id}::uuid, 'write') RETURNING id
        `;
        accessIds.push(access!.id);
        await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${space!.id}::uuid, ${access!.id}::uuid)`;
        const credential = await serviceAccountCredentials.createApiToken({
          serviceAccountId: account!.id,
          name: "task-mutations",
          scopes: ["read", "write"],
        });
        if (!credential.ok) throw new Error(credential.error.message);
        tokens.push(credential.data.token);
      }
      const request = (actor: number, method: string, path: string, body: unknown) =>
        spacesApi.request(`/${space!.short_id}/items${path}`, {
          method,
          headers: { authorization: `Bearer ${tokens[actor]!}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const input = {
        columnId: column!.short_id,
        title: "Original",
        requestKey: "uncertain-create",
        tagIds: [tag!.short_id],
        checklist: ["Review"],
      };
      const [first, repeated] = await Promise.all([request(0, "POST", "", input), request(0, "POST", "", input)]);
      expect(first.status).toBe(200);
      expect(repeated.status).toBe(200);
      const task = await first.json();
      expect(await repeated.json()).toEqual(task);
      const other = await request(1, "POST", "", input);
      expect(other.status).toBe(200);
      expect((await other.json()).id).not.toBe(task.id);
      const changedKey = await request(0, "POST", "", { ...input, title: "Different input" });
      expect(changedKey.status).toBe(409);
      expect(await changedKey.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

      const adds = await Promise.all([
        request(0, "PATCH", `/${task.id}`, { addAssigneeIds: [accounts[0]] }),
        request(1, "PATCH", `/${task.id}`, { addAssigneeIds: [accounts[1]] }),
      ]);
      expect(adds.map((response) => response.status)).toEqual([200, 200]);
      const addRemove = await Promise.all([
        request(0, "PATCH", `/${task.id}`, { removeAssigneeIds: [accounts[0]] }),
        request(1, "PATCH", `/${task.id}`, { addAssigneeIds: [accounts[2]] }),
      ]);
      expect(addRemove.map((response) => response.status)).toEqual([200, 200]);
      const read = await spacesApi.request(`/${space!.short_id}/items/${task.id}`, { headers: { authorization: `Bearer ${tokens[0]!}` } });
      expect((await read.json()).assignees.map((assignee: { id: string }) => assignee.id).sort()).toEqual(
        [accounts[1], accounts[2]].sort(),
      );

      expect((await request(0, "PATCH", `/${task.id}`, { title: "Changed", expectedTitle: "Original" })).status).toBe(200);
      const stale = await request(1, "PATCH", `/${task.id}`, { title: "Stale", expectedTitle: "Original", priority: "urgent" });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: "TITLE_CONFLICT" });
      expect(await (await request(0, "POST", "", input)).json()).toEqual(task);

      await sql`DELETE FROM spaces.tags WHERE id = ${tag!.id}::uuid`;
      const [replacement] = await sql<{ id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank) VALUES (${newShortId()}, ${space!.id}::uuid, 'Replacement', 2048) RETURNING id
      `;
      await sql`UPDATE spaces.items SET column_id = ${replacement!.id}::uuid WHERE space_id = ${space!.id}::uuid`;
      await sql`DELETE FROM spaces.columns WHERE id = ${column!.id}::uuid`;
      const afterRelationsRemoved = await request(0, "POST", "", input);
      expect(afterRelationsRemoved.status).toBe(200);
      expect(await afterRelationsRemoved.json()).toEqual(task);

      // Replaying a receipt still requires current access to the Space.
      await sql`DELETE FROM spaces.space_access WHERE space_id = ${space!.id}::uuid AND access_id = ${accessIds[0]}::uuid`;
      expect((await request(0, "POST", "", input)).status).toBe(403);
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${space!.id}::uuid`;
      for (const id of accounts) {
        await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${id}::uuid`;
        await sql`DELETE FROM auth.access WHERE service_account_id = ${id}::uuid`;
        await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
      }
    }
  });
});
