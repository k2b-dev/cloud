import { describe, expect, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { GotenbergRenderError, MARKDOWN_PDF_MAX_MARKDOWN_BYTES, MarkdownPdfError } from "@k2b/cloud/services/pdf";
import type { MiddlewareHandler } from "hono";
import { generateSpecs } from "hono-openapi";
import { createMarkdownPdfRoutes, MARKDOWN_PDF_MAX_REQUEST_BYTES } from "./markdown-pdf";

const pass: MiddlewareHandler<AuthContext> = async (_c, next) => next();
const request = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("Markdown to PDF API", () => {
  test("authenticates and rate-limits before rendering", async () => {
    let rateReached = false;
    let renderReached = false;
    const app = createMarkdownPdfRoutes({
      authenticate: async (c) => c.json({ message: "Authentication required" }, 401),
      rateLimiter: async (_c, next) => {
        rateReached = true;
        await next();
      },
      render: async () => {
        renderReached = true;
        throw new Error("must not run");
      },
    });

    const response = await app.request("/pdf", request({ markdown: "# Cloud" }));
    expect(response.status).toBe(401);
    expect(rateReached).toBe(false);
    expect(renderReached).toBe(false);
  });

  test("returns a private binary PDF without persisting transport state", async () => {
    let received: unknown;
    const app = createMarkdownPdfRoutes({
      authenticate: pass,
      rateLimiter: pass,
      render: async (input) => {
        received = input;
        return { pdf: new TextEncoder().encode("%PDF-cloud"), contentType: "application/pdf" };
      },
    });

    const response = await app.request("/pdf", request({ markdown: "# Cloud", customCss: "h1 { color: navy; }", filename: "Q3 review" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toContain('filename="Q3 review.pdf"');
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("%PDF-cloud");
    expect(received).toEqual({ markdown: "# Cloud", templateId: undefined, customCss: "h1 { color: navy; }" });
  });

  test("forwards a preset with CSS overrides", async () => {
    let received: unknown;
    const app = createMarkdownPdfRoutes({
      authenticate: pass,
      rateLimiter: pass,
      render: async (input) => {
        received = input;
        return { pdf: new Uint8Array([37, 80, 68, 70]), contentType: "application/pdf" };
      },
    });

    const response = await app.request("/pdf", request({ markdown: "Cloud", templateId: "document", customCss: "body { color: navy; }" }));
    expect(response.status).toBe(200);
    expect(received).toEqual({ markdown: "Cloud", templateId: "document", customCss: "body { color: navy; }" });
  });

  test("sanitizes download filenames", async () => {
    const app = createMarkdownPdfRoutes({
      authenticate: pass,
      rateLimiter: pass,
      render: async () => ({ pdf: new Uint8Array([37, 80, 68, 70]), contentType: "application/pdf" }),
    });
    const response = await app.request("/pdf", request({ markdown: "Cloud", filename: "../bad\r\nname" }));

    expect(response.headers.get("content-disposition")).toContain('filename="bad--name.pdf"');
    expect(response.headers.get("content-disposition")).not.toContain("\r");
    expect(response.headers.get("content-disposition")).not.toContain("\n");

    const bounded = await app.request("/pdf", request({ markdown: "Cloud", filename: "x".repeat(255) }));
    const disposition = bounded.headers.get("content-disposition") ?? "";
    expect(disposition.match(/filename="([^"]+)"/)?.[1]).toHaveLength(255);
  });

  test("enforces actual body and UTF-8 Markdown limits before rendering", async () => {
    let rendered = false;
    const app = createMarkdownPdfRoutes({
      authenticate: pass,
      rateLimiter: pass,
      render: async () => {
        rendered = true;
        throw new Error("must not run");
      },
    });

    const tooLargeBody = await app.request("/pdf", request({ markdown: "x".repeat(MARKDOWN_PDF_MAX_REQUEST_BYTES + 1) }));
    expect(tooLargeBody.status).toBe(413);
    expect(rendered).toBe(false);

    const utf8 = await app.request("/pdf", request({ markdown: "🫶".repeat(Math.floor(MARKDOWN_PDF_MAX_MARKDOWN_BYTES / 4) + 1) }));
    expect(utf8.status).toBe(413);
    expect(await utf8.json()).toEqual({ code: "markdown_too_large", message: "Markdown exceeds the 256 KiB limit." });
    expect(rendered).toBe(false);
  });

  test("rejects excess concurrent renders without queueing", async () => {
    const releases: Array<() => void> = [];
    let started = 0;
    const app = createMarkdownPdfRoutes({
      authenticate: pass,
      rateLimiter: pass,
      render: async () => {
        started += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
        return { pdf: new Uint8Array([37, 80, 68, 70]), contentType: "application/pdf" };
      },
    });

    const first = app.request("/pdf", request({ markdown: "First" }));
    const second = app.request("/pdf", request({ markdown: "Second" }));
    while (started < 2) await Promise.resolve();
    const third = await app.request("/pdf", request({ markdown: "Third" }));

    expect(third.status).toBe(503);
    expect(await third.json()).toEqual({ code: "renderer_busy", message: "PDF rendering is busy. Try again in a moment." });
    for (const release of releases) release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  test("projects stable renderer errors without upstream details", async () => {
    const cases: Array<[Error, number, string]> = [
      [new MarkdownPdfError("external_asset_unsupported", "Custom CSS cannot load external resources."), 422, "external_asset_unsupported"],
      [new GotenbergRenderError("not_configured", "secret URL"), 503, "renderer_not_configured"],
      [new GotenbergRenderError("bad_response", "secret upstream body", 500), 502, "renderer_failed"],
      [new GotenbergRenderError("timeout", "timeout"), 504, "renderer_timeout"],
    ];

    for (const [cause, status, code] of cases) {
      const app = createMarkdownPdfRoutes({ authenticate: pass, rateLimiter: pass, render: async () => Promise.reject(cause) });
      const response = await app.request("/pdf", request({ markdown: "Cloud" }));
      const body = (await response.json()) as { code: string; message: string };
      expect(response.status).toBe(status);
      expect(body.code).toBe(code);
      expect(body.message).not.toContain("secret");
    }
  });

  test("localizes the human message for a German request locale with a stable code", async () => {
    const app = createMarkdownPdfRoutes({
      authenticate: pass,
      rateLimiter: pass,
      render: async () => Promise.reject(new GotenbergRenderError("not_configured", "secret URL")),
    });

    const response = await app.request("/pdf", {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "de-CH" },
      body: JSON.stringify({ markdown: "# Cloud" }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "renderer_not_configured",
      message: "Das PDF-Rendering ist nicht eingerichtet.",
    });
  });

  test("publishes the authenticated binary OpenAPI operation", async () => {
    const spec = await generateSpecs(createMarkdownPdfRoutes({ authenticate: pass, rateLimiter: pass }));
    const operation = spec.paths?.["/pdf"]?.post;

    expect(operation?.summary).toBe("Convert Markdown to PDF");
    expect(operation?.security).toEqual([{ cookieAuth: [], bearerAuth: [] }]);
    expect(operation?.requestBody).toBeDefined();
    expect(JSON.stringify(operation?.responses?.["200"])).toContain("application/pdf");
    expect(operation?.responses?.["413"]).toBeDefined();
    expect(operation?.responses?.["422"]).toBeDefined();
    expect(operation?.responses?.["503"]).toBeDefined();
  });
});
