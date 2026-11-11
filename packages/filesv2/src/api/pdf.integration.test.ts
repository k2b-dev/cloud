import { expect, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { type GotenbergConfig, renderHtmlToPdfWithConfig, runPdfToolWithConfig } from "@k2b/cloud/services/pdf";
import { Hono } from "hono";
import { requireInfraUrl, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testActor, testCall } from "../../test/files-call";
import type { BaseSummary } from "../contracts";
import type { PdfEvent } from "../pdf-contracts";
import { createPdfOperation } from "../service/pdf";
import { createPdfApi } from "./pdf";

suiteFor("gotenberg", "valkey")("Files PDF API with Gotenberg", () => {
  test("merge and multi-source extraction stream new files and preserve originals", async () => {
    const config: GotenbergConfig = {
      url: requireInfraUrl("gotenberg"),
      timeoutMs: 30_000,
      maxHtmlBytes: 1024 * 1024,
      maxPdfBytes: 10 * 1024 * 1024,
    };
    const original = await renderHtmlToPdfWithConfig(
      { html: "<!doctype html><p>FIRST</p><p style='break-before:page'>SECOND</p>" },
      config,
    );
    const originals = new Map([
      ["folder/first.pdf", original.pdf],
      ["second.pdf", original.pdf.slice()],
    ]);
    const saved = new Map<string, Uint8Array>();
    const base: BaseSummary = {
      id: "base",
      area: "cloud",
      kind: "users",
      name: "Alice",
      status: "existing",
      reason: null,
      indexEnabled: true,
      versioningEnabled: true,
    };
    const prepare = createPdfOperation({
      config: async () => config,
      destination: async () => {},
      source: async (_call, _base, path) => ({
        size: originals.get(path)!.length,
        revision: "seen",
        read: async () => new Response(new Uint8Array(originals.get(path)!)),
      }),
      save: async (_call, _base, path, bytes, signal) => {
        signal.throwIfAborted();
        saved.set(path, bytes);
        return {
          base,
          entry: {
            path,
            name: path.split("/").at(-1)!,
            directory: false,
            size: bytes.length,
            modified: "2026-01-01T00:00:00Z",
            revision: "new-revision",
          },
        };
      },
    });
    const app = new Hono<AuthContext>()
      .use("*", async (c, next) => {
        c.set("actor", testActor);
        c.set("accessSubject", testCall(testActor).accessSubject);
        c.set("credentialKind", "session");
        await next();
      })
      .route("/", createPdfApi(prepare));
    for (const operation of ["merge", "extract"] as const) {
      const response = await app.request("/bases/base/pdf", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation,
          paths: [...originals.keys()],
          name: `${operation}.pdf`,
          ...(operation === "extract" ? { revisions: [...originals.keys()].map(() => "seen"), pages: [2, 3] } : {}),
        }),
      });
      expect(response.status).toBe(200);
      const events: PdfEvent[] = (await response.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const total = operation === "merge" ? 4 : 5;
      expect(events.filter((event) => event.type === "progress").map((event) => event.done)).toEqual(
        Array.from({ length: total + 1 }, (_, i) => i),
      );
      expect(events.at(-1)).toMatchObject({
        type: "done",
        result: { entry: { path: `folder/${operation}.pdf`, revision: "new-revision" } },
      });
      const output = saved.get(`folder/${operation}.pdf`)!;
      expect(new TextDecoder().decode(output.subarray(0, 5))).toBe("%PDF-");
      const pages = operation === "merge" ? 4 : 2;
      // The real renderer inspects the saved output: its last page exists,
      // while the next page is rejected before another transformation.
      await runPdfToolWithConfig({ files: [new Blob([new Uint8Array(output)])], operation: { kind: "extract", pages: [pages] } }, config);
      await expect(
        runPdfToolWithConfig({ files: [new Blob([new Uint8Array(output)])], operation: { kind: "extract", pages: [pages + 1] } }, config),
      ).rejects.toMatchObject({ code: "bad_input" });
    }
    expect(originals.get("folder/first.pdf")).toEqual(original.pdf);
    expect(originals.get("second.pdf")).toEqual(original.pdf);
    expect(saved.size).toBe(2);
  }, 120_000);
});
