import { expect, test } from "bun:test";
import { type GotenbergConfig, runPdfToolWithConfig } from "@k2b/cloud/services/pdf";
import { Hono } from "hono";
import { requireInfraUrl, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { createPdfToolsRoutes } from "./pdf-tools";

suiteFor("gotenberg", "valkey")("PDF Tools unreadable uploads with the operator renderer", () => {
  test.each(["damaged", "user-password"] as const)(
    "returns HTTP 422 for a %s PDF",
    async (kind) => {
      const config: GotenbergConfig = {
        url: requireInfraUrl("gotenberg"),
        timeoutMs: 30_000,
        maxHtmlBytes: 1024 * 1024,
        maxPdfBytes: 10 * 1024 * 1024,
      };
      const file =
        kind === "damaged"
          ? new Blob(["%PDF-1.7\nbroken cross-reference and missing page tree"], { type: "application/pdf" })
          : new Blob([await Bun.file(new URL("../../../cloud/src/ai/fixtures/vision-encrypted.pdf", import.meta.url)).arrayBuffer()], {
              type: "application/pdf",
            });
      const app = new Hono().route(
        "/tools/api/pdf",
        createPdfToolsRoutes({
          authenticate: async (c, next) => {
            c.set("accessSubject", { type: "user", userId: "pdf-integration" });
            await next();
          },
          rateLimiter: async (_c, next) => next(),
          config: async () => config,
          run: runPdfToolWithConfig,
        }),
      );
      const form = new FormData();
      form.append("files", file, "source.pdf");
      form.set("operation", JSON.stringify({ kind: "merge" }));
      const response = await app.request("/tools/api/pdf", { method: "POST", body: form });
      expect(response.status).toBe(422);
      expect(["unreadable_pdf", "renderer_rejected"]).toContain((await response.json()).code);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    },
    60_000,
  );
});
