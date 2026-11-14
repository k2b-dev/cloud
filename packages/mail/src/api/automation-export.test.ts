import { expect, test } from "bun:test";
import { Hono } from "hono";
import { generateSpecs } from "hono-openapi";
import { mailAutomationExportQuerySchema } from "../automation-export-contracts";
import routes from "./automation-export";

test("publishes both definition exports as read-only API operations", async () => {
  const spec = await generateSpecs(new Hono().route("/", routes));
  for (const path of ["/mailboxes/{mailboxId}/automation-export", "/admin/automation-export"]) {
    expect(spec.paths?.[path]?.get?.responses?.["200"]).toBeDefined();
    expect(spec.paths?.[path]?.post).toBeUndefined();
  }
});
test("bounds export pages and rejects invalid cursors", () => {
  expect(mailAutomationExportQuerySchema.parse({})).toEqual({ limit: 1 });
  for (const input of [{ limit: 0 }, { limit: 2 }, { after: "not-a-cursor" }, { userId: "other" }])
    expect(mailAutomationExportQuerySchema.safeParse(input).success).toBe(false);
});
