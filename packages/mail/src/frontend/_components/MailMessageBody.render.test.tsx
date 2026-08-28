import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "mail-message-body-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const [{ default: MailMessageBody }, { LocaleProvider }] = await Promise.all([import("./MailMessageBody.tsx"), import("@k2b/ui")]);

const renderBody = (linksDisabled = false) =>
  renderToString(() =>
    createComponent(MailMessageBody, {
      mailboxId: "Box001",
      messageId: "Msg001",
      format: "plain",
      html: null,
      plainText: "Reference: https://example.com/security.",
      attachments: [],
      remoteContent: { imageIds: [], allowedByRule: false, sender: "sender@example.com", domain: "example.com" },
      linksDisabled,
      onSelectionChange: () => {},
    }),
  );

const renderLocalizedHtmlBody = (locale: string) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(MailMessageBody, {
          mailboxId: "Box001",
          messageId: "Msg001",
          format: "html",
          html: '<p>Neuer Inhalt</p><blockquote type="cite">Alter Inhalt</blockquote>',
          plainText: null,
          attachments: [],
          remoteContent: { imageIds: [], allowedByRule: false, sender: "sender@example.com", domain: "example.com" },
          onSelectionChange: () => {},
        });
      },
    }),
  );

describe("plain mail message links", () => {
  test("opens recognized web URLs safely in a new tab", () => {
    const html = renderBody();

    expect(html).toContain('href="https://example.com/security"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain("text-current");
    expect(html).toContain("no-underline hover:underline focus-visible:underline");
    expect(html).not.toContain("decoration-dotted");
    expect(html).not.toContain("hover:text-");
    expect(html).toContain("https://example.com/security</a>.");
  });

  test("keeps recognized URLs inert when message links are disabled", () => {
    const html = renderBody(true);

    expect(html).toContain("Reference: ");
    expect(html).toContain("https://example.com/security");
    expect(html).not.toContain("<a");
  });
});

describe("HTML mail message locale", () => {
  test("uses the resolved document language and localized quote label", () => {
    const html = renderLocalizedHtmlBody("de-CH");

    expect(html).toContain("lang=&quot;de&quot;");
    expect(html).toContain("Zitierten Text anzeigen");
    expect(html).not.toContain("Show quoted text");
  });
});
