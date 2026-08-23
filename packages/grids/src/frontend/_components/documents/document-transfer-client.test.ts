import { afterEach, describe, expect, test } from "bun:test";
import {
  isPdfResponse,
  requestDocumentDownload,
  requestDocumentTemplateDraftPreview,
  requestDocumentTemplateGeneration,
  requestDocumentTemplatePreview,
  requestWorkflowDocumentsDownload,
} from "./document-transfer-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("document transfer client", () => {
  test("preview encodes the template id and sends only the record id", async () => {
    let captured: [RequestInfo | URL, RequestInit | undefined] | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      captured = [input, init];
      return Promise.resolve(new Response("pdf", { status: 200, headers: { "content-type": "application/pdf" } }));
    }) as typeof fetch;

    const response = await requestDocumentTemplatePreview({ templateId: "template/id", recordId: "record" });

    expect(captured?.[0]).toBe("/api/grids/documents/templates/template%2Fid/preview-pdf");
    expect(captured?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(captured?.[1]?.body))).toEqual({ recordId: "record" });
    expect(isPdfResponse(response)).toBe(true);
  });

  test("generation keeps optional filename and tags in one canonical payload", async () => {
    let body = "";
    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => {
      body = String(init?.body);
      return Promise.resolve(new Response("pdf", { status: 200 }));
    }) as typeof fetch;

    await requestDocumentTemplateGeneration({
      templateId: "template",
      recordId: "record",
      filename: "invoice.pdf",
      tags: ["invoice"],
    });

    expect(JSON.parse(body)).toEqual({ recordId: "record", filename: "invoice.pdf", tags: ["invoice"] });
  });

  test("Document downloads encode ids and only add options when a signal exists", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return Promise.resolve(new Response("pdf", { status: 200 }));
    }) as typeof fetch;

    await requestDocumentDownload("document/id");
    const controller = new AbortController();
    await requestDocumentDownload("other", controller.signal);

    expect(calls[0]).toEqual(["/api/grids/documents/document%2Fid/download", undefined]);
    expect(calls[1]?.[1]?.signal).toBe(controller.signal);
  });

  test("PDF detection requires both success and a PDF content type", () => {
    expect(isPdfResponse(new Response("pdf", { status: 200, headers: { "content-type": "Application/PDF; charset=binary" } }))).toBe(true);
    expect(isPdfResponse(new Response("json", { status: 200, headers: { "content-type": "application/json" } }))).toBe(false);
    expect(isPdfResponse(new Response("error", { status: 400, headers: { "content-type": "application/pdf" } }))).toBe(false);
  });

  test("draft previews choose saved-template or table create routes", async () => {
    const urls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(new Response("pdf", { status: 200 }));
    }) as typeof fetch;
    const draft = { source: "from table Items", html: "<p>Item</p>", recordId: "record" };

    await requestDocumentTemplateDraftPreview({ tableId: "table", templateId: "template/id", draft });
    await requestDocumentTemplateDraftPreview({ tableId: "table/id", draft });

    expect(urls).toEqual([
      "/api/grids/documents/templates/template%2Fid/preview-draft",
      "/api/grids/documents/templates/by-table/table%2Fid/preview-draft",
    ]);
  });

  test("workflow document downloads use the binary transfer boundary", async () => {
    let url = "";
    globalThis.fetch = ((input: RequestInfo | URL) => {
      url = String(input);
      return Promise.resolve(new Response("pdf", { status: 200 }));
    }) as typeof fetch;

    await requestWorkflowDocumentsDownload("run/id");

    expect(url).toBe("/api/grids/workflows/runs/run%2Fid/documents/download");
  });
});
