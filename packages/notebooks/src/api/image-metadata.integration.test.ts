import { expect, test } from "bun:test";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import { tinyJpeg, withCameraMetadata } from "../../../../scripts/fixtures/image-metadata";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { notebooksService } from "../service";
import api from ".";

const shortId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 6);

databaseSuite()("notebooks image upload privacy", () => {
  test("API and direct service store sanitized bytes and sizes; malformed images return 422", async () => {
    const [resource] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO notebooks.notebooks (short_id, name) VALUES (${shortId()}, 'Photo privacy') RETURNING id, short_id
    `;
    const [account] = await sql<{ id: string }[]>`
      INSERT INTO auth.service_accounts (name, kind) VALUES (${`Photo privacy ${shortId()}`}, 'agent') RETURNING id
    `;
    try {
      const [access] = await sql<{ id: string }[]>`
        INSERT INTO auth.access (service_account_id, permission) VALUES (${account!.id}::uuid, 'write') RETURNING id
      `;
      await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${resource!.id}::uuid, ${access!.id}::uuid)`;
      const token = await serviceAccountCredentials.createApiToken({
        serviceAccountId: account!.id,
        name: "photo",
        scopes: ["read", "write"],
      });
      if (!token.ok) throw token.error;
      const headers = { authorization: `Bearer ${token.data.token}` };
      const base = `/${resource!.short_id}/attachments`;
      const jpeg = await tinyJpeg();
      const input = withCameraMetadata(jpeg, 1);
      const upload = (bytes: Uint8Array, locale = "en") => {
        const form = new FormData();
        form.set("file", new File([new Uint8Array(bytes)], "photo.jpg", { type: "application/octet-stream" }));
        return api.request(base, { method: "POST", headers: { ...headers, "accept-language": locale }, body: form });
      };
      const response = await upload(input);
      expect(response.status).toBe(200);
      const attachment = z.object({ id: z.string(), sizeBytes: z.number(), kind: z.string() }).parse(await response.json());
      expect(attachment.kind).toBe("image");
      expect(attachment.sizeBytes).toBe(jpeg.length);
      const content = await api.request(`${base}/${attachment.id}/content`, { headers });
      expect(content.status).toBe(200);
      expect(new Uint8Array(await content.arrayBuffer())).toEqual(jpeg);
      await notebooksService.attachment.upload({
        notebookId: resource!.id,
        filename: "direct.jpg",
        mimeType: "application/octet-stream",
        content: input,
        userId: null,
      });
      const rows = await sql<{ content: Uint8Array; size_bytes: number | string }[]>`
        SELECT content, size_bytes FROM notebooks.attachments WHERE notebook_id = ${resource!.id}::uuid
      `;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.content).toEqual(jpeg);
        expect(Number(row.size_bytes)).toBe(jpeg.length);
      }
      const malformed = await upload(input.subarray(0, 30), "de");
      expect(malformed.status).toBe(422);
      expect(await malformed.json()).toMatchObject({
        code: "MALFORMED_IMAGE",
        message: "Dieses Bild konnte nicht gelesen werden. Exportiere es erneut oder wähle eine andere Datei.",
      });
      const listed = await api.request(base, { headers });
      expect(z.array(z.unknown()).parse(await listed.json())).toHaveLength(2);
    } finally {
      await sql`DELETE FROM notebooks.notebooks WHERE id = ${resource!.id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${account!.id}::uuid`;
    }
  });
});
