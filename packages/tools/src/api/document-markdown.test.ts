import { describe, expect, test } from "bun:test";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { DocumentExtractionError } from "@valentinkolb/cloud/services/document-extraction";
import type { MiddlewareHandler } from "hono";
import { generateSpecs } from "hono-openapi";
import { createDocumentMarkdownRoutes, DOCUMENT_MARKDOWN_MAX_REQUEST_BYTES, DocumentMarkdownResponseSchema } from "./document-markdown";

const pass: MiddlewareHandler<AuthContext> = async (_c, next) => next();

const multipartRequest = (content: string, filename = "notes.rtf") => {
  const boundary = "tools-document-test-boundary";
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    "Content-Type: application/rtf",
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(new TextEncoder().encode(body).byteLength),
    },
    body,
  };
};

const slowMultipartRequest = (content: string) => {
  const boundary = "tools-document-slow-boundary";
  const prefix = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="notes.rtf"',
    "Content-Type: application/rtf",
    "",
    "",
  ].join("\r\n");
  const suffix = `${content}\r\n--${boundary}--\r\n`;
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      controller.enqueue(encoder.encode(prefix));
    },
  });
  const request = new Request("http://tools.local/markdown", {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(encoder.encode(prefix + suffix).byteLength),
    },
    body,
  });
  return {
    request,
    finish: () => {
      streamController?.enqueue(encoder.encode(suffix));
      streamController?.close();
    },
  };
};

