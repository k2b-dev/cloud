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

describe("Related mail rows in the Linked section", () => {
  test("an empty result adds no row, so the section's other links and count speak for it", () => {
    expect(renderView()).toBe("");
  });

  test("loading and a failed load each stay on one quiet line, the failure with a retry", () => {
    const loading = renderView({ loading: true });
    expect(loading).toContain("Finding related mail...");
    expect(loading).toContain('data-variant="inline"');
    const error = renderView({ error: "Mailbox unavailable", unavailableText: "Related mail can't load right now." });
    expect(error).toContain("Related mail can't load right now.");
    expect(error).toContain('data-state="error"');
    expect(error).toContain('data-align="left"');
    expect(error).toContain("Try again");
    expect(renderView({ error: "Mailbox unavailable" })).toContain("Mailbox unavailable");
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
