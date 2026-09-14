import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "assistant-queued-messages-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));

const { default: AssistantQueuedMessages } = await import("./AssistantQueuedMessages");

describe("Assistant queued messages", () => {
  test("renders queued text and editing without an accidental immediate send", () => {
    const html = renderToString(() =>
      createComponent(AssistantQueuedMessages, {
        messages: [{ id: "next", text: "Please check the next issue" }],
        onRetry: () => undefined,
        onEdit: () => undefined,
        onDelete: () => undefined,
      }),
    );

    expect(html).toContain('aria-label="Queued messages"');
    expect(html).toContain("Please check the next issue");
    expect(html).not.toContain("Send now");
    expect(html).toContain('aria-label="Queued message actions"');
    expect(html).not.toContain("opacity-0");
  });

  test("keeps a failed item available for retry", () => {
    const html = renderToString(() =>
      createComponent(AssistantQueuedMessages, {
        messages: [{ id: "failed", text: "Try this again", failed: true }],
        sendingId: "failed",
        onRetry: () => undefined,
        onEdit: () => undefined,
        onDelete: () => undefined,
      }),
    );

    expect(html).toContain('data-failed="true"');
    expect(html).toContain("ti ti-alert-circle");
    expect(html).toContain("Sending…");
  });
});
