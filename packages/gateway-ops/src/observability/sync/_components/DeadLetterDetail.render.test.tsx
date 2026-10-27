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
  // K1 outline: kind line with state, properties, the error, then payload and identifiers under "More about this message".
  const kind = html.slice(html.indexOf('class="k2b-detail-panel__kind"'), html.indexOf("<h2>"));
  expect(kind).toContain("Dead letter");
  expect(kind).toContain("Failed");
  expect(html).toContain("<h2>handler_error</h2>");
  expect(html).not.toContain("k2b-detail-panel__section-icon");
  const properties = html.indexOf(">Properties<");
  const error = html.indexOf("full error message");
  const more = html.indexOf("More about this message");
  expect(properties).toBeGreaterThan(-1);
  expect(properties).toBeLessThan(error);
  expect(error).toBeLessThan(more);
  expect(html.slice(more)).toContain("Payload preview");
  expect(html.slice(more)).toContain("message-full-id");
});
