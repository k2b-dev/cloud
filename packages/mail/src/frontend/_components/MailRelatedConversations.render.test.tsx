import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "mail-related-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { MailRelatedConversationsView } = await import("./MailRelatedConversations.tsx");
const dateConfig = { locale: "en", timeZone: "Europe/Berlin" };

const renderView = (overrides: Partial<Parameters<typeof MailRelatedConversationsView>[0]> = {}) =>
  renderToString(() =>
    createComponent(MailRelatedConversationsView, {
      mailboxId: "Box001",
      items: [],
      loading: false,
      error: null,
      dateConfig,
      onRetry: () => {},
      ...overrides,
    }),
  );

describe("Related mail detail section", () => {
  test("renders a compact accessible empty state", () => {
    const html = renderView();
    expect(html).toContain("Related mail");
    expect(html).toContain("No related mail");
    expect(html).toContain('data-state="empty"');
    expect(html).toContain('data-align="center"');
  });

  test("renders loading and retryable error states", () => {
    const loading = renderView({ loading: true });
    expect(loading).toContain("Finding related mail...");
    expect(loading).toContain('data-align="center"');
    const error = renderView({ error: "Mailbox unavailable" });
    expect(error).toContain("Related mail unavailable");
    expect(error).toContain("Mailbox unavailable");
    expect(error).toContain('data-align="center"');
    expect(error).toContain('class="k2b-button__label">Retry</span>');
  });

  test("links results and explains why each conversation is related", () => {
    const html = renderView({
      items: [
        {
          id: "Rel123",
          subject: "Re: Project Alpha",
          participantSummary: "Ada",
          latestMessageAt: "2026-08-18T12:00:00.000Z",
          preview: "Earlier context",
          reasons: [
            { kind: "participant", value: "ada@example.test" },
            { kind: "subject", value: "Project Alpha" },
          ],
        },
      ],
    });
    expect(html).toContain('href="/app/mail/Box001?conversation=Rel123"');
    expect(html).toContain("Also with ada@example.test · Same subject");
    expect(html).toContain("Re: Project Alpha");
  });
});
