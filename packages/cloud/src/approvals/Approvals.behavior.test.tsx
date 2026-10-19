import { describe, expect, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { ApprovalPage, PendingApproval } from "../contracts/approvals";

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const item = (id: string, overrides: Partial<PendingApproval> = {}): PendingApproval => ({
  id,
  app: { id: "mail", name: "Mail", icon: "ti ti-mail" },
  action: "draft.send",
  assurance: "confirm",
  sentence: `Mail: Send “Offer ${id.slice(-1)}”`,
  review: {
    message: "Sends the draft after the undo window.",
    details: [
      { label: "To", value: "customer@example.com" },
      { label: "Body", value: "Hello,\nthe offer is attached.", display: "block" },
    ],
    links: [{ rel: "edit", href: "/app/mail/box/compose/draft" }],
  },
  requester: { kind: "chat", appId: "assistant", title: "Offer Q4", href: "/app/assistant?conversation=chat1" },
  remember: { chat: false, always: false, website: false },
  createdAt: new Date(Date.now() - 6 * 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 23 * 60 * 60_000).toISOString(),
  ...overrides,
});

const page = (items: PendingApproval[], overrides: Partial<ApprovalPage> = {}): ApprovalPage => ({
  items,
  nextCursor: null,
  count: items.length,
  elsewhere: 0,
  ...overrides,
});

describe("Approvals", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const mount = async (
    props: { initial?: ApprovalPage; layout?: "list" | "band"; app?: string },
    answer: (url: string, init?: RequestInit) => Response,
  ) => {
    const dom = createDomTestHarness();
    const requests: { url: string; body: unknown }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        return answer(url, init);
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: Approvals } = await import("./Approvals");
    delegateEvents(["click"]);
    const dispose = render(() => <Approvals app={props.app ?? "assistant"} initial={props.initial} layout={props.layout} />, dom.root);
    return {
      dom,
      requests,
      button: (label: string, within: ParentNode = dom.root) =>
        Array.from(within.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === label),
      cleanup: () => {
        dispose();
        globalThis.fetch = originalFetch;
        dom.cleanup();
      },
    };
  };

  test("each request is the chat's question card; an answer collapses it to its outcome line and keeps the others", async () => {
    const view = await mount({ initial: page([item("a1"), item("a2")]) }, () => Response.json({ status: "approved" }));
    try {
      const rows = () => Array.from(view.dom.root.querySelectorAll<HTMLElement>("article.cloud-approval"));
      expect(rows()).toHaveLength(2);
      // An old review reads as its literal message, with every detail as a row and the app's sentence on the answer.
      expect(rows()[0]?.querySelector(".k2b-chat-decision__sentence")?.textContent).toBe("Sends the draft after the undo window.");
      expect(rows()[0]?.textContent).toContain("I'm asking because Mail always asks for this.");
      expect(rows()[0]?.textContent).toContain("customer@example.com");
      expect(rows()[0]?.textContent).not.toContain("Mail: Send");
      expect(rows()[0]?.querySelector("a")?.getAttribute("href")).toBe("/app/assistant?conversation=chat1");
      expect(rows()[0]?.textContent).not.toMatch(/Always approve|Immer freigeben/);
      expect(view.dom.root.textContent).toContain("2 open");
      // Answers arm after a short delay, so a click meant for the page cannot approve a row that just appeared.
      await Bun.sleep(550);
      view.button("Send “Offer 1”", rows()[0]!)!.click();
      await waitFor(() => rows()[0]?.dataset.decided === "approved", "the outcome");
      expect(view.requests.at(-1)).toEqual({ url: "/api/approvals/a1/decision", body: { approved: true } });
      expect(rows()).toHaveLength(2);
      expect(rows()[0]?.querySelector(".k2b-chat-decision__card")).toBeNull();
      expect(rows()[0]?.querySelector('.k2b-chat-outcome__text[data-current="true"]')?.textContent).toContain("Approved.");
      expect(rows()[0]?.querySelector(".k2b-chat-outcome")?.getAttribute("data-tone")).toBe("done");
      expect(view.button("Send “Offer 2”", rows()[1]!)).toBeDefined();
      expect(view.dom.root.textContent).toContain("1 open");
    } finally {
      view.cleanup();
    }
  });

  test("a request decided elsewhere or gone says so; another failure offers to answer again", async () => {
    const statuses = new Map([
      ["/api/approvals/a1/decision", 409],
      ["/api/approvals/a2/decision", 404],
      ["/api/approvals/a3/decision", 500],
      ["/api/approvals/a4/decision", 200],
    ]);
    const view = await mount({ initial: page([item("a1"), item("a2"), item("a3"), item("a4")]) }, (url) =>
      Response.json(statuses.get(url) === 200 ? { status: "rejected" } : { message: "no" }, { status: statuses.get(url) ?? 500 }),
    );
    try {
      const rows = () => Array.from(view.dom.root.querySelectorAll<HTMLElement>("article.cloud-approval"));
      const line = (row: HTMLElement | undefined) =>
        row?.querySelector('.k2b-chat-outcome__text[data-current="true"]')?.textContent?.trim() ?? "";
      const tone = (row: HTMLElement | undefined) => row?.querySelector(".k2b-chat-outcome")?.getAttribute("data-tone");
      await Bun.sleep(550);
      for (const row of rows()) view.button("Don't run", row)!.click();
      await waitFor(() => line(rows()[2]).includes("Your decision was not applied."), "the failure");
      await waitFor(() => rows()[3]?.dataset.decided === "rejected", "the rejection");
      // A 409 or 404 changed nothing: the line says so in a neutral tone, never the success check.
      expect(rows()[0]?.dataset.decided).toBe("elsewhere");
      expect(line(rows()[0])).toBe("Already decided elsewhere");
      expect(tone(rows()[0])).toBe("off");
      expect(rows()[1]?.dataset.decided).toBe("gone");
      expect(line(rows()[1])).toBe("Expired or withdrawn");
      expect(rows()[2]?.dataset.decided).toBeUndefined();
      expect(tone(rows()[2])).toBe("warning");
      expect(line(rows()[3])).toContain("Rejected: Send “Offer 4”");
      expect(line(rows()[3])).toContain("You declined.");
      // Answering again brings back the question, armed, in the same place.
      view.button("Answer again", rows()[2]!)!.click();
      await waitFor(() => rows()[2]?.querySelector(".k2b-chat-decision__card") !== null, "the question again");
      expect(view.button("Don't run", rows()[2]!)).toBeDefined();
    } finally {
      view.cleanup();
    }
  });

  test("a failed next page keeps the rows and offers a retry next to the button", async () => {
    let failNext = true;
    const view = await mount({ initial: page([item("a1")], { nextCursor: "next", count: 2 }) }, (url) => {
      if (!url.startsWith("/api/approvals?")) return Response.json({ message: "no" }, { status: 500 });
      if (failNext) return Response.json({ message: "unavailable" }, { status: 503 });
      // The browser parses fetched pages strictly, so this row needs a real request id.
      return Response.json(page([item("00000000-0000-4000-8000-0000000000a2")], { count: 2 }));
    });
    try {
      const rows = () => Array.from(view.dom.root.querySelectorAll<HTMLElement>("article.cloud-approval"));
      view.button("Show more")!.click();
      await waitFor(() => view.dom.root.querySelector('.cloud-approvals__more [role="alert"]') !== null, "the inline error");
      expect(view.dom.root.querySelector(".cloud-approvals__more")?.textContent).toContain("More approvals could not be loaded.");
      expect(rows()).toHaveLength(1);
      expect(view.button("Show more")).toBeUndefined();
      failNext = false;
      view.button("Try again")!.click();
      await waitFor(() => rows().length === 2, "the next page");
      expect(view.requests.filter((request) => request.url.startsWith("/api/approvals?"))).toHaveLength(2);
      expect(view.dom.root.querySelector('.cloud-approvals__more [role="alert"]')).toBeNull();
      expect(view.dom.root.querySelector(".cloud-approvals__more")).toBeNull();
    } finally {
      view.cleanup();
    }
  });

  test("offers the quiet chat link only where the request offers it, and never Always", async () => {
    const view = await mount(
      {
        initial: page([
          item("a1", { assurance: "standard", remember: { chat: true, always: true, website: false } }),
          item("a2", { remember: { chat: true, always: true, website: false } }),
        ]),
      },
      () => Response.json({ status: "approved" }),
    );
    try {
      const rows = Array.from(view.dom.root.querySelectorAll<HTMLElement>("article.cloud-approval"));
      expect(rows[0]?.querySelector(".k2b-chat-decision__remember")?.textContent?.trim()).toBe("Yes, and don't ask again in this chat");
      // `confirm` asks every time, whatever the stored options say.
      expect(rows[1]?.querySelector(".k2b-chat-decision__remember")).toBeNull();
      expect(view.dom.root.textContent).not.toMatch(/Always approve|Immer freigeben/);
      await Bun.sleep(550);
      (rows[0]!.querySelector(".k2b-chat-decision__remember") as HTMLButtonElement).click();
      await waitFor(() => view.requests.length > 0, "the decision");
      expect(view.requests.at(-1)).toEqual({ url: "/api/approvals/a1/decision", body: { approved: true, remember: "chat" } });
    } finally {
      view.cleanup();
    }
  });

  test("shows the empty state, and loads without a server page", async () => {
    const view = await mount({}, () => Response.json(page([], { elsewhere: 2 })));
    try {
      await waitFor(() => view.dom.root.textContent?.includes("Nothing is waiting for you.") === true, "the empty state");
      expect(view.requests[0]?.url).toBe("/api/approvals?app=assistant");
      expect(view.dom.root.textContent).toContain("More approvals in other apps (2)");
      expect(view.dom.root.querySelector('a[href="/me/approvals"]')).not.toBeNull();
    } finally {
      view.cleanup();
    }
  });

  test("a band shows nothing when nothing waits, and the request when one does", async () => {
    const empty = await mount({ initial: page([]), layout: "band", app: "mail" }, () => Response.json({}));
    try {
      expect(empty.dom.root.innerHTML).toBe("");
    } finally {
      empty.cleanup();
    }
    const band = await mount({ initial: page([item("a1")]), layout: "band", app: "mail" }, () => Response.json({ status: "rejected" }));
    try {
      const row = band.dom.root.querySelector<HTMLElement>("article.cloud-approval-band")!;
      expect(row.textContent).toContain("Send “Offer 1”");
      await Bun.sleep(550);
      band.button("Reject", row)!.click();
      await waitFor(() => row.dataset.decided === "rejected", "the band receipt");
      expect(row.textContent).toContain("Rejected");
      expect(row.querySelector(":scope > i")?.className).toBe("ti ti-circle-x");
    } finally {
      band.cleanup();
    }
  });
});
