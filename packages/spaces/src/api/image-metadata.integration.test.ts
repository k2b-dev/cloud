import { expect, test } from "bun:test";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import { tinyJpeg, withCameraMetadata } from "../../../../scripts/fixtures/image-metadata";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { spacesService } from "../service";
import api from ".";

const shortId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 6);

databaseSuite()("spaces image upload privacy", () => {
  test("API and direct service store sanitized bytes and sizes; malformed images return 422", async () => {
    const [resource] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name) VALUES (${shortId()}, 'Photo privacy') RETURNING id, short_id
    `;
    const [column] = await sql<{ id: string }[]>`
      INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
      VALUES (${shortId()}, ${resource!.id}::uuid, 'Tasks', 1024, false) RETURNING id
    `;
    const [item] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO spaces.items (short_id, space_id, column_id, title, rank)
      VALUES (${shortId()}, ${resource!.id}::uuid, ${column!.id}::uuid, 'Photo', 1024) RETURNING id, short_id
    `;
    const [account] = await sql<{ id: string }[]>`
      INSERT INTO auth.service_accounts (name, kind) VALUES (${`Photo privacy ${shortId()}`}, 'agent') RETURNING id
    `;
    try {
      const [access] = await sql<{ id: string }[]>`
        INSERT INTO auth.access (service_account_id, permission) VALUES (${account!.id}::uuid, 'write') RETURNING id
      `;
      await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${resource!.id}::uuid, ${access!.id}::uuid)`;
      const token = await serviceAccountCredentials.createApiToken({
        serviceAccountId: account!.id,
        name: "photo",
        scopes: ["read", "write"],
      });
      if (!token.ok) throw token.error;
      const headers = { authorization: `Bearer ${token.data.token}` };
      const base = `/${resource!.short_id}/items/${item!.short_id}/attachments`;
      const jpeg = await tinyJpeg();
      const input = withCameraMetadata(jpeg, 1);
      const upload = (bytes: Uint8Array) => {
        const form = new FormData();
        form.set("file", new File([new Uint8Array(bytes)], "photo.jpg", { type: "image/png" }));
        return api.request(base, { method: "POST", headers, body: form });
      };
      const response = await upload(input);
      expect(response.status).toBe(200);
      const attachment = z.object({ id: z.string(), sizeBytes: z.number(), kind: z.string() }).parse(await response.json());
      expect(attachment.kind).toBe("image");
      expect(attachment.sizeBytes).toBe(jpeg.length);
      const content = await api.request(`${base}/${attachment.id}/content`, { headers });
      expect(content.status).toBe(200);
      expect(new Uint8Array(await content.arrayBuffer())).toEqual(jpeg);
      await spacesService.item.attachments.upload({
        itemId: item!.id,
        spaceId: resource!.id,
        filename: "direct.jpg",
        mimeType: "image/png",
        content: input,
        userId: null,
      });
      const rows = await sql<{ content: Uint8Array; size_bytes: number | string }[]>`
        SELECT content, size_bytes FROM spaces.item_attachments WHERE item_id = ${item!.id}::uuid
      `;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.content).toEqual(jpeg);
        expect(Number(row.size_bytes)).toBe(jpeg.length);
      }
      expect((await upload(input.subarray(0, 30))).status).toBe(422);
      const listed = await api.request(base, { headers });
      expect(z.array(z.unknown()).parse(await listed.json())).toHaveLength(2);
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${resource!.id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${account!.id}::uuid`;
    }
  });
});
