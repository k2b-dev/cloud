import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { expect, test } from "bun:test";
import { serviceAccountCredentials, settings } from "@k2b/cloud/services";
import { sql } from "bun";
import api from ".";

const shortId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 6);

databaseSuite()("PDF route admission and idle timeout", () => {
  test("slow rendering returns localized 504 and denied oversized requests never parse their body", async () => {
    const [notebook] = await sql<{ id: string; short_id: string }[]>`INSERT INTO notebooks.notebooks (short_id, name)
      VALUES (${shortId()}, 'PDF route fixture') RETURNING id, short_id`;
    const [note] = await sql<{ short_id: string }[]>`INSERT INTO notebooks.notes (short_id, notebook_id, title, content_md)
      VALUES (${shortId()}, ${notebook!.id}::uuid, 'Timeout fixture', '# Timeout') RETURNING short_id`;
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
      VALUES (${`PDF route ${shortId()}`}, 'agent') RETURNING id`;
    const keys = ["gotenberg.url", "gotenberg.timeout_ms"];
    const saved = await sql<
      { key: string; value: string }[]
    >`SELECT key, value FROM settings.entries WHERE key IN ('gotenberg.url', 'gotenberg.timeout_ms')`;
    const originalValues = new Map(await Promise.all(keys.map(async (key) => [key, await settings.get(key)] as const)));
    const hanging = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
    // Record the idle timeouts the route sets on its socket. Bun 1.4 does not drop a pending POST at its idle
    // timeout (measured), so the raise is checked directly: both phases plus 10 s, then the default before answering.
    const timeouts: number[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, bunServer) =>
        api.fetch(request, {
          timeout: (raw: Request, seconds: number) => {
            timeouts.push(seconds);
            bunServer.timeout(raw, seconds);
          },
        }),
    });
    try {
      const token = await serviceAccountCredentials.createApiToken({ serviceAccountId: account!.id, name: "pdf", scopes: ["read"] });
      if (!token.ok) throw token.error;
      const headers = { authorization: `Bearer ${token.data.token}`, "content-type": "application/json", "accept-language": "de" };
      const url = new URL(`/${notebook!.short_id}/notes/${note!.short_id}/pdf`, server.url);
      const denied = await fetch(url, { method: "POST", headers, body: "x".repeat(400 * 1024) });
      expect([403, 404]).toContain(denied.status);
      await denied.body?.cancel();
      expect(timeouts).toEqual([]);
      const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access (service_account_id, permission)
        VALUES (${account!.id}::uuid, 'read') RETURNING id`;
      await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${notebook!.id}::uuid, ${access!.id}::uuid)`;
      await settings.set("gotenberg.url", hanging.url.origin);
      await settings.set("gotenberg.timeout_ms", 1000);
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ markdown: "# Timeout" }),
        signal: AbortSignal.timeout(10000),
      });
      expect(response.status).toBe(504);
      expect(timeouts).toEqual([12, 10]);
      expect(await response.json()).toMatchObject({ message: "Der PDF-Renderer hat das Zeitlimit überschritten. Versuche es erneut." });
    } finally {
      await server.stop(true);
      await hanging.stop(true);
      // Restore the original values, including absence; the public settings service invalidates its cache.
      for (const key of keys) {
        const row = saved.find((row) => row.key === key);
        if (row) await settings.set(key, originalValues.get(key));
        else await settings.remove(key);
      }
      await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebook!.id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${account!.id}::uuid`;
    }
  }, 20000);
});
