import { databaseSuite, requireInfraUrl, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import "../../../../scripts/fixtures/authorization-preload";
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { geoMapSnapshotFingerprint, geoMapSnapshotPart } from "@k2b/cloud/contracts/geo-snapshot";
import { serializeGeoDocument } from "@k2b/cloud/geo/document";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import * as pdfModule from "@k2b/cloud/services/pdf";
import { sql } from "bun";
import sharp from "sharp";
import { pdfImages, pdfText, pdfTitle } from "../../../../scripts/fixtures/pdf-info";
import { fictionalMap, fictionalRouteMap } from "../lib/map.test-fixture";
import { notebookMapRevision, parseNotebookMapBlocks } from "../lib/map-blocks";
import { decodeNotePdfOmissions, NOTE_PDF_OMISSIONS_HEADER } from "../lib/pdf-omissions";
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
      const deniedMaps = await fetch(`${url}/maps`, {
        method: "POST",
        headers: { ...headers, "content-type": "multipart/form-data; boundary=invalid" },
        body: "not a multipart body",
      });
      expect([403, 404]).toContain(deniedMaps.status);
      await deniedMaps.body?.cancel();
      const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access (service_account_id, permission)
        VALUES (${account!.id}::uuid, 'read') RETURNING id`;
      await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${notebook!.id}::uuid, ${access!.id}::uuid)`;
      const invalidMaps = new FormData();
      invalidMaps.set("input", JSON.stringify({ markdown: "# Timeout" }));
      invalidMaps.set("mapSnapshots", JSON.stringify({ version: 1, revision: await notebookMapRevision("# Different"), images: [] }));
      const staleMaps = await fetch(`${url}/maps`, {
        method: "POST",
        headers: { authorization: headers.authorization, "accept-language": "de" },
        body: invalidMaps,
      });
      expect(staleMaps.status).toBe(422);
      await staleMaps.body?.cancel();
      timeouts.length = 0;
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

suiteFor(
  "database",
  "nats",
  "valkey",
  "gotenberg",
)("authenticated Notebook map PDF export", () => {
  const markdown = [
    "# Fictional weekend plan",
    "Ordinary unsaved content survives alongside the maps.",
    "| Item | Quantity |\n| --- | --- |\n| Sandwiches | 4 |",
    ":::info\nBring the printed itinerary.\n:::",
    "[Packing guide](https://example.org/packing)",
    serializeGeoDocument(fictionalMap()),
    serializeGeoDocument(fictionalRouteMap()),
    "## End of itinerary\n\nKeep the return ticket.",
  ].join("\n\n");
  const title = "Fictional authenticated PDF";
  const observations: { bodyUsed: boolean; formDataCalls: number }[] = [];
  let notebook: { id: string; short_id: string } | undefined;
  let note: { short_id: string } | undefined;
  let allowedAccount: { id: string } | undefined;
  let deniedAccount: { id: string } | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let headers: { authorization: string; "accept-language": string };
  let deniedHeaders: typeof headers;
  let url: string;
  let revision: string;
  let images: { id: string; fingerprint: string; width: number; height: number; data: Blob }[];
  let configSpy: ReturnType<typeof spyOn<typeof pdfModule, "getGotenbergConfig">> | undefined;
  // These spies call the real implementations: rejected requests must never reach either seam.
  let assetsSpy: ReturnType<typeof spyOn<typeof pdfModule, "prepareGeoMapSnapshotAssets">>;
  let renderSpy: ReturnType<typeof spyOn<typeof pdfModule, "renderHtmlToPdfWithConfig">>;

  const multipart = () => {
    const form = new FormData();
    form.set("input", JSON.stringify({ markdown, templateId: "document" }));
    form.set("mapSnapshots", JSON.stringify({ version: 1, revision, images: images.map(({ data: _data, ...image }) => image) }));
    for (const image of images) form.set(geoMapSnapshotPart(image.id), image.data, "synthetic.png");
    return form;
  };

  beforeAll(async () => {
    assetsSpy = spyOn(pdfModule, "prepareGeoMapSnapshotAssets");
    renderSpy = spyOn(pdfModule, "renderHtmlToPdfWithConfig");
    [notebook] = await sql<{ id: string; short_id: string }[]>`INSERT INTO notebooks.notebooks (short_id, name)
      VALUES (${testShortId()}, 'Synthetic map PDF fixture') RETURNING id, short_id`;
    [note] = await sql<{ short_id: string }[]>`INSERT INTO notebooks.notes (short_id, notebook_id, title, content_md)
      VALUES (${testShortId()}, ${notebook!.id}::uuid, ${title}, '# Persisted text is not the export snapshot') RETURNING short_id`;
    const createAccount = async (name: string) => {
      const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
        VALUES (${`${name} ${testShortId()}`}, 'agent') RETURNING id`;
      return account!;
    };
    allowedAccount = await createAccount("Allowed PDF fixture");
    deniedAccount = await createAccount("Denied PDF fixture");
    const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access (service_account_id, permission)
      VALUES (${allowedAccount.id}::uuid, 'read') RETURNING id`;
    await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${notebook!.id}::uuid, ${access!.id}::uuid)`;
    const accountHeaders = async (id: string) => {
      const token = await serviceAccountCredentials.createApiToken({ serviceAccountId: id, name: "map-pdf", scopes: ["read"] });
      if (!token.ok) throw token.error;
      return { authorization: `Bearer ${token.data.token}`, "accept-language": "en" };
    };
    headers = await accountHeaders(allowedAccount.id);
    deniedHeaders = await accountHeaders(deniedAccount.id);
    revision = await notebookMapRevision(markdown);
    images = await Promise.all(
      parseNotebookMapBlocks(markdown).blocks.map(async (block, index) => {
        const width = 520;
        const height = index ? 150 : 186;
        // Synthetic pixels only. Browser capture is covered separately; no map provider is called here.
        const data = await sharp({ create: { width, height, channels: 3, background: index ? "#cbd5e1" : "#b4d5e0" } })
          .png()
          .toBuffer();
        return {
          id: `line-${block.line}`,
          fingerprint: await geoMapSnapshotFingerprint(block.document),
          width,
          height,
          data: new Blob([data], { type: "image/png" }),
        };
      }),
    );
    const config = await pdfModule.getGotenbergConfig();
    configSpy = spyOn(pdfModule, "getGotenbergConfig").mockResolvedValue({ ...config, url: requireInfraUrl("gotenberg") });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request, bunServer) {
        const parse = spyOn(request, "formData");
        try {
          return await api.fetch(request, bunServer);
        } finally {
          observations.push({ bodyUsed: request.bodyUsed, formDataCalls: parse.mock.calls.length });
          parse.mockRestore();
        }
      },
    });
    url = new URL(`/${notebook!.short_id}/notes/${note!.short_id}/pdf`, server.url).href;
  });

  beforeEach(() => {
    observations.length = 0;
    assetsSpy.mockClear();
    renderSpy.mockClear();
  });

  afterAll(async () => {
    await server?.stop(true);
    configSpy?.mockRestore();
    assetsSpy?.mockRestore();
    renderSpy?.mockRestore();
    if (notebook) await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebook.id}::uuid`;
    for (const account of [allowedAccount, deniedAccount]) {
      if (account) await sql`DELETE FROM auth.service_accounts WHERE id = ${account.id}::uuid`;
    }
  });

  test("anonymous and ungranted callers leave multipart bodies unread and never prepare assets or render", async () => {
    for (const authorization of [undefined, deniedHeaders.authorization]) {
      const response = await fetch(`${url}/maps`, {
        method: "POST",
        headers: { ...(authorization ? { authorization } : {}), "content-type": "multipart/form-data; boundary=invalid" },
        body: "not a multipart body",
      });
      expect(authorization ? [403, 404] : [401, 403]).toContain(response.status);
      await response.body?.cancel();
    }
    expect(observations).toEqual([
      { bodyUsed: false, formDataCalls: 0 },
      { bodyUsed: false, formDataCalls: 0 },
    ]);
    expect(assetsSpy).not.toHaveBeenCalled();
    expect(renderSpy).not.toHaveBeenCalled();
  });

  test("stale revisions, mismatched map fingerprints and incomplete uploads fail before Gotenberg", async () => {
    const manifests = [
      { version: 1, revision: await notebookMapRevision("# Different snapshot"), images },
      {
        version: 1,
        revision,
        images: images.map((image, index) => ({ ...image, fingerprint: index ? image.fingerprint : "0".repeat(64) })),
      },
      { version: 1, revision, images: images.slice(0, 1) },
    ];
    for (const manifest of manifests) {
      const form = multipart();
      form.set("mapSnapshots", JSON.stringify({ ...manifest, images: manifest.images.map(({ data: _data, ...image }) => image) }));
      // No extra PNG may mask the expected-map completeness check with an unrelated-part error.
      for (const image of images) {
        if (!manifest.images.some(({ id }) => id === image.id)) form.delete(geoMapSnapshotPart(image.id));
      }
      const response = await fetch(`${url}/maps`, { method: "POST", headers, body: form });
      expect(response.status).toBe(422);
      await response.body?.cancel();
    }
    const missingPng = multipart();
    missingPng.delete(geoMapSnapshotPart(images[1]!.id));
    const response = await fetch(`${url}/maps`, { method: "POST", headers, body: missingPng });
    expect(response.status).toBe(422);
    await response.body?.cancel();
    expect(assetsSpy).toHaveBeenCalledTimes(4);
    expect(renderSpy).not.toHaveBeenCalled();
  });

  test("complete multipart maps produce a real PDF with both images, attribution, links and ordinary content", async () => {
    const response = await fetch(`${url}/maps`, { method: "POST", headers, body: multipart() });
    expect(response.status).toBe(200);
    // Positive control for the denied-body observations above.
    expect(observations).toEqual([{ bodyUsed: true, formDataCalls: 1 }]);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toContain(".pdf");
    expect(response.headers.get(NOTE_PDF_OMISSIONS_HEADER)).toBeNull();
    const pdf = new Uint8Array(await response.arrayBuffer());
    expect(await pdfTitle(pdf)).toBe(title);
    expect((await pdfImages(pdf)).filter((image) => image.type === "image").map(({ width, height }) => [width, height])).toEqual([
      [520, 186],
      [520, 150],
    ]);
    const text = (await pdfText(pdf)).replace(/\s+/gu, " ");
    for (const content of [
      "Fictional weekend plan",
      "Ordinary unsaved content survives",
      "Sandwiches",
      "Bring the printed itinerary.",
      "Keep the return ticket.",
      "Münster",
      "Museum Ulm",
      "Ulm Hbf",
      "Stuttgart Hbf",
      "95 km",
      "Geoapify",
      "OpenStreetMap",
      "OpenMapTiles",
    ])
      expect(text).toContain(content);
    expect(text).not.toContain("Persisted text is not the export snapshot");
    expect(text).not.toContain(":::");
    expect(text).not.toContain("It is not printed in the PDF yet.");
    const uris = [
      ...Buffer.from(pdf)
        .toString("latin1")
        .matchAll(/\/URI \(([^)]*)\)/g),
    ].map((match) => match[1]);
    for (const link of [
      "https://example.org/packing",
      "https://example.org/museum",
      "https://www.geoapify.com/",
      "https://www.openstreetmap.org/copyright",
      "https://openmaptiles.org/",
    ])
      expect(uris).toContain(link);
    expect(uris.some((uri) => uri?.endsWith(`/app/notebooks/${notebook!.short_id}/notes/Note01?mode=book`))).toBe(true);
    expect(assetsSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    const [saved] = await sql<
      { content_md: string }[]
    >`SELECT content_md FROM notebooks.notes WHERE notebook_id = ${notebook!.id}::uuid AND short_id = ${note!.short_id}`;
    expect(saved?.content_md).toBe("# Persisted text is not the export snapshot");
  }, 60_000);

  test("JSON export keeps attributed map lists and reports both missing map images in its omission header", async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ markdown }),
    });
    expect(response.status).toBe(200);
    expect(decodeNotePdfOmissions(response.headers.get(NOTE_PDF_OMISSIONS_HEADER))).toEqual({
      items: [
        { code: "not_rendered", kind: "map", label: fictionalMap().title },
        { code: "not_rendered", kind: "map", label: fictionalRouteMap().title },
      ],
      more: 0,
    });
    const pdf = new Uint8Array(await response.arrayBuffer());
    // The approved print fallback keeps failure guidance above the preview sheet.
    // Headless clients receive the omission header; the PDF retains attributed lists.
    expect(await pdfImages(pdf)).toEqual([]);
    const text = (await pdfText(pdf)).replace(/\s+/gu, " ");
    for (const content of [
      "Münster",
      "Museum Ulm",
      "Ulm Hbf",
      "Stuttgart Hbf",
      "95 km",
      "Geoapify",
      "OpenStreetMap",
      "Ordinary unsaved content survives",
      "Keep the return ticket.",
    ])
      expect(text).toContain(content);
    expect(Buffer.from(pdf).toString("latin1")).toContain("https://example.org/museum");
    expect(assetsSpy).not.toHaveBeenCalled();
    expect(renderSpy).toHaveBeenCalledTimes(1);
  }, 60_000);
});