describe("Document to Markdown API", () => {
  test("authenticates and rate-limits before conversion", async () => {
    let rateReached = false;
    let extractionReached = false;
    const app = createDocumentMarkdownRoutes({
      authenticate: async (c) => c.json({ message: "Authentication required" }, 401),
      rateLimiter: async (_c, next) => {
        rateReached = true;
        await next();
      },
      extract: async () => {
        extractionReached = true;
        throw new Error("must not run");
      },
    });

    const response = await app.request("/markdown", multipartRequest("{\\rtf1 Cloud}"));

    expect(response.status).toBe(401);
    expect(rateReached).toBe(false);
    expect(extractionReached).toBe(false);
  });

  test("does not parse or convert a rate-limited upload", async () => {
    let extracted = false;
    const app = createDocumentMarkdownRoutes({
      authenticate: pass,
      rateLimiter: async (c) => c.json({ message: "Rate limit exceeded" }, 429),
      extract: async () => {
        extracted = true;
        throw new Error("must not run");
      },
    });

    const response = await app.request("/markdown", multipartRequest("{\\rtf1 Cloud}"));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ message: "Rate limit exceeded" });
    expect(extracted).toBe(false);
  });

  test("returns a typed non-persistent conversion result", async () => {
    let receivedFilename = "";
    let receivedBytes = 0;
    let receivedSignal = false;
    const app = createDocumentMarkdownRoutes({
      authenticate: pass,
      rateLimiter: pass,
      extract: async (input) => {
        receivedFilename = input.filename ?? "";
        receivedBytes = input.bytes.byteLength;
        receivedSignal = input.signal instanceof AbortSignal;
        return {
          format: "rtf",
          markdown: "# Notes\n\nCloud",
          inputBytes: input.bytes.byteLength,
          outputBytes: 14,
          truncated: false,
        };
      },
    });

    const response = await app.request("/markdown", multipartRequest("{\\rtf1 Cloud}"));
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(DocumentMarkdownResponseSchema.parse(body)).toEqual({
      filename: "notes.rtf",
      format: "rtf",
      markdown: "# Notes\n\nCloud",
      inputBytes: receivedBytes,
      outputBytes: 14,
      truncated: false,
    });
    expect(receivedFilename).toBe("notes.rtf");
    expect(receivedBytes).toBeGreaterThan(0);
    expect(receivedSignal).toBe(true);
  });

  test("converts a real document through the public Cloud service", async () => {
    const app = createDocumentMarkdownRoutes({ authenticate: pass, rateLimiter: pass });

    const response = await app.request(
      "/markdown",
      multipartRequest("{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Arial;}}\\f0\\fs24 Cloud document extraction}", "cloud.rtf"),
    );
    const body = DocumentMarkdownResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.filename).toBe("cloud.rtf");
    expect(body.format).toBe("rtf");
    expect(body.markdown).toContain("Cloud document extraction");
    expect(body.truncated).toBe(false);
  });

  test("rejects an oversized request before multipart parsing", async () => {
    let extracted = false;
    const app = createDocumentMarkdownRoutes({
      authenticate: pass,
      rateLimiter: pass,
      extract: async () => {
        extracted = true;
        throw new Error("must not run");
      },
    });

    const response = await app.request("/markdown", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(DOCUMENT_MARKDOWN_MAX_REQUEST_BYTES + 1),
      },
      body: "--x--\r\n",
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      code: "input_too_large",
      message: "The document exceeds the 20 MB limit.",
    });
    expect(extracted).toBe(false);
  });

  test("bounds the actual request body when Content-Length understates it", async () => {
    let extracted = false;
    const app = createDocumentMarkdownRoutes({
      authenticate: pass,
      rateLimiter: pass,
      extract: async () => {
        extracted = true;
        throw new Error("must not run");
      },
    });
    const request = multipartRequest("x".repeat(DOCUMENT_MARKDOWN_MAX_REQUEST_BYTES + 1));
    request.headers["content-length"] = "1";

    const response = await app.request("/markdown", request);

    expect(response.status).toBe(413);
    expect(extracted).toBe(false);
  });

  test("rejects excess concurrent native conversions without queueing another upload", async () => {
    const releases: Array<() => void> = [];
    let started = 0;
    const app = createDocumentMarkdownRoutes({
      authenticate: pass,
      rateLimiter: pass,
      extract: async (input) => {
        started += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
        return {
          format: "rtf",
          markdown: "Cloud",
          inputBytes: input.bytes.byteLength,
          outputBytes: 5,
          truncated: false,
        };
      },
    });

    const first = app.request("/markdown", multipartRequest("{\\rtf1 First}"));
    const second = app.request("/markdown", multipartRequest("{\\rtf1 Second}"));
    while (started < 2) await Promise.resolve();
    const third = await app.request("/markdown", multipartRequest("{\\rtf1 Third}"));

    expect(third.status).toBe(503);
    expect(started).toBe(2);
    for (const release of releases) release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  test("does not reserve native conversion capacity for incomplete uploads", async () => {
    let started = 0;
    const app = createDocumentMarkdownRoutes({
      authenticate: pass,
      rateLimiter: pass,
      extract: async (input) => {
        started += 1;
        return {
          format: "rtf",
          markdown: "Cloud",
          inputBytes: input.bytes.byteLength,
          outputBytes: 5,
          truncated: false,
        };
      },
    });
    const first = slowMultipartRequest("{\\rtf1 First}");
    const second = slowMultipartRequest("{\\rtf1 Second}");
    const firstResponse = app.fetch(first.request);
    const secondResponse = app.fetch(second.request);
    await Promise.resolve();

    const complete = await app.request("/markdown", multipartRequest("{\\rtf1 Complete}"));
    expect(complete.status).toBe(200);
    expect(started).toBe(1);

    first.finish();
    second.finish();
    expect((await firstResponse).status).toBe(200);
    expect((await secondResponse).status).toBe(200);
  });

  test("projects extraction errors without leaking internal details", async () => {
    const app = createDocumentMarkdownRoutes({
      authenticate: pass,
      rateLimiter: pass,
      extract: async () => {
        throw new DocumentExtractionError("ocr_required", "The PDF has no readable text and requires OCR.");
      },
    });

    const response = await app.request("/markdown", multipartRequest("not really a pdf", "scan.pdf"));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      code: "ocr_required",
      message: "The PDF has no readable text and requires OCR.",
    });
  });

  test("localizes the human message for a German request locale with a stable code", async () => {
    const app = createDocumentMarkdownRoutes({
      authenticate: pass,
      rateLimiter: pass,
      extract: async () => {
        throw new Error("must not run");
      },
    });
    const base = multipartRequest("{\\rtf1 Cloud}", `${"a".repeat(252)}.rtf`);
    const request = { ...base, headers: { ...base.headers, "accept-language": "de-CH" } };

    const response = await app.request("/markdown", request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "malformed",
      message: "Der Dateiname darf höchstens 255 Zeichen lang sein.",
    });
  });

  test("publishes the documented multipart operation", async () => {
    const spec = await generateSpecs(createDocumentMarkdownRoutes({ authenticate: pass, rateLimiter: pass }));
    const operation = spec.paths?.["/markdown"]?.post;

    expect(operation?.summary).toBe("Convert a document to Markdown");
    expect(operation?.security).toEqual([{ cookieAuth: [], bearerAuth: [] }]);
    expect(operation?.requestBody).toBeDefined();
    expect(operation?.responses?.["200"]).toBeDefined();
    expect(operation?.responses?.["413"]).toBeDefined();
    expect(operation?.responses?.["422"]).toBeDefined();
    expect(operation?.responses?.["503"]).toBeDefined();
  });
});
