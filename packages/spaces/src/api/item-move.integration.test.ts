import { expect, setDefaultTimeout, test } from "bun:test";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { newShortId } from "../lib/short-id";
import spacesApi from ".";

const suite = databaseSuite();
setDefaultTimeout(30_000);

suite("Spaces item move route", () => {
  test("answers 404 for a neighbor outside the Space and 409 for one in another column", async () => {
    const spaces = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, 'Move route'), (${newShortId()}, 'Move route other')
      RETURNING id, short_id
    `;
    const [space, other] = spaces as [(typeof spaces)[number], (typeof spaces)[number]];
    let accountId: string | null = null;
    try {
      const column = async (spaceId: string, name: string, rank: number) => {
        const [row] = await sql<{ id: string; short_id: string }[]>`
          INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
          VALUES (${newShortId()}, ${spaceId}::uuid, ${name}, ${rank}, false) RETURNING id, short_id
        `;
        return row!;
      };
      const item = async (spaceId: string, columnId: string, title: string) => {
        const [row] = await sql<{ short_id: string }[]>`
          INSERT INTO spaces.items (short_id, space_id, column_id, title, rank)
          VALUES (${newShortId()}, ${spaceId}::uuid, ${columnId}::uuid, ${title}, 1024) RETURNING short_id
        `;
        return row!.short_id;
      };
      const open = await column(space.id, "Open", 1024);
      const review = await column(space.id, "Review", 2048);
      const elsewhere = await column(other.id, "Open", 1024);
      const anchor = await item(space.id, open.id, "A");
      const moving = await item(space.id, review.id, "X");
      const foreign = await item(other.id, elsewhere.id, "O");

      const [account] = await sql<{ id: string }[]>`
        INSERT INTO auth.service_accounts (name, kind) VALUES (${`Move route ${newShortId()}`}, 'agent') RETURNING id
      `;
      accountId = account!.id;
      const [access] = await sql<{ id: string }[]>`
        INSERT INTO auth.access (service_account_id, permission) VALUES (${accountId}::uuid, 'write') RETURNING id
      `;
      await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${space.id}::uuid, ${access!.id}::uuid)`;
      const token = await serviceAccountCredentials.createApiToken({
        serviceAccountId: accountId,
        name: "move",
        scopes: ["read", "write"],
      });
      if (!token.ok) throw new Error(token.error.message);
      const move = (body: Record<string, string>) =>
        spacesApi.request(`/${space.short_id}/items/${moving}/move`, {
          method: "POST",
          headers: { authorization: `Bearer ${token.data.token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      // The neighbor is resolved within the Space: an unknown item and one of another Space are both missing here.
      for (const afterItemId of [newShortId(), foreign]) {
        const missing = await move({ columnId: open.short_id, afterItemId });
        expect(missing.status).toBe(404);
        expect(await missing.json()).toMatchObject({ message: "Neighboring item not found" });
      }
      // A neighbor of the Space outside the target column means the client's column is out of date.
      expect((await move({ columnId: review.short_id, afterItemId: anchor })).status).toBe(409);

      const moved = await move({ columnId: open.short_id, afterItemId: anchor });
      expect(moved.status).toBe(200);
      expect(await moved.json()).toMatchObject({ id: moving, columnId: open.short_id });
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id IN (${space.id}::uuid, ${other.id}::uuid)`;
      if (accountId) {
        await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${accountId}::uuid`;
        await sql`DELETE FROM auth.access WHERE service_account_id = ${accountId}::uuid`;
        await sql`DELETE FROM auth.service_accounts WHERE id = ${accountId}::uuid`;
      }
    }
  });
});
