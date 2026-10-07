import { expect, setDefaultTimeout, test } from "bun:test";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { newShortId } from "../lib/short-id";
import spacesApi from ".";

const suite = databaseSuite();
setDefaultTimeout(30_000);

const reel = new Uint8Array(await Bun.file(new URL("../../../ui/test/media/portrait-180x320.webm", import.meta.url)).arrayBuffer());

suite("Spaces task attachment content", () => {
  test("a video attachment plays inline by range, and downloads whole on request", async () => {
    const [space] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, 'Video attachments') RETURNING id, short_id
    `;
    let accountId: string | null = null;
    try {
      const [column] = await sql<{ id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
        VALUES (${newShortId()}, ${space!.id}::uuid, 'Review', 1024, false) RETURNING id
      `;
      const [task] = await sql<{ short_id: string }[]>`
        INSERT INTO spaces.items (short_id, space_id, column_id, title, rank)
        VALUES (${newShortId()}, ${space!.id}::uuid, ${column!.id}::uuid, 'Approve the reel', 1024) RETURNING short_id
      `;
      const [account] = await sql<{ id: string }[]>`
        INSERT INTO auth.service_accounts (name, kind) VALUES (${`Video attachments ${newShortId()}`}, 'agent') RETURNING id
      `;
      accountId = account!.id;
      const [access] = await sql<{ id: string }[]>`
        INSERT INTO auth.access (service_account_id, permission) VALUES (${accountId}::uuid, 'write') RETURNING id
      `;
      await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${space!.id}::uuid, ${access!.id}::uuid)`;
      const token = await serviceAccountCredentials.createApiToken({
        serviceAccountId: accountId,
        name: "attachments",
        scopes: ["read", "write"],
      });
      if (!token.ok) throw new Error(token.error.message);
      const authorization = `Bearer ${token.data.token}`;
      const base = `/${space!.short_id}/items/${task!.short_id}/attachments`;

      // A browser that knows no type for .mov sends it as octet-stream; Spaces stores the video type of its extension.
      const form = new FormData();
      form.set("file", new File([reel], "Reel for approval.mov", { type: "application/octet-stream" }));
      const uploaded = await spacesApi.request(base, { method: "POST", headers: { authorization }, body: form });
      expect(uploaded.status).toBe(200);
      const attachment = (await uploaded.json()) as { id: string; mimeType: string; kind: string; sizeBytes: number };
      expect(attachment).toMatchObject({ mimeType: "video/quicktime", kind: "file", sizeBytes: reel.length });

      const listed = await spacesApi.request(base, { headers: { authorization } });
      expect(await listed.json()).toEqual([expect.objectContaining({ id: attachment.id, mimeType: "video/quicktime" })]);

      const content = (range?: string, query = "") =>
        spacesApi.request(`${base}/${attachment.id}/content${query}`, {
          headers: { authorization, ...(range ? { range } : {}) },
        });
      const whole = await content();
      expect(whole.status).toBe(200);
      expect(whole.headers.get("content-type")).toBe("video/quicktime");
      expect(whole.headers.get("content-disposition")).toStartWith("inline;");
      expect(whole.headers.get("accept-ranges")).toBe("bytes");
      expect(whole.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await whole.arrayBuffer())).toEqual(reel);

      // The probe Safari sends first, a seek, the tail a player reads, and an open range from the middle.
      const probe = await content("bytes=0-1");
      expect(probe.status).toBe(206);
      expect(probe.headers.get("content-range")).toBe(`bytes 0-1/${reel.length}`);
      expect(probe.headers.get("content-length")).toBe("2");
      expect(new Uint8Array(await probe.arrayBuffer())).toEqual(reel.subarray(0, 2));
      const seek = await content("bytes=1000-1999");
      expect(seek.status).toBe(206);
      expect(seek.headers.get("content-range")).toBe(`bytes 1000-1999/${reel.length}`);
      expect(new Uint8Array(await seek.arrayBuffer())).toEqual(reel.subarray(1000, 2000));
      const tail = await content("bytes=-100");
      expect(new Uint8Array(await tail.arrayBuffer())).toEqual(reel.subarray(reel.length - 100));
      const rest = await content(`bytes=${reel.length - 10}-`);
      expect(rest.headers.get("content-range")).toBe(`bytes ${reel.length - 10}-${reel.length - 1}/${reel.length}`);
      expect(new Uint8Array(await rest.arrayBuffer())).toEqual(reel.subarray(reel.length - 10));
      const outside = await content(`bytes=${reel.length}-`);
      expect(outside.status).toBe(416);
      expect(outside.headers.get("content-range")).toBe(`bytes */${reel.length}`);

      const download = await content(undefined, "?download=true");
      expect(download.headers.get("content-type")).toBe("application/octet-stream");
      expect(download.headers.get("content-disposition")).toStartWith("attachment;");

      // Other files stay downloads, also when a client claims an HTML type.
      const page = new FormData();
      page.set("file", new File(["<script>alert(1)</script>"], "notes.html", { type: "text/html" }));
      const other = (await (await spacesApi.request(base, { method: "POST", headers: { authorization }, body: page })).json()) as {
        id: string;
      };
      const html = await spacesApi.request(`${base}/${other.id}/content`, { headers: { authorization } });
      expect(html.headers.get("content-type")).toBe("application/octet-stream");
      expect(html.headers.get("content-disposition")).toStartWith("attachment;");
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${space!.id}::uuid`;
      if (accountId) {
        await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${accountId}::uuid`;
        await sql`DELETE FROM auth.access WHERE service_account_id = ${accountId}::uuid`;
        await sql`DELETE FROM auth.service_accounts WHERE id = ${accountId}::uuid`;
      }
    }
  });
});
