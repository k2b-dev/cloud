import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { DraftFolderPage } from "../../contracts";

const root = mkdtempSync(join(tmpdir(), "mail-drafts-view-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MailDraftsView } = await import("./MailDraftsView.tsx");

const render = (page: DraftFolderPage) =>
  renderToString(() =>
    createComponent(MailDraftsView, {
      mailboxId: "Box001",
      title: "Drafts",
      returnHref: "/app/mail/Box001?folder=Fld001&cursor=old",
      page,
      error: null,
      dateConfig: { timeZone: "UTC", locale: "en" },
      loading: false,
      onNavigate: () => undefined,
    }),
  );

describe("MailDraftsView", () => {
  test("lists each draft as a link that opens it in the composer and returns to the Drafts folder", () => {
    const html = render({
      items: [
        {
          id: "Drf001",
          conversationId: null,
          intent: "new",
          subject: "Quarterly figures",
          to: [{ name: "Ada Example", address: "ada@example.test" }],
          cc: [{ name: null, address: "team@example.test" }],
          bcc: [],
          bodyPreview: "Here are the numbers.",
          createdByDisplayName: "Mail provider",
          updatedAt: "2026-10-01T09:00:00.000Z",
        },
      ],
      nextCursor: "next",
      total: 3,
    });
    expect(html).toContain("3 drafts");
    expect(html).toContain('href="/app/mail/Box001/compose/Drf001?return=%2Fapp%2Fmail%2FBox001%3Ffolder%3DFld001"');
    expect(html).toContain("Quarterly figures");
    expect(html).toContain("Ada Example and 1 more");
    expect(html).toContain("Here are the numbers.");
    expect(html).toContain("Started by Mail provider");
    expect(html).toContain('href="/app/mail/Box001?folder=Fld001&amp;cursor=next"');
  });

  test("explains an empty Drafts folder", () => {
    const html = render({ items: [], nextCursor: null, total: 0 });
    expect(html).toContain("No drafts");
    expect(html).toContain("0 drafts");
  });
});
