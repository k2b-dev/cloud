import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "mail-summary-card-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MailConversationSummaryCard } = await import("./MailConversationSummaryCard.tsx");

describe("MailConversationSummaryCard", () => {
  test("renders a prominent shared summary surface with direct edit access", () => {
    const html = renderToString(() =>
      createComponent(MailConversationSummaryCard, {
        summary: "**Decision:** Ship on Friday.\n\n- Confirm support coverage\n- Publish the notes",
        canEdit: true,
        onEdit: () => undefined,
      }),
    );

    expect(html).toContain('class="k2b-paper');
    expect(html).not.toContain('data-elevated="true"');
    expect(html).toContain("Conversation summary");
    expect(html).toContain("app-accent-text");
    expect(html).not.toContain("text-[var(--app-accent)]");
    expect(html).not.toContain("bg-[var(--app-accent)]");
    expect(html).toContain('aria-label="Edit summary"');
    expect(html).not.toContain("Show more");
    expect(html).not.toContain("line-clamp");
    expect(html).not.toContain("ti-notes");
    expect(html).toContain("k2b-content-markdown");
    expect(html).toContain("<strong>Decision:</strong>");
    expect(html).toContain("<li>Confirm support coverage</li>");
  });

  test("hides edit access for read-only users", () => {
    const html = renderToString(() =>
      createComponent(MailConversationSummaryCard, {
        summary: "Current shared context",
        canEdit: false,
        onEdit: () => undefined,
      }),
    );

    expect(html).not.toContain('aria-label="Edit summary"');
    expect(html).not.toContain("ti-notes");
  });
});
