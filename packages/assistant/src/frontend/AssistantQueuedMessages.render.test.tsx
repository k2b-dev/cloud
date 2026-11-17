import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(resolve(tmpdir(), "assistant-queued-messages-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

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

  test("makes a pending infrastructure failure visible and keeps removal available", () => {
    const html = renderToString(() =>
      createComponent(AssistantQueuedMessages, {
        messages: [{ id: "pending", text: "Still waiting", failed: true, error: "dispatch_failed", retrying: true }],
        onRetry: () => undefined,
        onDelete: () => undefined,
      }),
    );
    expect(html).toContain("Could not start. Retrying shortly.");
    expect(html).toContain('aria-label="Queued message actions"');
    expect(html).not.toContain(">Retry<");
  });

  test("makes an expired infrastructure failure visible without claiming another automatic attempt", () => {
    const html = renderToString(() =>
      createComponent(AssistantQueuedMessages, {
        messages: [{ id: "failed", text: "Still waiting", failed: true, error: "dispatch_failed", retrying: false }],
        onRetry: () => undefined,
        onDelete: () => undefined,
      }),
    );
    expect(html).toContain("Could not start. Please retry or remove.");
    expect(html).not.toContain("Retrying shortly");
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
