import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { CapabilityExecution } from "@k2b/cloud/capabilities/store";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "capability-detail-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: Detail } = await import("./ExecutionDetail");

const execution: CapabilityExecution = {
  id: "6c0f7b6e-6f5e-4a44-8f0f-2f1d0a4b7c11",
  requestId: "req-full-correlation-id",
  origin: "assistant",
  appId: "contacts",
  capability: "contacts.delete",
  kind: "action",
  destructive: true,
  actorKind: "user",
  actorId: "actor-full-id",
  userId: "5de41b38-a3ac-47f3-b47c-da6472afbb42",
  accessSubjectType: "service_account",
  accessSubjectId: "subject-full-id",
  status: "failed",
  errorCode: "CAPABILITY_FAILED",
  inputMeta: { type: "object", keys: ["contactId", "<script>"], omittedKeys: 4 },
  outputMeta: { type: "array", length: 3 },
  idempotencyKey: "idem-full-key",
  startedAt: "2026-09-08T12:00:00.000Z",
  completedAt: "2026-09-08T12:00:07.000Z",
  durationMs: 7000,
};

test("execution detail shows correlation, shape and the user's AI usage without leaking payloads", () => {
  const html = renderToString(() =>
    createComponent(Detail, {
      executions: [execution],
      closeHref: "/admin/observability/capabilities?app=contacts",
    }),
  );

  for (const value of [
    "req-full-correlation-id",
    "actor-full-id",
    "subject-full-id",
    "CAPABILITY_FAILED",
    "idem-full-key",
    "contacts.delete",
    "k2b-detail-panel",
  ])
    expect(html).toContain(value);
  // Shape metadata renders as size and key names only.
  expect(html).toContain("contactId");
  expect(html).toContain("+4 more");
  expect(html).toContain("3 items");
  expect(html).toContain("&lt;script");
  expect(html).not.toContain("<script>");
  expect(html).toContain("/admin/settings?tab=ai-usage");
  expect(html).toContain("5de41b38-a3ac-47f3-b47c-da6472afbb42");
  expect(html).toContain("/admin/observability/capabilities?app=contacts");
});
