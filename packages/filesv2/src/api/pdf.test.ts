import { expect, mock, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { generateSpecs } from "hono-openapi";
import { testActor, testCall } from "../../test/files-call";
import type { PdfEvent } from "../pdf-contracts";
import { FilesError } from "../service/errors";
import { FilesPdfError } from "../service/pdf";
import { apiError } from "./api-error";
import { errorMessage } from "./messages";
import { createPdfApi } from "./pdf";

type Prepare = Parameters<typeof createPdfApi>[0];
const input = { operation: "merge", paths: ["folder/a.pdf", "b.pdf"], name: "out.pdf" };
function app(prepare: Prepare) {
  return new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("actor", testActor);
      c.set("accessSubject", testCall(testActor).accessSubject);
      c.set("credentialKind", "session");
      await next();
    })
    .onError((error, c) => {
      const mapped = apiError(error);
      return c.json({ ok: false, code: mapped.code, error: errorMessage(mapped.code, "de") }, mapped.status);
    })
    .route("/", createPdfApi(prepare));
}
const request = (body: unknown = input, signal?: AbortSignal) =>
  new Request("http://localhost/bases/base/pdf", {
    method: "POST",
    headers: { "content-type": "application/json", "accept-language": "de" },
    body: JSON.stringify(body),
    signal,
  });

test("PDF route streams its first progress line before work completes", async () => {
  let finish: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const prepare = mock<NonNullable<Prepare>>(async (_call, baseId, value) => {
    expect(baseId).toBe("base");
    expect(value).toEqual(input);
    return {
      timeoutMs: 10_000,
      run: async (emit) => {
        await emit({ type: "progress", done: 0, total: 4 });
        await pending;
        await emit({ type: "error", code: "pdf_failed", message: "failed" });
      },
    };
  });
  const response = await app(prepare).fetch(request());
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/x-ndjson");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"type":"progress","done":0,"total":4}\n');
  finish();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"type":"error","code":"pdf_failed","message":"failed"}\n');
  expect((await reader.read()).done).toBe(true);
});

test("a source failure emits one terminal localized error and its exact path", async () => {
  const response = await app(async () => ({
    timeoutMs: 10_000,
    run: async (emit) => {
      await emit({ type: "progress", done: 0, total: 4 });
      throw new FilesPdfError("pdf_encrypted", "folder/Expertise.pdf");
    },
  })).fetch(request());
  const lines: PdfEvent[] = (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(lines).toEqual([
    { type: "progress", done: 0, total: 4 },
    {
      type: "error",
      code: "pdf_encrypted",
      path: "folder/Expertise.pdf",
      message: "„Expertise.pdf“ ist mit einem Kennwort geschützt.",
    },
  ]);
});

test("invalid JSON contracts and denied preflight never start a stream", async () => {
  const prepare = mock<NonNullable<Prepare>>(async () => {
    throw new FilesError("forbidden", 403);
  });
  const route = app(prepare);
  expect((await route.fetch(request({ ...input, operation: "extract", pages: [0] }))).status).toBe(400);
  expect(prepare).not.toHaveBeenCalled();
  const denied = await route.fetch(request());
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ ok: false, code: "forbidden" });
});

test("oversized request metadata returns the standard Files JSON error before parsing", async () => {
  const prepare = mock<NonNullable<Prepare>>(async () => {
    throw new Error("must not run");
  });
  const oversized = request();
  oversized.headers.set("content-length", "10485761");
  const response = await app(prepare).fetch(oversized);
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ ok: false, code: "pdf_too_large" });
  expect(prepare).not.toHaveBeenCalled();
});

test("OpenAPI publishes the exact mutation path, JSON body and NDJSON response", async () => {
  const specs = await generateSpecs(
    app(async () => {
      throw new Error("must not run");
    }),
  );
  const route = specs.paths?.["/bases/{baseId}/pdf"]?.post;
  expect(route?.summary).toContain("PDF");
  expect(route?.requestBody).toHaveProperty("content.application/json");
  expect(route?.responses?.["200"]).toHaveProperty("content.application/x-ndjson");
});

test("cancelling the response cancels the active work signal", async () => {
  let cancelled: () => void = () => {};
  const aborted = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const response = await app(async () => ({
    timeoutMs: 10_000,
    run: async (emit, signal) => {
      signal.addEventListener("abort", cancelled, { once: true });
      await emit({ type: "progress", done: 0, total: 4 });
      await aborted;
      signal.throwIfAborted();
    },
  })).fetch(request());
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  await aborted;
});
