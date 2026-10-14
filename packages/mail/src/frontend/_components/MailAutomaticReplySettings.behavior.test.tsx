import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";
import { type AutomaticReplyPreview, automaticReplyPreviewInputSchema, type SenderIdentity } from "../../contracts";
import type { AutomaticReplyConfiguration } from "../../service/automatic-reply-configuration";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    const [{ default: MailAutomaticReplySettings }, { dialogCore, LocaleProvider }] = await Promise.all([
      import("./MailAutomaticReplySettings"),
      import("@k2b/ui"),
    ]);
    return { MailAutomaticReplySettings, dialogCore, LocaleProvider };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

const now = "2026-10-11T10:00:00.000Z";
const identity: SenderIdentity = {
  id: "Send01",
  mailboxId: "Box001",
  label: "Support",
  displayName: "Support",
  fromAddress: "support@example.test",
  replyTo: null,
  defaultCc: [],
  defaultBcc: [],
  defaultFormat: "markdown",
  defaultPriority: "normal",
  defaultDeliveryReceipt: false,
  defaultReadReceipt: false,
  vcard: null,
  envelopeSender: null,
  defaultSignatureTemplateId: null,
  transport: {
    mode: "mailbox",
    host: null,
    port: null,
    tlsMode: null,
    username: null,
    secret: { kind: null, isSet: false },
    revision: 0,
    status: "active",
    capabilities: { dsn: false, size: false, maxMessageBytes: null },
    lastVerifiedAt: null,
    lastError: null,
  },
  authenticationPolicy: { automation: "mailbox" },
  sentFolderId: null,
  draftsFolderId: null,
  isDefault: true,
  status: "verified",
  statusReason: null,
  pendingVerificationCommandId: null,
  createdAt: now,
  updatedAt: now,
};
const configuration: AutomaticReplyConfiguration = {
  id: "Reply1",
  mailboxId: "Box001",
  workflowId: "Flow01",
  name: "Out of office",
  enabled: true,
  senderIdentityId: identity.id,
  subject: "Re: {{ inputs.message.subject }}",
  body: "<small>fine print</small>",
  format: "markdown",
  ensureReference: false,
  minimumIntervalHours: 24,
  inactiveBehavior: "skip",
  schedule: { mode: "always" },
  revision: 1,
  createdAt: now,
  updatedAt: now,
};
const preview: AutomaticReplyPreview = {
  subject: "Re: Example customer request",
  html: "<p>fine print</p>",
  text: "fine print",
  formattingWarnings: [
    { code: "ignored_mailbox_css", property: "font-family" },
    { code: "unsupported_element", element: "small" },
  ],
};
const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 150 && !condition(); attempt++) await Bun.sleep(10);
  expect(condition()).toBe(true);
};

const translations = {
  en: {
    edit: "Edit Out of office",
    tab: "Preview",
    title: "Email leaves out some formatting of this message.",
    lines: [
      "The mailbox email design sets font-family to a value email no longer accepts. Mail ignores it.",
      "<small> is not supported and was removed. Its text stays.",
    ],
  },
  de: {
    edit: "Out of office bearbeiten",
    tab: "Vorschau",
    title: "Ein Teil der Formatierung dieser Nachricht wird in der E-Mail weggelassen.",
    lines: [
      "Das E-Mail-Design des Postfachs setzt font-family auf einen Wert, den E-Mails nicht mehr zulassen. Mail ignoriert ihn.",
      "<small> wird nicht unterstützt und wurde entfernt. Der Text bleibt erhalten.",
    ],
  },
};

describe("Mail automatic reply preview formatting warnings", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  const { MailAutomaticReplySettings, dialogCore, LocaleProvider } = modules!;
  const originalFetch = globalThis.fetch;
  let dom: DomTestHarness;
  let dispose = () => {};
  let response: AutomaticReplyPreview;

  beforeEach(() => {
    dom = createDomTestHarness();
    delegateEvents(["click"]);
    response = preview;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        const path = new URL(request.url).pathname;
        if (request.method !== "POST" || path !== "/api/mail/mailboxes/Box001/automatic-replies/preview") {
          throw new Error(`Unexpected request: ${request.method} ${path}`);
        }
        expect(automaticReplyPreviewInputSchema.parse(await request.json())).toMatchObject({
          senderIdentityId: identity.id,
          body: configuration.body,
          format: "markdown",
        });
        return Response.json(response);
      },
      { preconnect: originalFetch.preconnect },
    );
  });
  afterEach(async () => {
    dialogCore.close();
    await Bun.sleep(20);
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  });

  const openPreview = async (locale: "en" | "de") => {
    // Dialogs render in their own Solid root and inherit the page locale from the document.
    dom.document.documentElement.lang = locale;
    dispose = render(
      () => (
        <LocaleProvider locale={locale}>
          <MailAutomaticReplySettings mailboxId="Box001" identities={[identity]} initialConfigurations={[configuration]} />
        </LocaleProvider>
      ),
      dom.root,
    );
    const edit = dom.root.querySelector<HTMLButtonElement>(`button[aria-label="${translations[locale].edit}"]`);
    expect(edit).not.toBeNull();
    edit!.click();
    await waitFor(() => Boolean(dom.document.querySelector('[role="tab"]')));
    const tab = Array.from(dom.document.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (button) => button.textContent?.trim() === translations[locale].tab,
    );
    expect(tab).toBeDefined();
    tab!.click();
    await waitFor(() => Boolean(dom.document.querySelector("iframe")));
    return dom.document.querySelector("iframe")!;
  };

  for (const locale of ["en", "de"] as const) {
    test(`shows ${locale} warning title and lines below the preview iframe`, async () => {
      const iframe = await openPreview(locale);
      expect(iframe.getAttribute("srcdoc")).toBe(preview.html);
      const container = iframe.parentElement!;
      const title = Array.from(container.querySelectorAll("p")).find((paragraph) => paragraph.textContent === translations[locale].title);
      expect(title).toBeDefined();
      expect(iframe.compareDocumentPosition(title!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
      const lines = Array.from(container.querySelectorAll("li"));
      expect(lines.map((line) => line.textContent)).toEqual(translations[locale].lines);
      for (const line of lines) expect(iframe.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    });

    test(`shows no ${locale} formatting hint for an empty warning list`, async () => {
      response = { ...preview, formattingWarnings: [] };
      const iframe = await openPreview(locale);
      expect(iframe.getAttribute("srcdoc")).toBe(preview.html);
      expect(iframe.parentElement!.textContent).not.toContain(translations[locale].title);
      expect(iframe.parentElement!.querySelector("ul")).toBeNull();
    });
  }
});
