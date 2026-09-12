import { describe, expect, test } from "bun:test";
import { generateSpecs } from "hono-openapi";
import { createWorkflowDocumentConfirmationRoutes } from "./workflow-document-confirmations";

describe("workflow financial confirmation API", () => {
  test("documents both operations and the normalized profile inputs without accepting caller actors or rows", async () => {
    const spec = await generateSpecs(createWorkflowDocumentConfirmationRoutes());
    expect(spec.paths).toHaveProperty("/runs/{runId}/document-confirmations/{receiptId}");
    expect(spec.paths).toHaveProperty("/runs/{runId}/document-confirmations/{receiptId}/confirm");
    const json = JSON.stringify(spec);
    expect(json).toContain("consultantNumber");
    expect(json).toContain("creditorIban");
    expect(json).toContain("selectionLimit");
    expect(json).toContain('"version"');
    expect(json).toContain('"warnings"');
    expect(json).toContain('"pastExecutionDate"');
  });

  test("rejects malformed public IDs and extra confirmation fields before database access", async () => {
    const app = createWorkflowDocumentConfirmationRoutes();
    expect((await app.request("/runs/not-a-short-id/document-confirmations/ABC123")).status).toBe(400);
    for (const json of [{ sha256: "wrong" }, { sha256: "a".repeat(64), actor: { kind: "system" } }, { sha256: "a".repeat(64), rows: [] }]) {
      const response = await app.request("/runs/ABC123/document-confirmations/DEF456/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(json),
      });
      expect(response.status).toBe(400);
    }
  });
});
