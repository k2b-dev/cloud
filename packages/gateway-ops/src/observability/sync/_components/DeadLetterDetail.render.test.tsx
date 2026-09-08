import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
const root = mkdtempSync(resolve(tmpdir(), "sync-detail-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: Detail } = await import("./DeadLetterDetail");
test("dead-letter detail renders complete identifiers and escaped, selectable bounded preview", () => {
  const html = renderToString(() =>
    createComponent(Detail, {
      closeHref: "/admin/observability/sync?app=mail",
      entry: {
        messageId: "message-full-id",
        tenantId: "tenant-full-id",
        attempts: 5,
        failedAt: "2026-09-08T12:00:00Z",
        reason: "handler_error",
        error: "full error message",
        consumer: "original-consumer",
        eventId: "original-event",
        dataPreview: '<script>alert("payload")</script>',
      },
    }),
  );
  for (const value of [
    "message-full-id",
    "tenant-full-id",
    "full error message",
    "original-consumer",
    "original-event",
    "k2b-detail-panel",
    "select-all",
  ])
    expect(html).toContain(value);
  expect(html).toContain("&lt;script");
  expect(html).not.toContain('<script>alert("payload")</script>');
  expect(html).toContain("/admin/observability/sync?app=mail");
});
