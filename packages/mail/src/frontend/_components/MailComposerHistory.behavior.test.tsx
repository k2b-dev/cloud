import { afterEach, describe, expect, test } from "bun:test";
import type { DateContext } from "@k2b/stdlib";
import { createComponent, createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { MessageDetail, MessageSummary } from "../../service/messages";

const mailboxId = "Box001";
const conversationId = "Conv01";
const now = "2026-08-16T10:00:00.000Z";
const dateConfig: DateContext = { locale: "en", timeZone: "Europe/Berlin" };

const summary = (id: string, subject: string, internalDate: string): MessageSummary => ({
  id,
  subject,
  messageId: `<${id}@example.test>`,
  internalDate,
  sentAt: internalDate,
  from: [{ name: "Sender", address: "sender@example.test" }],
  to: [{ name: "Recipient", address: "recipient@example.test" }],
  flags: [],
  keywords: [],
  hydrationStatus: "complete",
  remoteAvailable: true,
  folderId: "Fold01",
});

const detail = (message: MessageSummary, dangerous: boolean): MessageDetail => ({
  ...message,
  contentType: "text/plain",
  sizeBytes: 128,
  replyTo: [],
  cc: [],
  plainText: dangerous ? "Review https://unsafe.example.test before opening." : "Safe earlier message.",
  sanitizedHtml: null,
  forwardText: "",
  selectedHeaders: {},
  sourceAvailable: true,
  mailingList: null,
  remoteContent: { imageIds: [], allowedByRule: false, sender: null, domain: null },
  security: dangerous
    ? {
        risk: "danger",
        verdict: "quarantined",
        findings: [{ code: "test", title: "Unsafe message", explanation: "Test finding" }],
        linksDisabled: true,
        evaluatedAt: now,
      }
    : undefined,
  delivery: null,
  attachments: [{ id: "Att001", filename: "invoice.pdf", contentType: "application/pdf", sizeBytes: 512, contentId: null }],
});

const settle = async () => {
  await Promise.resolve();
  await Bun.sleep(25);
};

describe("Mail composer history", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("loads summaries, pages, and protected message details only as they become visible", async () => {
    const dom = createDomTestHarness();
    const newest = summary("New001", "Newest subject", "2026-08-16T10:00:00.000Z");
    const older = summary("Old001", "Older subject", "2026-08-15T10:00:00.000Z");
    const oldest = summary("Anc001", "Oldest subject", "2026-08-14T10:00:00.000Z");
    const requests: string[] = [];
    let historyPage = 0;
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        requests.push(url);
        if (url.includes(`/conversations/${conversationId}/messages`)) {
          historyPage += 1;
          return Promise.resolve(
            Response.json(historyPage === 1 ? { items: [older, newest], nextCursor: "older" } : { items: [oldest], nextCursor: null }),
          );
        }
        if (url.includes("/messages/New001")) return Promise.resolve(Response.json(detail(newest, true)));
        if (url.includes("/messages/Old001")) return Promise.resolve(Response.json(detail(older, false)));
        return Promise.resolve(Response.json({ message: `Unexpected request: ${url}` }, { status: 500 }));
      },
      { preconnect: originalFetch.preconnect },
    );

    const [active, setActive] = createSignal(false);
    const { default: MailComposerHistory } = await import("./MailComposerHistory");
    const { render } = await import("solid-js/web");
    const dispose = render(
      () =>
        createComponent(MailComposerHistory, {
          mailboxId,
          conversationId,
          identities: [],
          dateConfig,
          active,
        }),
      dom.root,
    );

    try {
      await settle();
      expect(requests).toHaveLength(0);

      setActive(true);
      await settle();
      expect(requests.filter((url) => url.includes(`/conversations/${conversationId}/messages`))).toHaveLength(1);
      expect(requests.some((url) => url.includes("/activity"))).toBeFalse();
      expect(requests.some((url) => url.includes("/messages/New001"))).toBeTrue();
      expect(requests.some((url) => url.includes("/messages/Old001"))).toBeFalse();
      expect(dom.root.textContent).toContain("Newest subject");
      expect(dom.root.textContent).toContain("Older subject");
      expect(dom.root.textContent).toContain("12:00 16 Aug 2026");
      expect(dom.root.textContent).toContain("12:00 15 Aug 2026");
      expect(dom.root.textContent).toContain("https://unsafe.example.test");
      expect(dom.root.querySelector('a[href="https://unsafe.example.test"]')).toBeNull();
      expect(dom.root.querySelector("[class~='border-t']")).toBeNull();
      expect(dom.root.textContent).not.toContain("invoice.pdf");

      const newestButton = Array.from(dom.root.querySelectorAll("button")).find((button) => button.textContent?.includes("Newest subject"));
      const olderButton = Array.from(dom.root.querySelectorAll("button")).find((button) => button.textContent?.includes("Older subject"));
      expect(newestButton?.className).toContain("rounded-[var(--ui-radius-surface)]");
      expect(newestButton?.className).toContain("bg-[var(--ui-surface-subtle)]");
      expect(newestButton?.className).toContain("hover:bg-[var(--ui-hover)]");
      expect(newestButton?.closest("article")?.parentElement?.className).toContain("gap-2");
      expect(newestButton?.getAttribute("aria-expanded")).toBe("true");
      expect(olderButton).toBeDefined();
      olderButton!.click();
      await settle();
      expect(requests.some((url) => url.includes("/messages/Old001"))).toBeTrue();
      expect(dom.root.textContent).toContain("invoice.pdf");
      expect(dom.root.textContent).toContain("https://unsafe.example.test");
      expect(newestButton?.getAttribute("aria-expanded")).toBe("true");
      expect(olderButton!.getAttribute("aria-expanded")).toBe("true");

      newestButton!.click();
      await settle();
      expect(newestButton?.getAttribute("aria-expanded")).toBe("false");
      expect(olderButton!.getAttribute("aria-expanded")).toBe("true");

      const loadEarlier = Array.from(dom.root.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Load earlier messages"),
      );
      expect(loadEarlier).toBeDefined();
      loadEarlier!.click();
      await settle();
      expect(requests.filter((url) => url.includes(`/conversations/${conversationId}/messages`))).toHaveLength(2);
      expect(dom.root.textContent).toContain("Oldest subject");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});
