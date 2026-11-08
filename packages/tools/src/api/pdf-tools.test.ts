import { describe, expect, spyOn, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { type GotenbergConfig, GotenbergRenderError, type PdfToolOperation, pdfToolLimits } from "@k2b/cloud/services/pdf";
import type { MiddlewareHandler } from "hono";
import { generateSpecs } from "hono-openapi";
import { createToolsApiRouter } from ".";
import { createPdfToolsRoutes } from "./pdf-tools";

const config: GotenbergConfig = { url: "http://renderer.invalid", timeoutMs: 10_000, maxPdfBytes: 1024, maxHtmlBytes: 16 * 1024 };
const pass: MiddlewareHandler<AuthContext> = async (_c, next) => next();
const result = { data: new TextEncoder().encode("%PDF-result"), contentType: "application/pdf", extension: "pdf" } as const;
const form = (operation: PdfToolOperation = { kind: "merge" }) => {
  const value = new FormData();
  value.append("files", new Blob(["%PDF-source"], { type: "application/pdf" }), "../../private\r\n.pdf");
  value.set("operation", JSON.stringify(operation));
  return value;
};
const setup = (dependencies: Parameters<typeof createPdfToolsRoutes>[0] = {}) =>
  createPdfToolsRoutes({ authenticate: pass, rateLimiter: pass, config: async () => config, run: async () => result, ...dependencies });

function streamed(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request("http://localhost/", {
    method: "POST",
    body,
    headers: { "content-type": "multipart/form-data; boundary=pdf", ...headers },
    signal,
  });
}

describe("PDF tools API", () => {
  test.each([401, 403] as const)("denies %s before reading config, body or running conversion", async (status) => {
    let configRead = false;
    let bodyRead = false;
    let ran = false;
    const app = setup({
      authenticate: async (c) => c.json({ message: "denied" }, status),
      config: async () => {
        configRead = true;
        return config;
      },
      run: async () => {
        ran = true;
        return result;
      },
    });
    const response = await app.fetch(
      streamed(
        new ReadableStream(
          {
            pull() {
              bodyRead = true;
            },
          },
          { highWaterMark: 0 },
        ),
      ),
    );
    expect(response.status).toBe(status);
    expect(configRead).toBe(false);
    expect(bodyRead).toBe(false);
    expect(ran).toBe(false);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("rate limiting precedes upload parsing and returns a visible rejection", async () => {
    let ran = false;
    const response = await setup({
      rateLimiter: async (c) => c.json({ message: "wait" }, 429),
      run: async () => {
        ran = true;
        return result;
      },
    }).request("/", { method: "POST", body: "invalid" });
    expect(response.status).toBe(429);
    expect(ran).toBe(false);
  });

  test("returns bounded private downloads with code-owned filenames and caller cancellation", async () => {
    const abort = new AbortController();
    let operation: unknown;
    let signal: AbortSignal | undefined;
    const app = setup({
      run: async (input, received, options) => {
        operation = input.operation;
        expect(received).toEqual(config);
        expect(input.files).toHaveLength(1);
        signal = options?.signal;
        return result;
      },
    });
    const response = await app.request("/", {
      method: "POST",
      body: form({ kind: "rotate", angle: 90, pages: [1] }),
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="pdf-tools.pdf"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-length")).toBe(String(result.data.length));
    expect(await response.text()).toBe("%PDF-result");
    expect(operation).toEqual({ kind: "rotate", angle: 90, pages: [1] });
    abort.abort();
    expect(signal?.aborted).toBe(true);
  });

  test("returns ZIP downloads for split", async () => {
    const app = setup({ run: async () => ({ data: new Uint8Array([80, 75]), contentType: "application/zip", extension: "zip" }) });
    const response = await app.request("/", { method: "POST", body: form({ kind: "split", groups: [[1], [2]] }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="pdf-tools.zip"');
  });

  test.each([undefined, "1"])("bounds the actual chunked body with Content-Length %s BEFORE FormData allocations", async (length) => {
    const max = pdfToolLimits(config).maxRequestBytes;
    let cancelled = false;
    let runs = 0;
    let chunks = 0;
    using parser = spyOn(Response.prototype, "formData");
    const app = setup({
      run: async () => {
        runs++;
        return result;
      },
    });
    const request = streamed(
      new ReadableStream(
        {
          pull(controller) {
            chunks++;
            controller.enqueue(new Uint8Array(max));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      length ? { "content-length": length } : {},
    );
    const response = await app.fetch(request);
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("pdf_too_large");
    expect(parser).not.toHaveBeenCalled();
    expect(runs).toBe(0);
    expect(cancelled).toBe(true);
    expect(chunks).toBe(2);
  });

  test("accepts multipart headers and PDF bytes fragmented across one-byte chunks", async () => {
    const serialized = new Request("http://localhost/", { method: "POST", body: form() });
    const contentType = serialized.headers.get("content-type")!;
    const bytes = new Uint8Array(await serialized.arrayBuffer());
    let offset = 0;
    const request = streamed(
      new ReadableStream(
        {
          pull(controller) {
            if (offset === bytes.length) controller.close();
            else controller.enqueue(bytes.subarray(offset, ++offset));
          },
        },
        { highWaterMark: 0 },
      ),
      { "content-type": contentType },
    );
    const response = await setup().fetch(request);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("%PDF-result");
  });

  test("rejects oversized declared body, invalid content type, malformed multipart and duplicate/unknown fields", async () => {
    let runs = 0;
    const app = setup({
      run: async () => {
        runs++;
        return result;
      },
    });
    expect(
      (
        await app.fetch(
          streamed(
            new ReadableStream({
              start(c) {
                c.close();
              },
            }),
            { "content-length": "999999" },
          ),
        )
      ).status,
    ).toBe(413);
    for (const body of [new FormData(), "invalid"]) expect((await app.request("/", { method: "POST", body })).status).toBe(400);
    for (const mutate of [
      (f: FormData) => f.append("operation", '{"kind":"merge"}'),
      (f: FormData) => f.set("url", "https://third-party.invalid"),
      (f: FormData) => f.set("operation", '{"kind":"merge","url":"https://third-party.invalid"}'),
      (f: FormData) => f.set("operation", "not JSON"),
      (f: FormData) => f.set("files", "not a file"),
      (f: FormData) => f.set("files", new Blob(["not a PDF"], { type: "image/png" }), "photo.pdf"),
      (f: FormData) => f.set("operation", '{"kind":"rotate","angle":45}'),
      (f: FormData) => f.set("operation", '{"kind":"extract","pages":[2,1]}'),
      (f: FormData) => f.set("operation", '{"kind":"reorder","pages":[1,1]}'),
    ]) {
      const data = form();
      mutate(data);
      expect((await app.request("/", { method: "POST", body: data })).status, String(mutate)).toBe(400);
    }
    expect(runs).toBe(0);
  });

  test("validates declared multipart MIME before parsing, independently of PDF magic", async () => {
    using parser = spyOn(Response.prototype, "formData");
    let ran = false;
    const app = setup({
      run: async () => {
        ran = true;
        return result;
      },
    });
    const body = form();
    body.set("files", new Blob(["%PDF-valid-magic"], { type: "image/png" }), "document.pdf");
    const response = await app.request("/", { method: "POST", body });
    expect(response.status).toBe(400);
    expect(parser).not.toHaveBeenCalled();
    expect(ran).toBe(false);
  });

  test("bounds metadata and part count before parsing multipart", async () => {
    using parser = spyOn(Response.prototype, "formData");
    const app = setup();
    const data = form();
    data.append("files", new Blob(["%PDF-a"]), "a.pdf");
    data.append("files", new Blob(["%PDF-b"]), "b.pdf");
    expect((await app.request("/", { method: "POST", body: data })).status).toBe(400);
    const meta = form();
    meta.set("operation", " ".repeat(config.maxHtmlBytes));
    expect((await app.request("/", { method: "POST", body: meta })).status).toBe(413);
    expect(parser).not.toHaveBeenCalled();
  });

  test("checks aggregate file bytes and derived file/page counts before work", async () => {
    let runs = 0;
    const app = setup({
      run: async () => {
        runs++;
        return result;
      },
    });
    const large = form();
    large.set("files", new Blob(["%PDF-", new Uint8Array(1024)], { type: "application/pdf" }), "large.pdf");
    expect((await app.request("/", { method: "POST", body: large })).status).toBe(413);
    const many = form();
    many.append("files", new Blob(["%PDF-2"]), "2.pdf");
    many.append("files", new Blob(["%PDF-3"]), "3.pdf");
    expect((await app.request("/", { method: "POST", body: many })).status).toBe(400);
    expect((await app.request("/", { method: "POST", body: form({ kind: "extract", pages: [1, 2, 3] }) })).status).toBe(400);
    expect(runs).toBe(0);
  });

  test("rejects local upload saturation before reading another body, then recovers", async () => {
    const releases: (() => void)[] = [];
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const app = setup({
      run: async () => {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
          if (releases.length === 2) markStarted();
        });
        return result;
      },
    });
    const a = app.request("/", { method: "POST", body: form() });
    const b = app.request("/", { method: "POST", body: form() });
    await started;
    let read = false;
    const response = await app.fetch(
      streamed(
        new ReadableStream(
          {
            pull() {
              read = true;
            },
          },
          { highWaterMark: 0 },
        ),
      ),
    );
    expect(response.status).toBe(503);
    expect(read).toBe(false);
    releases.forEach((release) => release());
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    expect((await app.request("/", { method: "POST", body: "invalid" })).status).toBe(400);
  });

  test("cancels a stalled upload and preserves the original request idle timer", async () => {
    const abort = new AbortController();
    let cancelled = false;
    let reading: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const request = streamed(
      new ReadableStream(
        {
          pull() {
            reading();
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      {},
      abort.signal,
    );
    const timeouts: [Request, number][] = [];
    const response = setup().fetch(request, { timeout: (raw: Request, seconds: number) => timeouts.push([raw, seconds]) });
    await started;
    abort.abort();
    expect((await response).status).toBe(408);
    expect(cancelled).toBe(true);
    expect(timeouts).toEqual([
      [request, 11],
      [request, 10],
    ]);
  });

  test("the configured deadline also stops stalled upload parsing", async () => {
    const response = await setup({ config: async () => ({ ...config, timeoutMs: 100 }) }).fetch(
      streamed(new ReadableStream({}, { highWaterMark: 0 })),
    );
    expect(response.status).toBe(504);
    expect((await response.json()).code).toBe("renderer_timeout");
  });

  test.each([
    ["bad_input", undefined, 400, "bad_input"],
    ["pdf_too_large", undefined, 413, "pdf_too_large"],
    ["busy", 503, 503, "renderer_busy"],
    ["not_configured", undefined, 503, "renderer_not_configured"],
    ["timeout", undefined, 504, "renderer_timeout"],
    ["bad_response", 400, 422, "renderer_rejected"],
    ["bad_response", 500, 502, "renderer_failed"],
    ["request_failed", undefined, 502, "renderer_failed"],
  ] as const)("maps %s/%s to stable HTTP %s/%s without renderer detail", async (code, upstreamStatus, status, expected) => {
    const app = setup({
      run: async () => {
        throw new GotenbergRenderError(code, "private renderer details", upstreamStatus);
      },
    });
    const response = await app.request("/", { method: "POST", body: form() });
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.code).toBe(expected);
    expect(body.message).not.toContain("private");
  });

  test("uses the request locale for recovery messages", async () => {
    const app = setup();
    const response = await app.request("/", { method: "POST", body: "invalid", headers: { "x-cloud-locale": "de" } });
    expect((await response.json()).message).toBe("Wähle PDF-Dateien und gültige Seiten für diese Aktion.");
  });

  test("discovers PDF operations at the mounted Tools API path", async () => {
    const specs = await generateSpecs(createToolsApiRouter());
    const operation = specs.paths?.["/pdf"]?.post;
    expect(operation?.summary).toContain("PDF");
    expect(operation?.responses?.["200"]).toHaveProperty("content.application/pdf");
    expect(operation?.responses?.["200"]).toHaveProperty("content.application/zip");
    expect(operation?.requestBody).toHaveProperty("content.multipart/form-data");
    expect(operation?.responses?.["401"]).toBeDefined();
  });

  test("publishes the factory's binary contract to OpenAPI", async () => {
    const specs = await generateSpecs(setup());
    const route = specs.paths?.["/"]?.post;
    expect(route?.summary).toContain("PDF");
    expect(route?.responses?.["200"]).toHaveProperty("content.application/pdf");
    expect(route?.responses?.["200"]).toHaveProperty("content.application/zip");
    expect(route?.requestBody).toHaveProperty("content.multipart/form-data");
    expect(route?.responses?.["400"]).toHaveProperty("content.application/json");
    expect(route?.responses?.["403"]).toBeDefined();
    expect(route?.responses?.["413"]).toBeDefined();
  });
});
