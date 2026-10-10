import { expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../contact-directory-settings";

// A tab opened before a release asks for a health dialog chunk that the release removed.
mock.module("./_components/MailboxHealthDialog", () => {
  throw new TypeError("Failed to fetch dynamically imported module: /_ssr/1/chunk-old.js");
});

const deleted = { id: "Box002", name: "Archive", deletedAt: "2026-10-01T10:00:00.000Z", permission: "admin" };

test.skipIf(isServer)("a restored mailbox still opens when its health dialog cannot load", async () => {
  const dom = createDomTestHarness();
  dom.window.happyDOM.setURL("http://localhost/app/mail");
  const assigned: string[] = [];
  Object.assign(dom.window.location, { assign: (href: string) => void assigned.push(href) });
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname.endsWith("/mailboxes/deleted"))
        return Response.json({ items: requests.length > 1 ? [] : [deleted], nextCursor: null });
      if (url.pathname.endsWith("/Box002/restore")) return Response.json({ ...deleted, deletedAt: undefined, permission: undefined });
      throw new Error(`Unexpected request: ${url.pathname}`);
    },
    { preconnect: originalFetch.preconnect },
  );
  const { default: MailOverview } = await import("./MailOverview.island");
  const dispose = render(
    () =>
      createComponent(MailOverview, {
        mailboxes: [],
        initialView: "mine",
        initialSelection: null,
        initialDetail: null,
        initialPinnedMailboxIds: [],
        initialHiddenMailboxIds: [],
        currentUserEmail: null,
        contactDirectory: DEFAULT_MAIL_CONTACT_DIRECTORY,
        dateConfig: { locale: "en", timeZone: "UTC" },
        initialFocusError: null,
        initialFocus: { items: [], counts: { mine: 0, unassigned: 0, waiting: 0, all: 0 }, mailboxCounts: [], nextCursor: null },
      }),
    dom.root,
  );
  const settle = () => Bun.sleep(30);
  const button = (text: string) => {
    const element = Array.from(dom.document.querySelectorAll("button")).find((item) => item.textContent?.trim() === text);
    expect(element).toBeDefined();
    return element!;
  };
  try {
    button("Recently deleted mailboxes").click();
    await settle();
    button("Restore Archive").click();
    await settle();
    button("Restore mailbox").click();
    for (let attempt = 0; attempt < 100 && assigned.length === 0; attempt += 1) await Bun.sleep(5);
    expect(requests).toContain("POST /api/mail/mailboxes/Box002/restore");
    expect(assigned).toEqual(["/app/mail/Box002"]);
    expect(dom.document.querySelector("[data-k2b-toast]")?.textContent).toContain("Mailbox restored in paused state");
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
