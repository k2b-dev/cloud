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
      theme: "light",
      colors: "adapted",
      mailboxId: "Box001",
      messageId: "Msg001",
      format: "plain",
      html: null,
      plainText: "Reference: https://example.com/security.",
      attachments: [],
      remoteContent: { imageIds: [], allowedByRule: false, allowRules: [], sender: "sender@example.com", domain: "example.com" },
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
          theme: "light",
          colors: "adapted",
          mailboxId: "Box001",
          messageId: "Msg001",
          format: "html",
          html: '<p>Neuer Inhalt</p><blockquote type="cite">Alter Inhalt</blockquote>',
          plainText: null,
          attachments: [],
          remoteContent: { imageIds: [], allowedByRule: false, allowRules: [], sender: "sender@example.com", domain: "example.com" },
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

const renderPlainBody = (plainText: string) =>
  renderToString(() =>
    createComponent(MailMessageBody, {
      theme: "light",
      colors: "adapted",
      mailboxId: "Box001",
      messageId: "Msg001",
      format: "plain",
      html: null,
      plainText,
      attachments: [],
      remoteContent: { imageIds: [], allowedByRule: false, allowRules: [], sender: null, domain: null },
      onSelectionChange: () => {},
    }),
  );

describe("plain mail message quoted history", () => {
  test("puts only the trailing earlier conversation behind the toggle", () => {
    const html = renderPlainBody("Sounds good.\n\nOn Monday, Alex Example wrote:\n> Lunch on Friday?");
    const collapsed = /<details[\s\S]*<\/details>/.exec(html)?.[0] ?? "";

    expect(collapsed).toContain("Show quoted text");
    expect(collapsed).toContain("> Lunch on Friday?");
    expect(collapsed).not.toContain("Sounds good.");
    expect(html.indexOf("On Monday, Alex Example wrote:")).toBeLessThan(html.indexOf("<details"));
  });

  test("shows inline answers and their quotes without a toggle", () => {
    const html = renderPlainBody("> Can you send the plan?\nYes, attached.\n\n> And the budget?\nNext week.");

    expect(html).not.toContain("<details");
    expect(html).toContain("> And the budget?");
  });
});

describe("HTML mail message locale", () => {
  test("uses the resolved document language and localized quote label", () => {
    const html = renderLocalizedHtmlBody("de-CH");

    expect(html).toContain("lang=&quot;de&quot;");
    expect(html).toContain("Zitierten Text anzeigen");
    expect(html).toContain("Zitierten Text ausblenden");
    expect(html).not.toContain("Show quoted text");
  });
});

describe("external images", () => {
  const image = "00000000-0000-4000-8000-000000000001";
  const renderRemote = (remoteContent: Record<string, unknown>) =>
    renderToString(() =>
      createComponent(MailMessageBody, {
        theme: "light",
        colors: "adapted",
        mailboxId: "Box001",
        messageId: "Msg001",
        format: "html",
        html: `<p>Newsletter</p><img alt="Banner" data-mail-remote-image="${image}">`,
        plainText: null,
        attachments: [],
        remoteContent: {
          imageIds: [image],
          allowedByRule: false,
          allowRules: [],
          sender: "news@shop.example",
          domain: "shop.example",
          ...remoteContent,
        },
        onSelectionChange: () => {},
      }),
    );

  test("a blocked message opens with one named row: image tile, short reason, and Load images with its menu", () => {
    const html = renderRemote({});
    expect(html).toContain('<section aria-label="External images"');
    expect(html).toContain('data-remote-images="blocked"');
    expect(html).toContain("data-row");
    expect(html).toContain('class="k2b-notice-card__tile k2b-icon-tile"');
    expect(html).toContain("External images blocked");
    expect(html).toContain("Load images");
    expect(html).toContain('aria-label="More options for external images"');
    // The server already knows the rule, so the first render never flashes the blocked row.
    expect(html.indexOf("External images blocked")).toBeLessThan(html.indexOf("<iframe"));
  });

  test("several senders get a plain Load images without the menu arrow", () => {
    const html = renderRemote({ sender: null, domain: null });
    expect(html).toContain("Load images");
    expect(html).not.toContain("More options for external images");
    expect(html).not.toContain("k2b-split-button");
  });

  test("an allowed sender shows the quiet line and its rule from the first render", () => {
    const html = renderRemote({
      allowedByRule: true,
      allowRules: [{ id: "00000000-0000-4000-8000-0000000000aa", scope: "sender", value: "news@shop.example" }],
    });
    expect(html).toContain('data-remote-images="always"');
    expect(html).not.toContain("External images blocked");
    expect(html).toContain("news@shop.example</b>");
    expect(html).toContain("Change");
  });

  test("German copy follows the mockup", () => {
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(MailMessageBody, {
            theme: "light",
            colors: "adapted",
            mailboxId: "Box001",
            messageId: "Msg001",
            format: "html",
            html: `<img alt="Banner" data-mail-remote-image="${image}">`,
            plainText: null,
            attachments: [],
            remoteContent: { imageIds: [image], allowedByRule: false, allowRules: [], sender: "news@shop.example", domain: "shop.example" },
            onSelectionChange: () => {},
          });
        },
      }),
    );
    expect(html).toContain('aria-label="Externe Bilder"');
    expect(html).toContain("Externe Bilder blockiert");
    expect(html).toContain("Schutz vor Tracking beim Öffnen");
    expect(html).toContain("Bilder laden");
    expect(html).toContain('aria-label="Weitere Optionen für externe Bilder"');
  });
});

describe("HTML mail message frame", () => {
  test("lets links open as normal tabs while the message itself stays sandboxed", () => {
    const html = renderToString(() =>
      createComponent(MailMessageBody, {
        theme: "light",
        colors: "adapted",
        mailboxId: "Box001",
        messageId: "Msg001",
        format: "html",
        html: '<p><a href="https://example.com/login" target="_blank" rel="noopener noreferrer nofollow">Sign in</a></p>',
        plainText: null,
        attachments: [],
        remoteContent: { imageIds: [], allowedByRule: false, allowRules: [], sender: "sender@example.com", domain: "example.com" },
        onSelectionChange: () => {},
      }),
    );

    const sandbox = /<iframe[^>]*\ssandbox="([^"]*)"/.exec(html)?.[1]?.split(" ") ?? [];
    // A tab opened from the frame would inherit its sandbox, and Safari then blocks sites that send
    // Cross-Origin-Opener-Policy. Escaping applies only to the new tab, not to the message.
    expect(sandbox).toEqual(["allow-scripts", "allow-popups", "allow-popups-to-escape-sandbox"]);
    expect(sandbox).not.toContain("allow-same-origin");
    expect(sandbox).not.toContain("allow-top-navigation");
  });
});

test("does not render a whitespace-only plain alternative", () => {
  const html = renderToString(() =>
    createComponent(MailMessageBody, {
      theme: "dark",
      colors: "adapted",
      mailboxId: "Box001",
      messageId: "Msg001",
      format: "plain",
      html: null,
      plainText: "\n ",
      attachments: [],
      remoteContent: { imageIds: [], allowedByRule: false, allowRules: [], sender: null, domain: null },
      onSelectionChange: () => {},
    }),
  );
  expect(html).not.toContain("<pre");
});
