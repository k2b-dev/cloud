import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import "../../../../scripts/fixtures/authorization-preload";
import { expect, spyOn, test } from "bun:test";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import * as pdfModule from "@k2b/cloud/services/pdf";
import { sql } from "bun";
import api from ".";

suiteFor("database", "valkey")("PDF route admission and idle timeout", () => {
  test("slow rendering returns localized 504 and denied oversized requests never parse their body", async () => {
    const [notebook] = await sql<{ id: string; short_id: string }[]>`INSERT INTO notebooks.notebooks (short_id, name)
      VALUES (${testShortId()}, 'PDF route fixture') RETURNING id, short_id`;
    const [note] = await sql<{ short_id: string }[]>`INSERT INTO notebooks.notes (short_id, notebook_id, title, content_md)
      VALUES (${testShortId()}, ${notebook!.id}::uuid, 'Timeout fixture', '# Timeout') RETURNING short_id`;
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
      VALUES (${`PDF route ${testShortId()}`}, 'agent') RETURNING id`;
    const config = await pdfModule.getGotenbergConfig();
    const hanging = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
    // Record the idle timeouts the route sets on its socket. Bun 1.4 does not drop a pending POST at its idle
    // timeout (measured), so the raise is checked directly: both phases plus 10 s, then the default before answering.
    // Bun's timer only applies to the socket-backed request it passed in, so record that identity too.
    const timeouts: [boolean, number][] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, bunServer) =>
        api.fetch(request, {
          timeout: (raw: Request, seconds: number) => {
            timeouts.push([raw === request, seconds]);
            bunServer.timeout(raw, seconds);
          },
        }),
    });
    // Shared settings would send concurrent PDF tests in other processes to the hanging server.
    const configSpy = spyOn(pdfModule, "getGotenbergConfig").mockResolvedValue({ ...config, url: hanging.url.origin, timeoutMs: 1000 });
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
      // A streamed (chunked) body makes bodyLimit replace c.req.raw with a request Bun does not know.
      // The body stalls after admission: the route must not raise the idle timeout while it is still read.
      const encoder = new TextEncoder();
      let timeoutsWhileReading: number | undefined;
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode('{"markdown":'));
          while (configSpy.mock.calls.length === 0) await Bun.sleep(10);
          await Bun.sleep(200);
          timeoutsWhileReading = timeouts.length;
          controller.enqueue(encoder.encode('"# Timeout"}'));
          controller.close();
        },
      });
      const response = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10000) });
      expect(response.status).toBe(504);
      expect(timeoutsWhileReading).toBe(0);
      expect(timeouts).toEqual([
        [true, 12],
        [true, 10],
      ]);
      expect(await response.json()).toMatchObject({ message: "Der PDF-Renderer hat das Zeitlimit überschritten. Versuche es erneut." });
    } finally {
      configSpy.mockRestore();
      await server.stop(true);
      await hanging.stop(true);
      await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebook!.id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${account!.id}::uuid`;
    }
  }, 20000);
});
