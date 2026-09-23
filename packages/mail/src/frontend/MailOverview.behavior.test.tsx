import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../contact-directory-settings";

test.skipIf(isServer)("deleted mailboxes load on disclosure, retry failures, and paginate", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let fail = true;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (!url.includes("/mailboxes/deleted")) throw new Error(`Unexpected request: ${url}`);
      if (fail) return Response.json({ message: "Temporarily unavailable" }, { status: 503 });
      return Response.json({ items: [], nextCursor: url.includes("cursor=") ? null : "next" });
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
    const element = Array.from(dom.root.querySelectorAll("button")).find((item) => item.textContent?.trim() === text);
    expect(element).toBeDefined();
    return element!;
  };
  try {
    await settle();
    expect(requests).toHaveLength(0);
    button("Recently deleted mailboxes").click();
    await settle();
    expect(requests).toHaveLength(1);
    expect(dom.root.textContent).toContain("Temporarily unavailable");
    fail = false;
    button("Retry").click();
    await settle();
    expect(requests).toHaveLength(2);
    button("Load more").click();
    await settle();
    expect(requests[2]).toContain("cursor=next");
    expect(dom.root.textContent).toContain("No deleted mailboxes");
    button("Recently deleted mailboxes").click();
    await settle();
    expect(dom.root.querySelector("#mail-deleted-mailboxes")).toBeNull();
    expect(requests).toHaveLength(3);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
